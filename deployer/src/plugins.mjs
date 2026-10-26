/**
 * 插件包服务（协议 v1，设计见 docs/design/平台插件化与 AI 分发.md）：
 * - 预设包：<platformDir>/plugins/<目录>（镜像内 /app/plugins/，随平台版本；可禁用不可卸载）
 * - 第三方包：<dataDir>/plugins/<name>/<version>/（数据卷；url: 渠道安装）
 * - 登记：config.yaml 的 plugins 段（enabled / disabledComponents / source / version）
 *
 * 同名切换（R7「最新者赢」）：安装 / 启用即激活新实现——把其他 enabled 插件里
 * 同 kind 的活跃组件写入对方 disabledComponents 并回报 replaced[]；手动启用手感
 * 相同（UI 侧确认由 portal 弹窗完成，API 直接执行）。
 *
 * 安全口径：平台永不执行包内脚本；下载限制大小；解压限制条目数与总量；
 * 文件名唯一真源是 plugin.json（与包目录名、URL 无关）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { extract } from 'tar'
import { audit } from './store.mjs'

/** 宿主 API 大版本（与 packages/plugin-runtime/src/manifest.ts 的 API_VERSION 对齐） */
export const PLUGIN_API_VERSION = '1'

/** 下载与解压限制（防 zip 炸弹与超大包） */
const DOWNLOAD_LIMIT = 50 * 1024 * 1024
const UNPACK_LIMIT = 200 * 1024 * 1024
const UNPACK_MAX_FILES = 5000

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const KIND_RE = /^[a-z][a-z0-9-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
/** 语言键（本地化字段的对象形态）：BCP47 简化——主语言 2-3 字母，可带 - 区域 */
const LANG_KEY_RE = /^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/

export class PluginError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/**
 * 本地化字符串校验：`string`（全语言通用）或 `{ [lang]: string }` 语言映射
 * （语言键形如 zh / zh-CN / en；至少一个值）。返回规范化文本用于必填判定。
 */
function validateLocalized(value, label) {
  if (typeof value === 'string') {
    if (!value.trim()) throw new PluginError('MANIFEST_INVALID', `${label} 不能为空字符串`)
    return value
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
    if (!entries.length) throw new PluginError('MANIFEST_INVALID', `${label} 语言映射不能为空`)
    for (const [lang, text] of entries) {
      if (!LANG_KEY_RE.test(lang)) {
        throw new PluginError(
          'MANIFEST_INVALID',
          `${label} 语言键非法（应为 zh / zh-CN / en 形态）：${lang}`,
        )
      }
      if (typeof text !== 'string' || !text.trim()) {
        throw new PluginError('MANIFEST_INVALID', `${label}.${lang} 必须为非空字符串`)
      }
    }
    return Object.values(value)[0]
  }
  throw new PluginError('MANIFEST_INVALID', `${label} 必须为字符串或语言映射对象`)
}

/** 读包清单并校验协议必填项（安装时调用；运行时不重复校验） */
export function readPluginManifest(pkgRoot) {
  const manifestPath = join(pkgRoot, 'plugin.json')
  let raw
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new PluginError('MANIFEST_INVALID', `plugin.json 缺失或不是合法 JSON：${error.message}`)
  }
  for (const key of ['name', 'displayName', 'version', 'apiVersion', 'entry', 'docs']) {
    if (!raw[key]) throw new PluginError('MANIFEST_INVALID', `plugin.json 缺必填字段：${key}`)
  }
  // 本地化字段（协议 v1.1）：displayName / description 支持 string 或语言映射
  validateLocalized(raw.displayName, 'displayName')
  if (raw.description !== undefined) validateLocalized(raw.description, 'description')
  if (!NAME_RE.test(raw.name)) {
    throw new PluginError('MANIFEST_INVALID', `name 必须为 [a-z0-9-]：[${raw.name}]`)
  }
  if (!VERSION_RE.test(raw.version)) {
    throw new PluginError('MANIFEST_INVALID', `version 必须为 semver：[${raw.version}]`)
  }
  if (raw.apiVersion !== PLUGIN_API_VERSION) {
    throw new PluginError(
      'API_VERSION_MISMATCH',
      `插件 apiVersion=${raw.apiVersion}，宿主为 ${PLUGIN_API_VERSION}——版本不匹配拒装（协议 v1）`,
    )
  }
  // 两代清单形状并存：早期预设包把 components 挂顶层，新协议放进 contributes。
  // 归一化只做一次，下游（目录 / 示例解析 / 安装校验）永远读顶层。
  const components = raw.contributes?.components ?? raw.components
  if (!Array.isArray(components) || !components.length) {
    throw new PluginError('MANIFEST_INVALID', 'components[] 必须为非空数组')
  }
  for (const item of components) {
    for (const key of ['kind', 'title', 'description']) {
      if (!item?.[key])
        throw new PluginError('MANIFEST_INVALID', `组件 ${item?.kind ?? '?'} 缺 ${key}`)
    }
    validateLocalized(item.title, `组件 ${item.kind} 的 title`)
    validateLocalized(item.description, `组件 ${item.kind} 的 description`)
    if (!KIND_RE.test(item.kind)) {
      throw new PluginError('MANIFEST_INVALID', `kind 必须为 [a-z][a-z0-9-]*：[${item.kind}]`)
    }
  }
  const kindSet = new Set(components.map(c => c.kind))
  if (kindSet.size !== components.length) {
    throw new PluginError('MANIFEST_INVALID', 'components[] 存在重复 kind')
  }
  // 越界判定用规范化后的绝对路径：pkgRoot 可能是相对路径或正斜杠形态（Windows
  // 下 join 会给出反斜杠），直接 startsWith 字符串比较会把合法文件误判成越界。
  const rootAbs = resolve(pkgRoot)
  for (const rel of [raw.entry, raw.docs, ...(raw.styles ?? [])]) {
    const file = resolve(rootAbs, rel)
    if (!file.startsWith(rootAbs + sep) || !existsSync(file) || !statSync(file).isFile()) {
      throw new PluginError('MANIFEST_INVALID', `清单声明的文件不存在：${rel}`)
    }
  }
  return {
    ...raw,
    components,
    // 贡献点也在这一层摊平：读者面目录要下发主题 / 语法扩展，宿主不必再读两套形状
    themes: raw.contributes?.themes ?? raw.themes ?? [],
    markdownSyntax: raw.contributes?.markdownSyntax ?? raw.markdownSyntax ?? [],
  }
}

