import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'

import type { PluginManifest, PluginRecord } from '@docvi/plugin-api'
import type { ErrorCode, PluginRecordView } from '@docvi/shared'
import { validateManifest } from '@docvi/plugin-runtime'

/**
 * 插件发现与状态。
 *
 * 目录约定：
 *  - 内置：`<resources>/plugins/<pack>/`（dev 下是仓库的 `plugins/<pack>/`）；
 *  - 用户：`<userData>/plugins/<id>/<version>/`（安装时按版本落位）。
 *
 * **不执行任何插件代码**：这里只读 manifest 并做形状校验。代码由渲染进程按需
 * import；主进程永远不 import 插件，这是「安装不等于执行」的边界。
 */

const MANIFEST_NAMES = ['plugin.json', 'manifest.json']

export interface PluginState {
  /** 插件 id → 是否启用；未记录的按默认（启用） */
  enabled: Record<string, boolean>
}

export interface PluginStoreOptions {
  builtinDir: string
  userDir: string
  stateFile: string
}

export interface PluginStore {
  /** 内置插件根（dev = 仓库 plugins/；打包后 = resources/plugins） */
  readonly builtinDir: string
  /** 用户插件根（`<userData>/plugins/`）：市场安装往这里落位 */
  readonly userDir: string
  list(): PluginRecord[]
  find(id: string): PluginRecord | undefined
  /** 安装一个插件目录（已校验 manifest）：复制到 userDir/<id>/<version>/ */
  install(sourceDir: string): PluginRecord
  uninstall(id: string): void
  setEnabled(id: string, enabled: boolean): PluginRecord[]
}

function fail(code: ErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function readManifest(dir: string): { raw: unknown; file: string } | null {
  for (const name of MANIFEST_NAMES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      return { raw: JSON.parse(readFileSync(file, 'utf8')), file }
    } catch {
      return { raw: null, file }
    }
  }
  return null
}

function scanDir(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => join(root, entry.name))
  } catch {
    return []
  }
}

function loadRecord(dir: string, origin: 'builtin' | 'user'): PluginRecord | null {
  const found = readManifest(dir)
  if (!found) return null
  const fallbackName = dir.split(/[/\\]/).pop() ?? 'unknown'

  if (found.raw === null) {
    return {
      manifest: {
        name: fallbackName,
        displayName: { zh: '（manifest 解析失败）' },
        version: '0.0.0',
        apiVersion: '0',
        trust: 'presentation',
      },
      origin,
      enabled: false,
      dir,
      error: `${found.file} 不是合法 JSON`,
    }
  }

  const result = validateManifest(found.raw)
  if (!result.ok) {
    const raw = found.raw as { name?: unknown; version?: unknown }
    return {
      manifest: {
        name: typeof raw.name === 'string' ? raw.name : fallbackName,
        displayName: { zh: '（manifest 校验失败）' },
        version: typeof raw.version === 'string' ? raw.version : '0.0.0',
        apiVersion: '0',
        trust: 'presentation',
      },
      origin,
      enabled: false,
      dir,
      error: result.errors.join('；'),
    }
  }

  return {
    manifest: result.manifest,
    origin,
    enabled: true,
    dir,
    error: null,
  }
}

function readState(file: string): PluginState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PluginState>
    return {
      enabled: raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {},
    }
  } catch {
    return { enabled: {} }
  }
}

function writeState(file: string, state: PluginState): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dest)
    else if (entry.isFile()) copyFileSync(src, dest)
  }
}

/** semver 粗比较：只用于「同一插件的多个版本目录选最新」，不追求完整语义 */
function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value.split(/[.+-]/).map(part => {
      const num = Number(part)
      return Number.isFinite(num) ? num : 0
    })
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 把「包目录」解析成真正的 manifest 目录。
 *
 * 两种布局都要支持：
 *  - 扁平（开发态仓库 `plugins/<pack>/plugin.json`）；
 *  - 带版本层（安装后的用户插件 `plugins/<pack>/<version>/plugin.json`）。
 * 有版本层时取版本号最大的，避免同包多版本被重复收录。
 */
function resolvePackDir(dir: string): string | null {
  if (readManifest(dir)) return dir
  const versions = scanDir(dir)
  if (!versions.length) return null
  const candidates = versions.filter(version => readManifest(version) !== null)
  if (!candidates.length) return null
  return (
    candidates.sort((a, b) => {
      const versionOf = (target: string): string => {
        const raw = readManifest(target)?.raw as { version?: unknown } | null
        return typeof raw?.version === 'string' ? raw.version : '0.0.0'
      }
      return compareVersions(versionOf(b), versionOf(a))
    })[0] ?? null
  )
}

