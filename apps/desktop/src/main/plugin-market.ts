import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { MarketCatalog, MarketEntry, MarketRepoMeta } from '@docvi/shared'

import { parseArtifact } from './plugin-artifact.ts'

/**
 * 插件市场清单的拉取、缓存与解析。
 *
 * **市场是一份远端配置文件**，托管在 GitHub（`raw.githubusercontent.com`），
 * 内容就是「有哪些第三方插件、各自的仓库地址」。它不是安装包的一部分：
 *  - 想上架新插件 → 改远端那份文件，不用发版；
 *  - 内置插件不在里面 → 内置的随安装包发布，不存在「安装」这个动作。
 *
 * 三条硬约束（都是被真实网络环境逼出来的）：
 *  1. **必须能离线用**：拉不到就回退到本地缓存，并把「这是几天前的副本」
 *     显式告诉界面——静默失败会让人以为市场里就这点东西；
 *  2. **拉取必须有超时**：没有超时的 fetch 在网络半通时会挂到用户以为卡死
 *     （本机走代理时实测直连 GitHub 会一直 pending）；
 *  3. **清单是外部文件**：每个字段逐项校验，坏条目跳过而不是整份拒绝——
 *     远端文件写坏一条不该让整个市场空白。
 */

/**
 * 市场清单的远端地址。
 *
 * 走 `raw.githubusercontent.com`：这是纯静态文件、无需 API token、也不吃
 * GitHub API 的 60 次/小时限额。可用环境变量覆盖（内测/镜像/公司内网）。
 *
 * **前提是仓库公开**：私有仓的 raw 地址要带 token，客户端不带凭证——私有时
 * 会稳定拿到 404，界面据此提示「清单不可达」。仓库转公开后无需改代码。
 */
export const MARKET_URL =
  process.env.DOCVI_MARKET_URL?.trim() ||
  'https://raw.githubusercontent.com/OneFanki/docvi/main/plugins/market.json'

/** 拉取超时：走代理时 GitHub 首次连接可能要 2-3 秒，给足余量但不无限等 */
const FETCH_TIMEOUT_MS = 8000

export interface MarketOptions {
  /** 缓存在磁盘上的位置（userData 下） */
  cacheFile: string
  /**
   * 拉取实现。
   *
   * 主进程必须传 Electron 的 `net.fetch`，不能留空用全局 fetch：Node 的 fetch
   * 不读系统代理，在必须走代理才能访问 GitHub 的网络里会一直挂到超时（实例
   * 环境实测）。`net.fetch` 走 Chromium 网络栈，系统代理与 PAC 都生效。
   */
  fetchImpl?: typeof fetch
  /** 清单地址（测试注入） */
  url?: string
}

/** 缓存文件里存的东西：清单本身 + 拉取时间 */
interface CachedCatalog {
  fetchedAt: number
  plugins: MarketEntry[]
  updatedAt?: string
  schemaVersion?: number
}

/** 本地化字段归一：字符串原样，`{zh,en}` 取中文兜底 */
function localized(value: unknown, fallback: string): { zh: string; en?: string } {
  if (typeof value === 'string' && value) return { zh: value }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const zh = typeof record.zh === 'string' ? record.zh : fallback
    const en = typeof record.en === 'string' ? record.en : undefined
    return { zh, ...(en ? { en } : {}) }
  }
  return { zh: fallback }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 仓库元信息（作者 / star）：字段逐个校验，坏值丢弃而不是让整条记录失效 */
