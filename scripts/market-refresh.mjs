#!/usr/bin/env node
/**
 * 市场清单的每日刷新：批量拉取各插件的 star 数与作者，回写 plugins/market.json。
 *
 * 由 `.github/workflows/market-refresh.yml` 每日调度（也可手动触发），以及
 * 「改动了 plugins/market.json 的推送」触发——新上架的插件当次推送就能拿到
 * star，不用等第二天。
 *
 * ## 为什么在 CI 批量做，而不是客户端逐个查
 *
 * 未认证的 GitHub API 限额是 **60 次/小时，且按 IP 由所有用户共享**——客户端
 * 逐仓查询在市场里有几十个插件时必然撞死（几个人同时打开面板就烧完）。认证后
 * 限额提升到千级，再配合 **GraphQL 一次查询带 100 个仓库别名**，100 个插件
 * 只需 1 次请求。客户端从此零 GitHub API 调用。
 *
 * ## 设计取舍
 *
 *  - **单条仓库查询失败不回滚整批**：仓库被删 / 改名时 GraphQL 返回 null +
 *    errors，对应条目**保留旧值**——短暂的 API 抖动不该把展示数据抹掉；改名
 *    导致的长期失配属于策划问题，走 PR 更新 repository 即可。
 *  - **值没变不写文件**：避免每日产生无差异提交。
 *  - **写盘格式与 prettier 一致**（2 空格缩进 + 末尾换行）：verify 的格式检查
 *    不会因为机器写回而变红。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { githubRepoOf } from '../apps/desktop/src/main/plugin-artifact.ts'

/** 一次 GraphQL 查询最多带多少个仓库别名（GitHub 对批量大小的实际约束） */
const BATCH_SIZE = 100

const CATALOG_PATH = 'plugins/market.json'
const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql'

/**
 * 构造一批查询：`r0: repository(owner: …, name: …) { … }` 按序号做别名。
 *
 * owner / repo 经 JSON.stringify 转义——GraphQL 字符串与 JSON 字符串的转义
 * 规则兼容，带引号的名字不会破坏语法。
 */
export function buildBatchQuery(targets) {
  const parts = targets.map(
    (target, index) =>
      `r${index}: repository(owner: ${JSON.stringify(target.owner)}, name: ${JSON.stringify(target.repo)}) { stargazerCount owner { login avatarUrl } url }`,
  )
  return `{ ${parts.join(' ')} }`
}

/**
 * 解析一批 GraphQL 响应。
 *
 * 返回 `Map<别名, 元信息|null>`：仓库消失 / 字段类型异常的键为 null
 * （调用方保留旧值），其余键给出收窄过的元信息。`keys` 的顺序必须与
 * `buildBatchQuery` 当时的 targets 一致。
 */
export function parseBatchResponse(payload, keys) {
  const out = new Map()
  const data = payload && typeof payload === 'object' ? payload.data : null
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    const node = data ? data[key] : null
    if (!node || typeof node !== 'object') {
      out.set(key, null)
      continue
    }
    const record = node
    const stars = record.stargazerCount
    const owner = record.owner
    const meta = {}
    if (typeof stars === 'number' && Number.isFinite(stars) && stars >= 0) {
      meta.stars = Math.floor(stars)
    }
    if (owner && typeof owner === 'object' && typeof owner.login === 'string' && owner.login) {
      meta.author = owner.login
      const avatar = owner.avatarUrl
      if (typeof avatar === 'string' && /^https:\/\//i.test(avatar)) meta.avatar = avatar
    }
    if (typeof record.url === 'string' && /^https:\/\//i.test(record.url)) {
      meta.homepage = record.url
    }
    out.set(key, Object.keys(meta).length ? meta : null)
  }
  return out
}

/** 收集清单里所有 GitHub 仓库（同仓库多个条目只查一次） */
function collectTargets(plugins) {
  const byKey = new Map()
  for (const entry of plugins ?? []) {
    const repo = githubRepoOf(entry.repository)
    if (!repo) continue
    const key = `${repo.owner}/${repo.repo}`.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, { key, owner: repo.owner, repo: repo.repo })
  }
  return [...byKey.values()]
}

async function fetchBatch(targets, token) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'docvi-market-refresh',
    },
    body: JSON.stringify({ query: buildBatchQuery(targets) }),
  })
  if (!res.ok) {
    const remaining = res.headers.get('x-ratelimit-remaining')
    throw new Error(
      `GraphQL 查询失败（HTTP ${res.status}，剩余限额 ${remaining ?? '?'}）。` +
        (res.status === 403 || res.status === 429 ? '限额耗尽时等一小时重跑即可。' : ''),
    )
  }
  return res.json()
}

async function main() {
  const token = process.env.GITHUB_TOKEN?.trim()
  if (!token) throw new Error('缺少 GITHUB_TOKEN（Actions 里由 secrets.GITHUB_TOKEN 注入）')

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'))
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : []
  const targets = collectTargets(plugins)
  if (!targets.length) {
    console.log('[market-refresh] 清单里没有 GitHub 仓库，无事可做')
    return
  }

  // 按 100 个一批查询；别名序号 r0..r99 与批次内位置一一对应
  let changed = 0
  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    const batch = targets.slice(start, start + BATCH_SIZE)
    const keys = batch.map((_target, index) => `r${index}`)
    const payload = await fetchBatch(batch, token)
    const metaByKey = parseBatchResponse(payload, keys)

    for (let index = 0; index < batch.length; index += 1) {
      const target = batch[index]
      const meta = metaByKey.get(keys[index])
      if (!meta) {
        console.log(`[market-refresh] 跳过 ${target.key}（查询失败或仓库不存在，保留旧值）`)
        continue
      }
      for (const entry of plugins) {
        const repo = githubRepoOf(entry.repository)
        if (!repo || `${repo.owner}/${repo.repo}`.toLowerCase() !== target.key) continue
        const existing = entry.repo ?? {}
        const same =
          existing.stars === meta.stars &&
          existing.author === meta.author &&
          existing.avatar === meta.avatar &&
          existing.homepage === meta.homepage
        if (!same) {
          entry.repo = meta
          changed += 1
        }
      }
    }
    // 批间稍作停顿：即便扩展到几千仓库也不会形成打向 API 的连发
    if (start + BATCH_SIZE < targets.length) await new Promise(done => setTimeout(done, 300))
  }

  if (!changed) {
    console.log('[market-refresh] 所有值已是最新，不写文件')
    return
  }
  writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  console.log(`[market-refresh] 已更新 ${changed} 个条目的仓库信息 → ${CATALOG_PATH}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch(error => {
    console.error('[market-refresh] 失败：', error.message)
    process.exit(1)
  })
}
