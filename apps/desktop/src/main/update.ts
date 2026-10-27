import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type {
  RuntimeInfo,
  UpdateAsset,
  UpdateCheckResult,
  UpdateDownloaded,
  UpdateProgress,
} from '@docvi/shared'

import { compareVersions, trustedHttpsUrl } from './version.ts'
import {
  buildWindowsInstallScript,
  pickAsset,
  safeUpdateFileName,
  trustedAssetUrl,
} from './update-plan.ts'

/**
 * 关于信息、更新检查与更新下载。
 *
 * ## 为什么下载必须走 `net.fetch` 而不是全局 `fetch`
 *
 * Node 的全局 `fetch`（undici）**不读系统代理**。在必须挂代理才能访问 GitHub 的
 * 网络里，检查能过（那边用的就是 `net.fetch`）而下载必然超时——用户看到的是
 * 「点了更新，进度一动不动」。`net.fetch` 走 Chromium 网络栈，直接沿用系统代理
 * 设置，不需要用户再填一遍代理地址。
 *
 * 顺带一个好处：应用自己下载不经过浏览器，文件不带 Mark-of-the-Web，
 * Windows 不会按「从网上下载的」对待它。
 *
 * ## 安全底线（每一条都不能省）
 *
 *  1. 只接受 HTTPS、只接受可信域（GitHub / 其资产域名）；
 *  2. 必须拿到 SHA-256 才下载——拿不到就没有资格执行；
 *  3. 先写 `.part`，校验通过才改名：中途失败/校验不过只会留下被删掉的临时文件；
 *  4. 安装前等主进程真正退出（Windows 不允许覆盖运行中的 exe）。
 *
 * 签名仍然是缺的：安装包未做代码签名，系统可能提示「未知发布者」。这一点
 * 无法靠代码消除，只能在文档与 UI 里如实说明。
 */

/** 项目主页：关于页展示、资产域名白名单都从这里派生 */
export const REPOSITORY_URL = 'https://github.com/OneFanki/docvi'

/** 发布清单地址：可用环境变量覆盖（CI / 内测指向不同渠道） */
const UPDATE_MANIFEST_URL =
  process.env.DOCVI_UPDATE_MANIFEST_URL?.trim() ||
  'https://raw.githubusercontent.com/OneFanki/docvi/main/latest.json'

/** 检查超时：离线环境下不该让「关于」面板挂在那儿转圈 */
const CHECK_TIMEOUT_MS = 6000

/** 下载超时按「多久没有新数据」算，不是总时长：几十 MB 的包不该被总时长卡死 */
const STALL_TIMEOUT_MS = 30_000

/** 重定向跳数上限：GitHub 目前最多 2 跳（github.com → CDN → 签名地址） */
const MAX_REDIRECTS = 5

export function runtimeInfo(): RuntimeInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    node: process.versions.node ?? null,
    v8: process.versions.v8 ?? null,
    platform: process.platform,
    arch: process.arch,
    dataDir: app.getPath('userData'),
    packaged: app.isPackaged,
    homepage: REPOSITORY_URL,
    ...(process.env.DOCVI_HOMEPAGE ? { homepage: process.env.DOCVI_HOMEPAGE.trim() } : {}),
  }
}

interface Manifest {
  version?: unknown
  downloadUrl?: unknown
  notes?: unknown
  homepage?: unknown
}

/** 从清单里取字段（形状不可信：清单是外部文件，逐字段校验） */
function field(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** GitHub Release API 返回的资产形状（只取需要的字段） */
interface ApiAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
  digest?: unknown
}