/**
 * 组件示例解析（协议 v1.1 可选字段）：`example` 指向包内示例 markdown
 * （frontmatter components + `<at-kind>` 标签，供运维面板「预览」整页渲染）。
 * 未声明返回 null；声明了但文件不存在 / 越界 / 组件不在清单里则抛错。
 */
export function resolveExample(pkgRoot, manifest, kind) {
  const item = (manifest.components ?? []).find(c => c.kind === kind)
  if (!item) throw new PluginError('NOT_FOUND', `插件 ${manifest.name} 未声明组件：${kind}`, 404)
  const rel = item.example
  if (!rel) return null
  const rootAbs = resolve(pkgRoot)
  const file = resolve(rootAbs, rel)
  if (!file.startsWith(rootAbs + sep) || !existsSync(file) || !statSync(file).isFile()) {
    throw new PluginError('EXAMPLE_MISSING', `组件 ${kind} 的示例文件不存在：${rel}`, 404)
  }
  return file
}

/** 下载（纯 HTTPS；可选 Bearer 凭证）→ 写盘；带大小上限。fetchImpl 供测试注入 */
async function downloadTarball(url, destFile, credential, fetchImpl = fetch) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new PluginError('SOURCE_INVALID', `来源不是合法 URL：${url}`)
  }
  if (parsed.protocol !== 'https:') {
    throw new PluginError('SOURCE_INVALID', '安装来源必须为 https（纯 HTTPS 渠道）')
  }
  const headers = {}
  if (credential) headers.Authorization = `Bearer ${credential}`
  const res = await fetchImpl(url, { headers, redirect: 'follow' })
  if (!res.ok) {
    throw new PluginError('DOWNLOAD_FAILED', `下载失败：HTTP ${res.status}（${url}）`, 502)
  }
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > DOWNLOAD_LIMIT) {
    throw new PluginError('TOO_LARGE', `包体积超上限（content-length=${length}）`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > DOWNLOAD_LIMIT) {
    throw new PluginError('TOO_LARGE', `包体积超上限（${buf.length} > ${DOWNLOAD_LIMIT}）`)
  }
  writeFileSync(destFile, buf)
  return buf.length
}

