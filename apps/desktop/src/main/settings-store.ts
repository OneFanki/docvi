import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { normalizeSettings, type AppSettings } from '@docvi/shared'

/**
 * 设置与会话的持久化。
 *
 * 两份文件、两种消费者：
 *  - `settings.json`：用户偏好。允许手改、允许导出，外部改动要**热生效**（监听父目录）。
 *  - `session.json`：窗口状态（标签、MRU、历史）。程序独占写，不为它做热加载。
 *
 * 两条纪律：
 *  1. **原子写**（临时文件 + rename）：半写状态会让下次启动读到一个截断的 JSON；
 *  2. **坏文件不阻塞启动**：解析失败用默认值继续跑，并通过 `lastError` 让设置页能报出来。
 */

export interface SettingsStoreOptions {
  settingsFile: string
  sessionFile: string
}

export interface SettingsStore {
  get(): AppSettings
  /** 合并补丁后落盘，返回合并结果 */
  update(patch: unknown): AppSettings
  /** 最近一次读写错误（供设置页显示；成功读取后清空） */
  lastError(): string | null
  /** 监听文件被外部修改（AI / 编辑器手改），回调里给合并后的设置 */
  onExternalChange(listener: (settings: AppSettings) => void): () => void
  readSession(): unknown
  writeSession(value: unknown): void
}

/** 深合并：只递归普通对象，数组与原始值直接覆盖 */
function mergeDeep<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    const current = out[key]
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
        ? mergeDeep(current as Record<string, unknown>, value)
        : value
  }
  return out as T
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  let error: string | null = null
  let settings = load()
  const listeners = new Set<(settings: AppSettings) => void>()

  function load(): AppSettings {
    if (!existsSync(options.settingsFile)) return normalizeSettings(null)
    try {
      const parsed = JSON.parse(readFileSync(options.settingsFile, 'utf8')) as unknown
      error = null
      return normalizeSettings(parsed)
    } catch (cause) {
      // 坏文件保留在磁盘上（用户能自己修），内存里用默认值继续
      error = `settings.json 解析失败，已使用默认设置：${(cause as Error).message}`
      return normalizeSettings(null)
    }
  }

  /**
   * 监听 settings.json 的外部修改。
   *
   * 必须监听**父目录**并过滤文件名：文件被 rename 覆盖后，原来指向 inode 的
   * watcher 会失效（与文档监视同一个坑，S2 已踩过）。
   */
  function startWatch(): () => void {
    const dir = dirname(options.settingsFile)
    const name = options.settingsFile.split(/[/\\]/).pop() ?? 'settings.json'
    mkdirSync(dir, { recursive: true })
    let timer: NodeJS.Timeout | null = null
    try {
      const watcher = watch(dir, (_event, filename) => {
        if (filename && filename !== name) return
        // 编辑器保存常触发多次事件：合并成一次重读
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          const next = load()
          settings = next
          for (const listener of listeners) listener(next)
        }, 180)
      })
      return () => {
        if (timer) clearTimeout(timer)
        watcher.close()
      }
    } catch {
      // 目录不可监听（权限 / 网络盘）：热加载失效，但读写仍可用
      return () => undefined
    }
  }

  const stopWatch = startWatch()

  return {
    get: () => settings,
    update(patch) {
      const merged = normalizeSettings(mergeDeep(settings, patch))
      atomicWrite(options.settingsFile, `${JSON.stringify(merged, null, 2)}\n`)
      settings = merged
      error = null
      return merged
    },
    lastError: () => error,
    onExternalChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) stopWatch()
      }
    },
    readSession() {
      if (!existsSync(options.sessionFile)) return null
      try {
        return JSON.parse(readFileSync(options.sessionFile, 'utf8')) as unknown
      } catch {
        // 会话损坏只影响「恢复到上次状态」，不值得打扰用户
        return null
      }
    },
    writeSession(value) {
      atomicWrite(options.sessionFile, `${JSON.stringify(value, null, 2)}\n`)
    },
  }
}

/** 设置文件路径（数据目录下） */
export function settingsFilePath(dataDir: string): string {
  return join(dataDir, 'settings.json')
}

export function sessionFilePath(dataDir: string): string {
  return join(dataDir, 'session.json')
}