function parseAsset(raw: ApiAsset): UpdateAsset | null {
  const name = field(raw.name)
  const url = trustedAssetUrl(raw.browser_download_url)
  if (!name || !url) return null
  const size = typeof raw.size === 'number' && raw.size > 0 ? raw.size : undefined
  /*
   * digest 形如 `sha256:<hex>`；没有 digest 的资产（旧版本、手工上传）保留下来，
   * 但 `sha256` 缺失——下载入口会因此被禁用，这是有意的。
   */
  const digest = field(raw.digest)
  const sha256 = digest?.startsWith('sha256:') ? digest.slice(7).toLowerCase() : undefined
  return {
    name,
    url,
    ...(size ? { size } : {}),
    ...(sha256 && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
  }
}

/**
 * 从 GitHub API 取本版本的资产清单。
 *
 * 为什么不用清单文件带资产列表：那样每次发版都要人工同步一份带 sha256 的清单，
 * 漏一次就变成「有新版但下不了」。Release API 的 digest 是 GitHub 按上传内容
 * 自己算的，天然与资产一致。
 */
async function fetchReleaseAssets(version: string): Promise<UpdateAsset[]> {
  if (!/^[0-9A-Za-z.+_-]+$/.test(version)) return []
  const url = `https://api.github.com/repos/OneFanki/docvi/releases/tags/v${version}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json' },
      redirect: 'follow',
    })
    if (!res.ok) return []
    const body = (await res.json()) as { assets?: unknown }
    if (!Array.isArray(body.assets)) return []
    return body.assets
      .filter((item): item is ApiAsset => Boolean(item) && typeof item === 'object')
      .map(parseAsset)
      .filter((item): item is UpdateAsset => item !== null)
  } catch {
    // 资产解析是「锦上添花」：失败就只给下载页，不影响「有新版本」这个结论
    return []
  } finally {
    clearTimeout(timer)
  }
}

export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  const checkedAt = Date.now()

  if (!UPDATE_MANIFEST_URL) {
    return {
      status: 'unavailable',
      current,
      checkedAt,
      message: '未配置发布清单地址',
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    /*
     * 用 `net.fetch`（Chromium 网络栈）而不是全局 fetch：Node 的 fetch 不读
     * 系统代理，在必须走代理才能访问 GitHub 的网络里永远超时——「关于」面板
     * 会一直显示「检查失败」，看起来像功能坏了。
     */
    const res = await net.fetch(UPDATE_MANIFEST_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    })
    if (!res.ok) {
      /*
       * 404 与其它状态分开说：仓库还私有、发版分支不对、清单没提交，都会是 404。
       * 「HTTP 404」单独抛出去，用户才知道该去查仓库可见性而不是网络。
       */
      return {
        status: 'unavailable',
        current,
        checkedAt,
        message:
          res.status === 404
            ? '发布清单不可达（HTTP 404）——仓库可能仍是私有，或还没有 latest.json'
            : `发布清单不可达（HTTP ${res.status}）`,
      }
    }
    const manifest = (await res.json()) as Manifest
    const latest = field(manifest.version)
    if (!latest) {
      return { status: 'unavailable', current, checkedAt, message: '发布清单缺少 version 字段' }
    }
    if (compareVersions(latest, current) <= 0) {
      return { status: 'latest', current, latest, checkedAt }
    }
    const assets = await fetchReleaseAssets(latest)
    const asset = pickAsset(assets, process.platform, process.arch)
    return {
      status: 'outdated',
      current,
      latest,
      checkedAt,
      ...(trustedHttpsUrl(field(manifest.downloadUrl))
        ? { downloadUrl: trustedHttpsUrl(field(manifest.downloadUrl)) as string }
        : {}),
      ...(field(manifest.notes) ? { notes: field(manifest.notes) as string } : {}),
      ...(asset ? { asset } : {}),
    }
  } catch (error) {
    const reason = (error as Error).name === 'AbortError' ? '检查超时' : (error as Error).message
    return { status: 'unavailable', current, checkedAt, message: reason }
  } finally {
    clearTimeout(timer)
  }
}

/* ---------- 下载 ---------- */

/** 待安装的包：只在主进程持有，渲染层拿不到磁盘路径 */
interface PendingUpdate {
  version: string
  filePath: string
}

let pending: PendingUpdate | null = null
let activeDownload: AbortController | null = null

/** 下载目录：放在系统临时目录下的固定子目录，便于用户自己找到 */
function updateDir(): string {
  const dir = join(tmpdir(), 'docvi-update')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 已下载好的包是否还在（用户可能手动删了临时目录） */
export function pendingUpdate(): PendingUpdate | null {
  if (!pending) return null
  return existsSync(pending.filePath) ? pending : null
}

export function clearPendingUpdate(): void {
  if (pending) rmSync(pending.filePath, { force: true })
  pending = null
}

/**
 * 下载响应的最小形状。
 *
 * Electron 的类型声明把 `IncomingMessage` 写成普通对象，**运行时它其实是
 * Node 的 Readable**（`pipeline` 与 `.resume()` 都能用）。所以这里声明自己需要的
 * 那部分接口，而不是依赖那份不准确的类型——比 `as any` 精确，也不用绕类型检查。
 */
interface DownloadResponse extends Readable {
  statusCode?: number
  headers: Record<string, string | string[] | undefined>
}

/**
 * 发起下载请求，逐跳校验重定向目标，返回可读的响应流。
 *
 * 为什么不用 `net.fetch`：它跟随重定向后 `response.url` 为空串（实测），
 * 无法验证最终地址；`redirect: 'manual'` 在 Chromium 栈里又直接取消重定向。
 * `net.request` 的 `redirect` 事件是唯一能逐跳看到目标的入口。
 *
 * 每一跳都要求落在可信域内——GitHub 的 release 下载会 302 到带签名的 CDN
 * （`release-assets.githubusercontent.com`），那一跳同样要过这道检查。
 */
function requestStream(
  url: string,
  signal: AbortSignal,
  onActivity: () => void,
): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual' })
    let hops = 0
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      try {
        request.abort()
      } catch {
        // 已经结束的请求再 abort 会抛，忽略
      }
      reject(error)
    }

    signal.addEventListener('abort', () => fail(new Error('AbortError')), { once: true })

    request.on('redirect', (_status, _method, redirectUrl) => {
      hops += 1
      if (hops > MAX_REDIRECTS) {
        fail(new Error('下载重定向次数过多，已停止'))
        return
      }
      const next = new URL(redirectUrl, url).toString()
      if (!trustedAssetUrl(next)) {
        fail(new Error(`更新下载被重定向到不受信任的地址，已停止（${next}）`))
        return
      }
      onActivity()
      // 验过再来下一跳
      request.followRedirect()
    })

    request.on('response', response => {
      const stream = response as unknown as DownloadResponse
      if (settled) {
        stream.destroy()
        return
      }
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        stream.resume()
        fail(new Error(`下载失败：HTTP ${status}`))
        return
      }
      settled = true
      resolve(stream)
    })

    request.on('error', error => fail(error instanceof Error ? error : new Error(String(error))))
    request.setHeader('accept', 'application/octet-stream')
    request.end()
  })
}

/**
 * 下载并校验更新包。
 *
 * 进度通过 `onProgress` 回传；失败一律先删临时文件再抛错。
 */
export async function downloadUpdate(
  asset: UpdateAsset,
  version: string,
  onProgress: (progress: UpdateProgress) => void,
): Promise<UpdateDownloaded> {
  if (activeDownload) throw new Error('已有下载在进行中')
  const url = trustedAssetUrl(asset.url)
  if (!url) throw new Error('更新地址不受信任，已停止下载')
  const expected = asset.sha256?.trim().toLowerCase()
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error('该版本没有提供校验值，无法安全下载')
  }

  const dir = updateDir()
  const fileName = safeUpdateFileName(asset.name, version)
  const target = join(dir, fileName)
  const partial = `${target}.part`
  await rm(partial, { force: true })

  const controller = new AbortController()
  activeDownload = controller
  let stallTimer: NodeJS.Timeout | null = null
  const armStall = (): void => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS)
  }

  onProgress({
    phase: 'downloading',
    version,
    received: 0,
    ...(asset.size ? { total: asset.size } : {}),
  })
  try {
    armStall()
    /*
     * 用 `net.request` 而不是 `net.fetch`。
     *
     * 两个实测事实决定了这一点：
     *  1. `net.fetch` 跟随重定向后 `response.url` 是**空串**，拿它验域等于没验；
     *  2. `redirect: 'manual'` 在 Chromium 网络栈里是「取消重定向」，直接抛
     *     `Redirect was cancelled`，不是返回 3xx。
     *
     * `net.request` 的 `redirect` 事件是唯一能**逐跳**看到目标地址的入口：
     * 每一跳都验域，不合规就 abort。GitHub 的 release 下载会 302 到带签名的
     * CDN 地址（`release-assets.githubusercontent.com`），那一跳同样在链上。
     */
    const response = await requestStream(url, controller.signal, armStall)

    const declared = Number(response.headers['content-length'] ?? '')
    const total = Number.isFinite(declared) && declared > 0 ? declared : asset.size
    const hash = createHash('sha256')
    let received = 0
    let lastEmit = 0

    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        hash.update(chunk)
        armStall()
        // 进度事件按 ~1% 或 ~200ms 节流：逐块上报会让 IPC 成为下载瓶颈
        const now = Date.now()
        if (now - lastEmit > 200) {
          lastEmit = now
          onProgress({ phase: 'downloading', version, received, ...(total ? { total } : {}) })
        }
        callback(null, chunk)
      },
    })
    // net.request 的响应本身就是 Node 可读流，直接管线化，不必经 Web Stream 转换
    await pipeline(response, meter, createWriteStream(partial, { mode: 0o600 }))

    onProgress({ phase: 'verifying', version, received, ...(total ? { total } : {}) })
    const actual = hash.digest('hex')
    if (actual !== expected) {
      throw new Error('下载文件的校验值与发布记录不一致，已删除，未执行安装')
    }
    if (total !== undefined && received !== total) {
      throw new Error('下载不完整，已删除，未执行安装')
    }

    await rename(partial, target)
    pending = { version, filePath: target }
    onProgress({ phase: 'ready', version, received, ...(total ? { total } : {}) })
    return { version, fileName }
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined)
    const aborted = (error as Error).name === 'AbortError'
    const message = aborted ? '下载已取消或超时' : (error as Error).message
    onProgress({ phase: 'error', version, message })
    throw new Error(message)
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    activeDownload = null
  }
}

export function cancelUpdateDownload(): void {
  activeDownload?.abort()
}

/**
 * 启动安装并退出应用。
 *
 * macOS 的 dmg 需要用户拖拽安装，Linux 的 deb/AppImage 也有各自的流程，
 * 所以只有 Windows 做静默升级，其它平台把文件交给系统默认程序打开
 * （用户看到的仍是标准安装流程，应用会先退出）。
 */
export async function installUpdate(): Promise<void> {
  const current = pendingUpdate()
  if (!current) throw new Error('还没有下载好的更新包')

  if (process.platform === 'win32') {
    const scriptPath = join(dirname(current.filePath), `apply-${process.pid}.cmd`)
    const script = buildWindowsInstallScript({
      pid: process.pid,
      installerPath: current.filePath,
      appExePath: process.execPath,
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(scriptPath, script, 'utf8')
    const { spawn } = await import('node:child_process')
    spawn('cmd.exe', ['/c', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    app.quit()
    return
  }

  const { shell } = await import('electron')
  const error = await shell.openPath(current.filePath)
  if (error) throw new Error(`无法启动安装程序：${error}`)
  app.quit()
}

/** 启动时清理上一次遗留的安装包（成功升级后旧包没有用了） */
export function pruneUpdateCache(): void {
  if (pending) {
    rmSync(pending.filePath, { force: true })
    pending = null
  }
  const dir = join(tmpdir(), 'docvi-update')
  if (!existsSync(dir)) return
  // 目录里可能还有下载到一半的 .part（进程被强杀留下的），一并清掉
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.part') || name.endsWith('.cmd')) {
        rmSync(join(dir, name), { force: true })
      }
    }
  } catch {
    // 清理是尽力而为，失败不影响启动
  }
}

/** 文件名（给 UI 展示用） */
export function pendingUpdateName(): string | null {
  const current = pendingUpdate()
  return current ? basename(current.filePath) : null
}