/** 解压（条目数与总大小限制）→ 返回包根目录（剥顶层单目录或直接根） */
async function unpackTarball(tgzFile, destDir) {
  mkdirSync(destDir, { recursive: true })
  let files = 0
  let bytes = 0
  await extract({
    file: tgzFile,
    cwd: destDir,
    filter: (path, entry) => {
      files += 1
      bytes += entry.size ?? 0
      if (files > UNPACK_MAX_FILES) throw new PluginError('TOO_MANY_FILES', '解压条目数超上限')
      if (bytes > UNPACK_LIMIT) throw new PluginError('TOO_LARGE', '解压后总体积超上限')
      return true
    },
  })
  if (existsSync(join(destDir, 'plugin.json'))) return destDir
  const entries = readdirSync(destDir).filter(name => name !== '.' && name !== '..')
  if (entries.length === 1 && existsSync(join(destDir, entries[0], 'plugin.json'))) {
    return join(destDir, entries[0])
  }
  throw new PluginError(
    'PACKAGE_LAYOUT',
    '包根未找到 plugin.json（tarball 应为「内容在根」或「单顶层目录包内容」）',
  )
}

export function createPluginsService({
  dataDir,
  platformDir,
  loadConfigData,
  saveConfigData,
  version,
  fetchImpl = fetch,
}) {
  const builtinDir = join(platformDir, 'plugins')
  const thirdPartyDir = join(dataDir, 'plugins')
  const tmpRoot = join(dataDir, 'plugins-tmp')

  const readConfig = () => {
    const cfg = loadConfigData() ?? { repos: [] }
    return { ...cfg, plugins: cfg.plugins ?? [] }
  }
  const writeConfig = cfg => saveConfigData(cfg)

  /** 预设包清单（目录名 → manifest；非法包跳过并返回诊断） */
  function listBuiltin() {
    const out = []
    if (!existsSync(builtinDir)) return out
    for (const name of readdirSync(builtinDir)) {
      const root = join(builtinDir, name)
      if (!existsSync(join(root, 'plugin.json'))) continue
      try {
        out.push({ dirName: name, root, manifest: readPluginManifest(root) })
      } catch (error) {
        out.push({ dirName: name, root, broken: error.message })
      }
    }
    return out
  }

  /** config 条目（缺省补齐；预设包无条目 = enabled） */
  function entryFor(cfg, name) {
    return cfg.plugins.find(p => p.name === name) ?? null
  }

  /**
   * 构建指纹：入口与样式文件的「大小 + 修改时间」摘要（与 packages/server 同口径）。
   *
   * 插件资产 URL 只带版本号，服务端却按「版本在 URL 里 → 内容不可变」给了一年
   * immutable 缓存；同版本改内容（如 0.1.0 修组件样式）会让老浏览器一直用旧包。
   * 指纹随内容变化，壳拼 `?v=<指纹>` 让缓存键跟着走，路径段保持不变。
   */
  function buildStamp(root, manifest) {
    const files = [manifest?.entry, ...(manifest?.styles ?? [])].filter(Boolean)
    const parts = []
    for (const rel of files) {
      try {
        const stat = statSync(join(root, rel))
        parts.push(`${rel}:${stat.size}:${Math.round(stat.mtimeMs)}`)
      } catch {
        parts.push(`${rel}:missing`)
      }
    }
    if (!parts.length) return ''
    let hash = 0
    for (const ch of parts.join('|')) {
      hash = (hash * 31 + ch.codePointAt(0)) | 0
    }
    return Math.abs(hash).toString(36)
  }

  function upsertEntry(cfg, patch) {
    const existing = entryFor(cfg, patch.name)
    if (existing) Object.assign(existing, patch)
    else cfg.plugins.push(patch)
  }

  /** 某插件声明的 kind 集（找不到 manifest 时为空集） */
  function kindsOf(cfg, name) {
    const builtin = listBuiltin().find(p => p.manifest?.name === name)
    if (builtin) return new Set(builtin.manifest.components.map(c => c.kind))
    const entry = entryFor(cfg, name)
    if (!entry) return new Set()
    const root = join(thirdPartyDir, name, entry.version)
    if (!existsSync(join(root, 'plugin.json'))) return new Set()
    try {
      return new Set(readPluginManifest(root).components.map(c => c.kind))
    } catch {
      return new Set()
    }
  }

  /**
   * 登记「name 的 kinds 为活跃」：把其他 enabled 插件同 kind 的活跃组件写入其
   * disabledComponents（最新者赢）；同时把 name 自身这些 kind 从停用清单移除。
   * 返回被替换项 [`<其他包>/<kind>`, …]。
   */
  function activateKinds(cfg, name, kinds) {
    const replaced = []
    for (const other of cfg.plugins) {
      if (other.name === name || !other.enabled) continue
      const otherKinds = kindsOf(cfg, other.name)
      const disabled = other.disabledComponents ?? []
      let changed = false
      for (const kind of kinds) {
        if (otherKinds.has(kind) && !disabled.includes(kind)) {
          disabled.push(kind)
          replaced.push(`${other.name}/${kind}`)
          changed = true
        }
      }
      if (changed) other.disabledComponents = disabled
    }
    // 预设包无条目也参与同名判定（缺省 enabled）
    for (const builtin of listBuiltin()) {
      const bName = builtin.manifest?.name
      if (!bName || bName === name) continue
      const entry = entryFor(cfg, bName)
      if (entry && !entry.enabled) continue
      const disabled = entry?.disabledComponents ?? []
      const bKinds = new Set((builtin.manifest.components ?? []).map(c => c.kind))
      let changed = false
      for (const kind of kinds) {
        if (bKinds.has(kind) && !disabled.includes(kind)) {
          disabled.push(kind)
          replaced.push(`${bName}/${kind}`)
          changed = true
        }
      }
      if (changed) {
        upsertEntry(cfg, {
          name: bName,
          source: `builtin:${builtin.dirName}`,
          version: builtin.manifest.version,
          enabled: entry?.enabled ?? true,
          builtin: true,
          disabledComponents: disabled,
        })
      }
    }
    const self = entryFor(cfg, name)
    if (self) self.disabledComponents = (self.disabledComponents ?? []).filter(k => !kinds.has(k))
    return replaced
  }

  /** 公开目录（GET /api/plugins）：全部已安装插件（enabled / disabledComponents 标志随附） */
  function catalog() {
    const cfg = readConfig()
    const plugins = []
    const builtins = listBuiltin()
    const builtinNames = new Set(builtins.map(b => b.manifest?.name))
    for (const item of builtins) {
      if (!item.manifest) {
        plugins.push({
          name: item.dirName,
          displayName: item.dirName,
          version: '0.0.0',
          apiVersion: PLUGIN_API_VERSION,
          enabled: false,
          builtin: true,
          broken: item.broken,
          baseUrl: '',
          entry: '',
          styles: [],
          disabledComponents: [],
          components: [],
        })
        continue
      }
      const entry = entryFor(cfg, item.manifest.name)
      plugins.push({
        name: item.manifest.name,
        displayName: item.manifest.displayName,
        version: item.manifest.version,
        apiVersion: item.manifest.apiVersion,
        enabled: entry?.enabled ?? true,
        builtin: true,
        baseUrl: `/plugins/${item.manifest.name}/${item.manifest.version}/`,
        entry: item.manifest.entry,
        styles: item.manifest.styles ?? [],
        build: buildStamp(item.root, item.manifest),
        disabledComponents: entry?.disabledComponents ?? [],
        components: item.manifest.components,
        themes: item.manifest.themes ?? [],
        markdownSyntax: item.manifest.markdownSyntax ?? [],
      })
    }
    for (const entry of cfg.plugins) {
      if (entry.builtin || builtinNames.has(entry.name)) continue
      const root = join(thirdPartyDir, entry.name, entry.version)
      if (!existsSync(join(root, 'plugin.json'))) {
        plugins.push({
          name: entry.name,
          displayName: entry.name,
          version: entry.version,
          apiVersion: PLUGIN_API_VERSION,
          enabled: false,
          builtin: false,
          broken: '包目录缺失（数据卷被清理？重新安装可恢复）',
          baseUrl: `/plugins/${entry.name}/${entry.version}/`,
          entry: '',
          styles: [],
          disabledComponents: entry.disabledComponents ?? [],
          components: [],
        })
        continue
      }
      const manifest = readPluginManifest(root)
      plugins.push({
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version,
        apiVersion: manifest.apiVersion,
        enabled: entry.enabled,
        builtin: false,
        baseUrl: `/plugins/${manifest.name}/${manifest.version}/`,
        entry: manifest.entry,
        styles: manifest.styles ?? [],
        build: buildStamp(root, manifest),
        disabledComponents: entry.disabledComponents ?? [],
        components: manifest.components,
        themes: manifest.themes ?? [],
        markdownSyntax: manifest.markdownSyntax ?? [],
      })
    }
    return { apiVersion: PLUGIN_API_VERSION, platformVersion: version, plugins }
  }

  /** 活跃实现表（MCP / 诊断用；每 kind 至多一条——双活跃按无活跃 + 诊断处理） */
  function activeKinds() {
    const byKind = new Map()
    for (const plugin of catalog().plugins) {
      if (!plugin.enabled || !plugin.components?.length) continue
      for (const item of plugin.components) {
        if ((plugin.disabledComponents ?? []).includes(item.kind)) continue
        const list = byKind.get(item.kind) ?? []
        list.push({ plugin: plugin.name, ...item })
        byKind.set(item.kind, list)
      }
    }
    const active = []
    const conflicts = []
    for (const [kind, list] of byKind) {
      if (list.length === 1) active.push(list[0])
      else conflicts.push({ kind, implementations: list.map(x => x.plugin) })
    }
    return { active, conflicts }
  }

  /** 文件伺服（防穿越）：预设查镜像目录；第三方查数据卷版本目录。版本与清单不符即 404 */
  function resolvePluginFile(name, version, relPath) {
    if (!NAME_RE.test(name) || !relPath) return null
    const builtin = listBuiltin().find(p => p.manifest?.name === name)
    let root = null
    if (builtin && builtin.manifest.version === version) root = builtin.root
    if (!root) {
      const entry = entryFor(readConfig(), name)
      if (entry && !entry.builtin && entry.version === version) {
        const candidate = join(thirdPartyDir, name, version)
        if (existsSync(join(candidate, 'plugin.json'))) root = candidate
      }
    }
    if (!root) return null
    const file = resolve(root, relPath)
    if (!file.startsWith(root + sep)) return null
    if (!existsSync(file) || !statSync(file).isFile()) return null
    return file
  }

  /** 定位插件包根（预设优先；第三方按登记版本）——示例解析、MCP 文档取数与文件伺服共用来源策略 */
  function findPluginRoot(name) {
    const builtin = listBuiltin().find(p => p.manifest?.name === name)
    if (builtin) return { root: builtin.root, manifest: builtin.manifest }
    const entry = entryFor(readConfig(), name)
    if (entry && !entry.builtin) {
      const root = join(thirdPartyDir, name, entry.version)
      if (existsSync(join(root, 'plugin.json'))) {
        try {
          return { root, manifest: readPluginManifest(root) }
        } catch {
          return null
        }
      }
    }
    return null
  }

  /** 组件示例文件（协议 v1.1）：未声明 example 返回 null；声明但缺失抛出明确错误 */
  function resolveComponentExample(name, kind) {
    if (!NAME_RE.test(name) || !KIND_RE.test(kind)) {
      throw new PluginError('NOT_FOUND', `插件或组件不存在：${name}/${kind}`, 404)
    }
    const found = findPluginRoot(name)
    if (!found) throw new PluginError('NOT_FOUND', `插件不存在：${name}`, 404)
    return resolveExample(found.root, found.manifest, kind)
  }

  /**
   * 安装（url: 渠道；npm:/git: 为阶段二渠道——解析器在此预留）。
   * 返回 { installed, replaced }：installed 为落盘清单；replaced 为被停用的原活跃实现。
   */
  async function install({ source, credential = '', enabled = true }) {
    if (!source || typeof source !== 'string') {
      throw new PluginError('SOURCE_INVALID', 'source 必填（url:https://…#0.1.0.tar.gz）')
    }
    const channel = source.includes(':') ? source.slice(0, source.indexOf(':')) : ''
    if (channel === 'npm' || channel === 'git') {
      throw new PluginError(
        'CHANNEL_STAGE2',
        `${channel}: 渠道为阶段二交付（当前支持 url: 直链——npm / git 解析后同样落在纯 HTTPS 下载）`,
      )
    }
    if (channel !== 'url') {
      throw new PluginError('SOURCE_INVALID', 'source 形如 url:https://…/pkg.tar.gz')
    }
    const url = source.slice('url:'.length)
    const tmp = join(tmpRoot, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const tgz = join(tmp, 'package.tar.gz')
    mkdirSync(tmp, { recursive: true })
    try {
      await downloadTarball(url, tgz, credential, fetchImpl)
      const pkgRoot = await unpackTarball(tgz, join(tmp, 'unpack'))
      const manifest = readPluginManifest(pkgRoot)

      const builtinNames = new Set(
        listBuiltin()
          .map(b => b.manifest?.name)
          .filter(Boolean),
      )
      if (builtinNames.has(manifest.name)) {
        throw new PluginError(
          'BUILTIN_NAME_CONFLICT',
          `name 与预设包同名（${manifest.name}）——预设包不可被第三方覆盖，请换包名（惯例加发布者前缀）`,
          409,
        )
      }
      const cfg = readConfig()
      const destRoot = join(thirdPartyDir, manifest.name)
      const dest = join(destRoot, manifest.version)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(destRoot, { recursive: true })
      renameSync(pkgRoot, dest)
      // 清理旧版本目录（更新语义：新版本就绪后切指针并清理旧版本）
      for (const old of existsSync(destRoot) ? readdirSync(destRoot) : []) {
        if (old !== manifest.version) rmSync(join(destRoot, old), { recursive: true, force: true })
      }

      const kinds = new Set(manifest.components.map(c => c.kind))
      upsertEntry(cfg, {
        name: manifest.name,
        source,
        version: manifest.version,
        enabled: Boolean(enabled),
        builtin: false,
        disabledComponents: [],
      })
      const replaced = enabled ? activateKinds(cfg, manifest.name, kinds) : []
      writeConfig(cfg)
      audit(dataDir, {
        type: 'plugin.install',
        name: manifest.name,
        version: manifest.version,
        source,
        replaced,
      })
      return {
        installed: { name: manifest.name, version: manifest.version, builtin: false },
        replaced,
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  /** 插件级启停；启用引入同名实现时原子切换（replaced 报告） */
  function setPluginEnabled(name, enabled) {
    const cfg = readConfig()
    const builtin = listBuiltin().find(p => p.manifest?.name === name)
    const entry = entryFor(cfg, name)
    if (!builtin && !entry) throw new PluginError('NOT_FOUND', `插件不存在：${name}`, 404)
    const version = builtin ? builtin.manifest.version : entry.version
    upsertEntry(cfg, {
      name,
      source: entry?.source ?? (builtin ? `builtin:${builtin.dirName}` : ''),
      version,
      enabled: Boolean(enabled),
      builtin: Boolean(builtin),
      disabledComponents: entry?.disabledComponents ?? [],
    })
    let replaced = []
    if (enabled) {
      const kinds = builtin
        ? new Set(builtin.manifest.components.map(c => c.kind))
        : kindsOf(cfg, name)
      replaced = activateKinds(cfg, name, kinds)
    }
    writeConfig(cfg)
    audit(dataDir, { type: enabled ? 'plugin.enable' : 'plugin.disable', name, replaced })
    return { ok: true, replaced }
  }

  /** 组件级启停与同名切换（UI 侧确认由 portal 完成；API 直接执行） */
  function setComponentEnabled(name, kind, enabled) {
    const cfg = readConfig()
    const kinds = kindsOf(cfg, name)
    const builtin = listBuiltin().find(p => p.manifest?.name === name)
    const entry = entryFor(cfg, name)
    if (!builtin && !entry) throw new PluginError('NOT_FOUND', `插件不存在：${name}`, 404)
    if (!kinds.has(kind))
      throw new PluginError('NOT_FOUND', `插件 ${name} 未声明组件：${kind}`, 404)
    if (!entry) {
      upsertEntry(cfg, {
        name,
        source: `builtin:${builtin.dirName}`,
        version: builtin.manifest.version,
        enabled: true,
        builtin: true,
        disabledComponents: [],
      })
    }
    const self = entryFor(cfg, name)
    const disabled = new Set(self.disabledComponents ?? [])
    let replaced = []
    if (enabled) {
      disabled.delete(kind)
      self.disabledComponents = [...disabled]
      replaced = activateKinds(cfg, name, new Set([kind]))
    } else {
      disabled.add(kind)
      self.disabledComponents = [...disabled]
    }
    writeConfig(cfg)
    audit(dataDir, {
      type: enabled ? 'plugin.component.enable' : 'plugin.component.disable',
      name,
      kind,
      replaced,
    })
    return { ok: true, replaced }
  }

  /** 卸载（预设包拒绝；第三方包：删目录 + 清登记） */
  function uninstall(name) {
    const builtin = listBuiltin().find(p => p.manifest?.name === name)
    if (builtin) {
      throw new PluginError('BUILTIN', `预设包不可卸载（${name}）——可禁用`, 403)
    }
    const cfg = readConfig()
    const entry = entryFor(cfg, name)
    if (!entry) throw new PluginError('NOT_FOUND', `插件不存在：${name}`, 404)
    rmSync(join(thirdPartyDir, name), { recursive: true, force: true })
    cfg.plugins = cfg.plugins.filter(p => p.name !== name)
    writeConfig(cfg)
    audit(dataDir, { type: 'plugin.uninstall', name })
    return { ok: true }
  }

  /** 运维全量状态（token 视图；公开目录 = catalog() 本身——标志字段已随附） */
  function opsStatus() {
    const { active, conflicts } = activeKinds()
    const catalogData = catalog()
    // 运维视图附安装来源（公开目录不外泄 source——只给 token 视图）
    const cfg = readConfig()
    for (const plugin of catalogData.plugins) {
      const entry = entryFor(cfg, plugin.name)
      if (entry?.source && !plugin.builtin) plugin.sourceLabel = `来源：${entry.source}`
    }
    return {
      catalog: catalogData,
      active,
      conflicts,
      dataDir,
      builtinDir,
    }
  }

  return {
    catalog,
    activeKinds,
    opsStatus,
    resolvePluginFile,
    resolveComponentExample,
    findPluginRoot,
    install,
    setPluginEnabled,
    setComponentEnabled,
    uninstall,
  }
}
