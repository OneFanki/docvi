#!/usr/bin/env node
/**
 * deployer 入口：装配配置/构建器/HTTP 服务，启动时从卷恢复状态（AC10），
 * 按配置驱动轮询拉取与定期清理。全部环境变量：
 *   DEPLOYER_DATA_DIR     数据卷（默认 /data）
 *   DEPLOYER_PLATFORM_DIR 平台仓（含 scripts/build-docs-index.mjs 与 node_modules，默认 /app）
 *   DEPLOYER_PORT         监听端口（默认 8080）
 *   OPS_TOKEN             运维 token（未设 = 运维面关闭，只读门户与文档站）
 *   PLATFORM_VERSION      镜像版本（写入构建记录，供平台升级提示，默认 dev）
 *   SHARE_ROOTS           临时分享的共享根（分号分隔容器内绝对路径；默认 /share——
 *                         分享目标必须落在共享根内，本机路径先挂载进容器）
 */
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { createBuilder, createMountPolicy } from '../src/builder.mjs'
import { createHttpd } from '../src/httpd.mjs'
import { createPluginsService } from '../src/plugins.mjs'
import { createSharesService } from '../src/shares.mjs'
import * as gitOps from '../src/git.mjs'
import { cronMatches, effAutoBuild, effAutoFetch, loadConfig, saveConfig } from '../src/config.mjs'
import { audit, ensureLayout } from '../src/store.mjs'

const DATA_DIR = resolve(process.env.DEPLOYER_DATA_DIR || '/data')
const PLATFORM_DIR = resolve(process.env.DEPLOYER_PLATFORM_DIR || process.cwd())
const PORT = Number(process.env.DEPLOYER_PORT || 8080)
const TOKEN = process.env.OPS_TOKEN || ''
const VERSION = process.env.PLATFORM_VERSION || 'dev'
const SHARE_ROOTS = (process.env.SHARE_ROOTS || '/share')
  .split(';')
  .map(part => part.trim())
  .filter(Boolean)

ensureLayout(DATA_DIR)
const loadConfigData = () => loadConfig(DATA_DIR)
const saveConfigData = cfg => saveConfig(DATA_DIR, cfg)

const builder = createBuilder({
  dataDir: DATA_DIR,
  platformDir: PLATFORM_DIR,
  version: VERSION,
  gitOps,
  loadConfigData,
  onSwap: createMountPolicy({ dataDir: DATA_DIR }),
})

const plugins = createPluginsService({
  dataDir: DATA_DIR,
  platformDir: PLATFORM_DIR,
  version: VERSION,
  loadConfigData,
  saveConfigData,
})

const shares = createSharesService({
  dataDir: DATA_DIR,
  shareRoots: SHARE_ROOTS,
  audit,
})

const httpd = createHttpd({
  dataDir: DATA_DIR,
  platformDir: PLATFORM_DIR,
  version: VERSION,
  token: TOKEN,
  gitOps,
  builder,
  plugins,
  shares,
  loadConfigData,
  saveConfigData,
  audit,
})

/** 启动恢复：有主库的仓库直接入队 reconcile（同步 + 分支谱系维护）；缺主库的重新 provision */
async function reconcileOnBoot() {
  const cfg = loadConfigData()
  for (const repo of cfg.repos) {
    try {
      const bare = join(DATA_DIR, 'git', `${repo.slug}.git`)
      if (!gitOps.hasBare(bare)) {
        builder.enqueue({
          type: 'provision',
          slug: repo.slug,
          branch: repo.branches[0],
          trigger: 'boot',
        })
        continue
      }
      builder.enqueue({
        type: 'reconcile',
        slug: repo.slug,
        branch: repo.branches[0],
        trigger: 'boot',
      })
    } catch (error) {
      console.error(`[deployer] 恢复 ${repo.slug} 失败：${error.message}`)
    }
  }
}

/** 轮询拉取：对 effAutoFetch=poll 的仓库按 fetchIntervalSec 周期 fetch+构建 */
let lastPollAt = 0
async function pollTick() {
  const now = Date.now()
  const cfg = loadConfigData()
  // 没有任何 poll 仓库时不消耗节流窗口——配置从 webhook 切到 poll 后，
  // 下一 tick（≤60s）即生效，而非等满一个间隔窗口（实测踩过）
  if (!cfg.repos.some(repo => effAutoFetch(repo, cfg.global) === 'poll')) return
  const intervalMs = Math.max(60, cfg.global.fetchIntervalSec) * 1000
  if (now - lastPollAt < intervalMs) return
  lastPollAt = now
  for (const repo of cfg.repos) {
    if (effAutoFetch(repo, cfg.global) !== 'poll') continue
    try {
      const bare = join(DATA_DIR, 'git', `${repo.slug}.git`)
      if (!gitOps.hasBare(bare)) continue
      // 统一走 builder.updateRepo：fetch → 分支谱系维护（新命中分支自动建树/入队）
      // → 各工作树对齐远端（autoBuild 关闭时只重置不索引）
      await builder.updateRepo(repo, { trigger: 'poll', build: effAutoBuild(repo, cfg.global) })
    } catch (error) {
      console.error(`[deployer] 轮询 ${repo.slug} 失败：${error.message}`)
    }
  }
}

/** 定期清理：命中 cleanupCron 的分钟执行一次（每仓 reconcile = 补建白名单 + 清白名单外） */
let lastCleanupKey = ''
async function cleanupTick() {
  const cfg = loadConfigData()
  const now = new Date()
  if (!cronMatches(cfg.global.cleanupCron, now)) return
  const key = `${now.toDateString()} ${now.getHours()}:${now.getMinutes()}`
  if (key === lastCleanupKey) return
  lastCleanupKey = key
  for (const repo of cfg.repos) {
    const bare = join(DATA_DIR, 'git', `${repo.slug}.git`)
    if (gitOps.hasBare(bare)) {
      builder.enqueue({
        type: 'reconcile',
        slug: repo.slug,
        branch: repo.branches[0],
        trigger: 'cleanup',
      })
    }
  }
}

process.on('unhandledRejection', reason => {
  console.error('[deployer] 未处理的 Promise 拒绝：', reason)
})

createServer(httpd).listen(PORT, '0.0.0.0', () => {
  console.log(`\n▶ docs-platform deployer v${VERSION}`)
  console.log(`  数据卷 ${DATA_DIR} ｜ 平台 ${PLATFORM_DIR}`)
  console.log(
    `  运维面 ${TOKEN ? '已启用（OPS_TOKEN）' : '未配置 OPS_TOKEN——门户与文档站可访问，运维 API 关闭'}`,
  )
  console.log(`  http://localhost:${PORT}/\n`)
})

reconcileOnBoot().catch(error => console.error('[deployer] 启动恢复失败：', error))
setInterval(() => pollTick().catch(e => console.error('[deployer] 轮询异常：', e.message)), 60_000)
setInterval(
  () => cleanupTick().catch(e => console.error('[deployer] 清理异常：', e.message)),
  60_000,
)
