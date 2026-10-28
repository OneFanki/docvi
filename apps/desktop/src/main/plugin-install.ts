import { net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MarketEntry } from '@docvi/shared'

import {
  artifactFiles,
  looksLikeHtml,
  manifestMatchesEntry,
  parseArtifact,
  safePackagePath,
  trustedArtifactUrl,
  type MarketArtifact,
} from './plugin-artifact.ts'
import type { PluginStore } from './plugin-store.ts'

/**
 * 从市场安装插件：拉产物 → 校验 → 落盘。
 *
 * ## 为什么是「拉产物」而不是「拉仓库 / 拉 tarball」
 *
 * 用户的原话是「插件仓库自动构建出产物，我们只管拉产物」。落到实现上还有一条
 * 硬约束：桌面安装包里**不带 node_modules**（见 plugin-store.ts 的说明），
 * 没有解压库。插件产物恰好就是纯文本（入口 JS + 样式 CSS + manifest），
 * 逐个 URL 拉下来直接写盘即可——既不需要解压，也天然支持逐文件校验。
 *
 * ## 每一步都不能省
 *
 *  | 步骤 | 省掉的后果 |
 *  | --- | --- |
 *  | 验域（https + 可信域） | 清单被改就能让客户端去任意地址取代码 |
 *  | 取回内容验 HTML | 404 页被当成 JS 写盘 → 插件报一个与真实原因无关的语法错 |
 *  | 校验 name/version | 装的可能不是清单说的那个插件 |
 *  | 路径校验 | `../` 能把文件写到插件目录之外 |
 *  | 先写临时目录再 rename | 中途失败会在插件目录留下半个包，下次扫描读坏 |
 *
 * ## 为什么产物下载也用 net.fetch
 *
 * 与更新下载同一条理由：Node 全局 fetch 不读系统代理，在必须挂代理才能访问
 * GitHub 的网络里会一直超时。`net.fetch` 走 Chromium 网络栈。
 */

/** 单个文件上限：插件产物是文本，超过这个量级说明地址配错了（或是被塞了二进制） */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/** 下载超时：走代理时首次连接可能要几秒，给足余量但不无限等 */
const FETCH_TIMEOUT_MS = 20_000

export interface InstallPluginOptions {
  /** 市场条目（已由渲染层从清单里取回；这里仍然全量校验） */
  entry: Pick<MarketEntry, 'name' | 'version' | 'artifact'>
  plugins: PluginStore
  fetchImpl?: typeof fetch
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'text/plain, application/json, */*' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${url}`)
    const body = await res.text()
    if (body.length > MAX_FILE_BYTES) {
      throw new Error(`文件超过上限（${MAX_FILE_BYTES} 字节）：${url}`)
    }
    if (looksLikeHtml(body)) {
      // 404 页 / 登录墙 / CDN 错误页都是 200 + HTML
      throw new Error(`返回的是网页而不是插件文件（地址可能配错或需要登录）：${url}`)
    }
    return body
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(`下载超时（${FETCH_TIMEOUT_MS / 1000}s）：${url}`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 安装一个市场插件，返回安装后的插件记录。
 *
 * 全部校验通过后才动插件目录；任一环节失败都清掉本次写入的临时目录。
 */
export async function installFromMarket(options: InstallPluginOptions): Promise<void> {
  const { entry, plugins } = options
  const fetchImpl = options.fetchImpl ?? (net.fetch as unknown as typeof fetch)

  const artifact: MarketArtifact | null = parseArtifact(entry.artifact)
  if (!artifact) {
    throw new Error('清单条目的产物地址缺失或不在可信域内（只允许 https + GitHub）')
  }

  // 1) 先取 manifest：文件名、入口、样式都写在里面
  const manifestBody = await fetchText(artifact.manifest, fetchImpl)
  if (artifact.sha256) {
    const actual = createHash('sha256').update(manifestBody).digest('hex')
    if (actual !== artifact.sha256) {
      throw new Error('manifest 的校验值与清单不一致，已中止安装')
    }
  }
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(manifestBody)
  } catch {
    throw new Error('远端 manifest 不是合法 JSON')
  }
  const match = manifestMatchesEntry(manifestRaw as { name?: unknown; version?: unknown }, {
    name: entry.name,
    version: entry.version,
  })
  if (!match.ok) throw new Error(match.reason)

  // 2) 按 manifest 声明的入口与样式逐个下载
  const files = artifactFiles(
    manifestRaw as { entry?: unknown; styles?: unknown },
    artifact.manifest,
  )
  const bodies = new Map<string, string>()
  for (const file of files) {
    const url = trustedArtifactUrl(file.url)
    if (!url) throw new Error(`产物文件地址不可信：${file.url}`)
    bodies.set(file.path, await fetchText(url, fetchImpl))
  }

  // 3) 落到插件目录：先写临时目录，全部成功后再 rename 到位
  /*
   * 临时目录放在**插件用户目录**里而不是系统临时目录：跨磁盘 rename 会退化成
   * 复制，而这中间被杀就会在目标位置留下半个包。同目录 rename 是原子的。
   */
  const userDir = plugins.userDir
  mkdirSync(userDir, { recursive: true })
  const staging = join(userDir, `.staging-${process.pid}-${Date.now()}`)
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(join(staging, 'plugin.json'), manifestBody, 'utf8')
    for (const [path, body] of bodies) {
      const safe = safePackagePath(path)
      if (!safe) throw new Error(`产物路径非法：${path}`)
      const target = join(staging, safe)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, body, 'utf8')
    }
    // 交给 plugin-store 按它自己的规则校验并落位（它会再验一次 manifest）
    const installed = plugins.install(staging)
    /*
     * 安装后立刻回读：`install()` 的返回值来自 staging 目录，而 `list()` 来自
     * 目标目录扫描。两者不一致（比如复制没落地）时这里就会暴露——否则调用方
     * 拿到 ok 却在列表里找不到插件，变成一个查不出原因的哑谜。
     */
    const landedDir = join(userDir, installed.manifest.name, installed.manifest.version)
    const landed = plugins.list().some(item => item.manifest.name === installed.manifest.name)
    if (!landed) {
      throw new Error(
        `插件写入后未被扫描到：${landedDir}。\n` + `staging=${staging}\n` + `userDir=${userDir}`,
      )
    }
  } finally {
    // 无论成功失败都清掉临时目录：成功后内容已复制到 <id>/<version>/
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

/*
 * 注意这里**没有**「取仓库作者与 star」的逻辑。
 *
 * 最初版本是客户端逐仓调 GitHub 公开 API——能用只是因为清单里条目少。未认证
 * 限额是 60 次/小时且**按 IP 由所有用户共享**，市场里几十个插件时每个打开面板
 * 的用户都在烧同一个配额，必然撞死。dsh-market 的解法（读它的 registry.ts 验证过）
 * 是 star 由注册表服务端用 CI 预先采集好，客户端零调用——`repo` 字段因此改为
 * 清单自带，由 `.github/workflows/market-refresh.yml` 每日批量刷新。
 */