function parseRepoMeta(raw: unknown): MarketRepoMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const meta: MarketRepoMeta = {}
  if (typeof record.stars === 'number' && Number.isFinite(record.stars) && record.stars >= 0) {
    meta.stars = Math.floor(record.stars)
  }
  const author = str(record.author)
  if (author) meta.author = author
  const avatar = str(record.avatar)
  if (avatar && /^https:\/\//i.test(avatar)) meta.avatar = avatar
  const homepage = str(record.homepage)
  if (homepage && /^https:\/\//i.test(homepage)) meta.homepage = homepage
  return Object.keys(meta).length ? meta : null
}

/**
 * 解析远端清单。
 *
 * 只认**有仓库地址**的条目：市场存在的意义就是「去这里拿插件」，没有仓库
 * 地址的条目在界面上只能显示一个名字，点不动。坏条目跳过，不整份拒绝。
 */
export function parseCatalog(raw: unknown, now: number, sourceUrl: string): MarketCatalog {
  const record = (raw ?? {}) as Record<string, unknown>
  const list = Array.isArray(record.plugins) ? record.plugins : []
  const plugins: MarketEntry[] = []
  /*
   * `name` 是全市场的唯一键：已装插件的目录按它落位、`isInstalled` 按它匹配。
   * 一个仓库可以登记多个插件（每个插件一条记录、各自的 name 与 artifact），
   * 但同一个 name 出现两次就是维护失误——不去重的话界面上会出现两张卡片，
   * 安装哪张都写同一个目录。保留首次出现的，后面的丢弃。
   */
  const seenNames = new Set<string>()

  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const name = str(entry.name)
    const version = str(entry.version)
    const repository = str(entry.repository)
    if (!name || !version || !repository) continue
    // 仓库地址必须是 http(s)：`javascript:` 之类塞进 <a href> 就是一个 XSS 面
    if (!/^https?:\/\//i.test(repository)) continue
    if (seenNames.has(name)) continue
    seenNames.add(name)

    const trust =
      entry.trust === 'trusted-service' || entry.trust === 'sandbox-service'
        ? entry.trust
        : 'presentation'

    // 产物入口：地址不可信就当没有（不是整条拒绝——仍可「打开仓库」）
    const artifact = parseArtifact(entry.artifact)
    const repo = parseRepoMeta(entry.repo)

    plugins.push({
      name,
      displayName: localized(entry.displayName, name),
      version,
      ...(entry.description ? { description: localized(entry.description, '') } : {}),
      trust,
      ...(Array.isArray(entry.tags)
        ? { tags: entry.tags.filter((tag): tag is string => typeof tag === 'string') }
        : {}),
      repository,
      ...(artifact ? { artifact } : {}),
      ...(repo ? { repo } : {}),
    })
  }

  return {
    schemaVersion: Number(record.schemaVersion) || 1,
    ...(str(record.updatedAt) ? { updatedAt: str(record.updatedAt) as string } : {}),
    plugins,
    fetchedAt: now,
    sourceUrl,
  }
}

/** 读缓存；文件缺失或损坏都当「没有缓存」 */
export function readCache(cacheFile: string, sourceUrl: string): MarketCatalog | null {
  if (!existsSync(cacheFile)) return null
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as CachedCatalog
    if (!Array.isArray(cached.plugins)) return null
    return {
      schemaVersion: cached.schemaVersion ?? 1,
      ...(cached.updatedAt ? { updatedAt: cached.updatedAt } : {}),
      plugins: cached.plugins,
      fetchedAt: Number(cached.fetchedAt) || 0,
      sourceUrl,
    }
  } catch {
    return null
  }
}

/** 写缓存（先写临时文件再 rename：中途被杀不会留下半截 JSON） */
function writeCache(cacheFile: string, catalog: MarketCatalog): void {
  mkdirSync(dirname(cacheFile), { recursive: true })
  const payload: CachedCatalog = {
    fetchedAt: catalog.fetchedAt,
    plugins: catalog.plugins,
    ...(catalog.updatedAt ? { updatedAt: catalog.updatedAt } : {}),
    schemaVersion: catalog.schemaVersion,
  }
  const tmp = `${cacheFile}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, cacheFile)
}

/**
 * 取市场清单。
 *
 * @param refresh true = 强制拉远端（界面上的「刷新」按钮）；false = 有缓存就用缓存。
 *
 * 网络失败**永远不抛**：有缓存返回缓存（带 error 说明是离线副本），没缓存返回
 * 空目录 + error。市场是锦上添花的功能，不能因为它让插件面板报错。
 */
export async function loadMarket(options: MarketOptions, refresh: boolean): Promise<MarketCatalog> {
  const url = options.url ?? MARKET_URL
  const fetchImpl = options.fetchImpl ?? fetch

  if (!refresh) {
    const cached = readCache(options.cacheFile, url)
    /*
     * 缓存新鲜度：一小时内的缓存直接用，不打扰远端。
     * 太短会让每次开面板都走一次网络（离线时每次都要等超时）；太长则
     * 上架的插件要等半天才出现——一小时是「点开就看到新插件」与「少打网络」
     * 之间的折中，且随时可以手动刷新。
     */
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) return cached
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as unknown
    const catalog = parseCatalog(raw, Date.now(), url)
    // 空清单不覆盖缓存：远端文件被误清空时，用户不该丢掉上一次的可用列表
    if (catalog.plugins.length) writeCache(options.cacheFile, catalog)
    return catalog
  } catch (error) {
    const reason =
      (error as Error).name === 'AbortError'
        ? `拉取超时（${FETCH_TIMEOUT_MS / 1000}s）`
        : (error as Error).message
    /*
     * 404 单独给一句人话：开源仓还没发布、仓库是私有的、分支名不对、文件被挪走，
     * 都会表现为 404。统称「网络失败」会让用户去查网络，方向就错了。
     */
    const hinted =
      reason === 'HTTP 404'
        ? '清单不可达（HTTP 404）——仓库可能仍是私有、分支名不对，或仓库里还没有 plugins/market.json'
        : reason
    const cached = readCache(options.cacheFile, url)
    if (cached) return { ...cached, error: `刷新失败：${hinted}（显示的是上次缓存）` }
    return {
      schemaVersion: 1,
      plugins: [],
      fetchedAt: 0,
      sourceUrl: url,
      error: `无法获取插件市场：${hinted}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