export function createPluginStore(options: PluginStoreOptions): PluginStore {
  const state = readState(options.stateFile)

  /** 每次操作后重扫：插件目录是外部可变的（用户手动放进去也算） */
  const scanAll = (): PluginRecord[] => {
    const records: PluginRecord[] = []
    const seen = new Set<string>()

    for (const packDir of scanDir(options.builtinDir)) {
      const dir = resolvePackDir(packDir)
      if (!dir) continue
      const record = loadRecord(dir, 'builtin')
      if (!record || seen.has(record.manifest.name)) continue
      seen.add(record.manifest.name)
      records.push(record)
    }

    // 用户插件：目录层级 <id>/<version>/，取版本号最大的
    for (const idDir of scanDir(options.userDir)) {
      const versions = scanDir(idDir).filter(dir => {
        try {
          return statSync(dir).isDirectory()
        } catch {
          return false
        }
      })
      const record = versions
        .map(dir => loadRecord(dir, 'user'))
        .filter((item): item is PluginRecord => item !== null)
        .sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0]
      if (!record || seen.has(record.manifest.name)) continue
      seen.add(record.manifest.name)
      records.push(record)
    }

    for (const record of records) {
      const override = state.enabled[record.manifest.name]
      record.enabled = record.error ? false : (override ?? true)
      // 逐组件停用：保留清单原样（面板要能列出并重新启用），另挂一份停用列表
    }
    return records.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  }

  const persist = (): void => writeState(options.stateFile, state)

  return {
    builtinDir: options.builtinDir,
    userDir: options.userDir,
    list: scanAll,
    find: id => scanAll().find(record => record.manifest.name === id),
    install(sourceDir) {
      const record = loadRecord(sourceDir, 'user')
      if (!record) throw fail('E_INVALID', '该目录下没有 plugin.json / manifest.json')
      if (record.error) throw fail('E_INVALID', `manifest 校验失败：${record.error}`)
      const target = join(options.userDir, record.manifest.name, record.manifest.version)
      copyDir(sourceDir, target)
      state.enabled[record.manifest.name] = true
      persist()
      return { ...record, enabled: true, dir: target }
    },
    uninstall(id) {
      const record = scanAll().find(item => item.manifest.name === id)
      if (!record) throw fail('E_NOT_FOUND', '插件不存在')
      if (record.origin === 'builtin') throw fail('E_FORBIDDEN', '内置插件不可卸载，只能停用')
      const dir = join(options.userDir, id)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      delete state.enabled[id]
      persist()
    },
    setEnabled(id, enabled) {
      const record = scanAll().find(item => item.manifest.name === id)
      if (!record) throw fail('E_NOT_FOUND', '插件不存在')
      state.enabled[id] = enabled
      persist()
      return scanAll()
    },
  }
}

/**
 * 把插件包内相对路径解析为绝对路径，并确认仍在插件目录内。
 *
 * 协议处理器用它服务 `docvi://plugin/<id>/<file>`：
 * 插件可以在自己的 dist 里引用任意资源，但绝不能读到包外。
 *
 * 两道判定：规范化后仍在包内（挡 `..`），以及 **realpath 后再判一次**
 * （挡住「包内放一个软链接指向包外」——字符串前缀对软链接无效）。
 * 只返回普通文件；目录与设备文件不伺服。
 */
export function resolvePluginAsset(pluginDir: string, relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null
  let base: string
  try {
    base = realpathSync(resolve(pluginDir))
  } catch {
    return null
  }
  const target = resolve(base, relPath)
  if (target !== base && !target.startsWith(base + sep)) return null
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return null
  }
  if (real !== base && !real.startsWith(base + sep)) return null
  try {
    if (!statSync(real).isFile()) return null
  } catch {
    return null
  }
  return real
}

/**
 * 把内部记录转成跨进程视图。
 *
 * `dir` 要给渲染进程：插件资源走 `docvi://plugin/<id>/...`，渲染层只知道 id
 * 与相对路径，绝对路径只在主进程内部用于路径校验（不暴露给内容层）。
 */
export function toView(record: PluginRecord): PluginRecordView {
  const { manifest } = record
  return {
    name: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    ...(manifest.description ? { description: manifest.description } : {}),
    trust: manifest.trust,
    ...(manifest.entry ? { entry: manifest.entry } : {}),
    ...(manifest.styles ? { styles: manifest.styles } : {}),
    ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
    ...(manifest.contributes ? { contributes: manifest.contributes } : {}),
    origin: record.origin,
    enabled: record.enabled,
    dir: record.dir,
    error: record.error,
  }
}

export type { PluginManifest }
