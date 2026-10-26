/**
 * 文档核心逻辑（零 node 依赖）：配置解析 + 目录扫描 + 索引构建。
 *
 * 单一实现，多宿主共用：
 * - node 侧（deployer 索引刷新 / vite dev 中间件 / 校验脚本）经 fs-io-node.mjs 注入 node fs；
 * - 浏览器侧（Tauri 本地查看器 / 单文件 viewer）注入内存快照实现。
 * 因此本文件（及其 import 图：yaml / markdown-it / minisearch）不得出现任何 `node:*` 导入。
 *
 * IO 契约（同步接口，宿主各自实现）：
 *   exists(path)      → boolean
 *   readdir(path)     → Array<{ name, isDirectory(), isFile(), isSymbolicLink() }>（node Dirent 形态）；可抛
 *   readText(path)    → string（utf8）；可抛
 *   statKind(path)    → 'dir' | 'file' | null（符号链接解析目标类型；无能力返回 null）
 *
 * 产物协议与产出口径见 docs/design/平台自研壳与多宿主迁移.md 五/六。
 */
import MarkdownIt from 'markdown-it'
import MiniSearch from 'minisearch'
import { parse as yamlParse } from 'yaml'

/* ---------- posix 路径工具（Windows 盘符同为 'C:/x/y' 形态，可直接拼接） ---------- */

/** 统一的相对路径写法：POSIX 分隔、去掉首尾斜杠 */
export function toPosixPath(value) {
  return String(value)
    .replaceAll('\\', '/')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '')
}

export function joinPosix(base, child) {
  if (!base) return String(child)
  return base.endsWith('/') ? `${base}${child}` : `${base}/${child}`
}

function basenamePosix(value) {
  const parts = String(value).split('/')
  return parts[parts.length - 1] || ''
}

/* ---------- 常量 ---------- */

export const DOCS_CONFIG_FILENAME = 'docs.config.yaml'

/** 目录节点优先使用的索引文件名（按优先级） */
export const INDEX_BASENAMES = ['index.md', '索引.md', 'README.md']

const BUILTIN_EXCLUDED = new Set([
  'node_modules',
  '.git',
  '.vitepress',
  'dist',
  '.idea',
  '.pytest_cache',
  '.obsidian',
])

/** 结构性容器目录名：这些目录只用来装内容、本身没有语义，父目录有落地页时合并提升 */
const CONTAINER_DIR_NAMES = new Set(['chapters', 'chapter', 'docs', 'pages'])

/** 素材目录：不进目录树（仍在磁盘上，可被正文引用与搜索命中） */
const HIDDEN_DIR_NAMES = new Set(['snippets', 'assets'])

export function isHiddenDirName(name) {
  return HIDDEN_DIR_NAMES.has(name.toLowerCase())
}

/** 快照预载跳过判断（本地宿主载入目录时的性能优化；扫描规则本身以 BUILTIN_EXCLUDED 为准） */
export function isSkippableDirName(name) {
  return name.startsWith('.') || BUILTIN_EXCLUDED.has(name) || isHiddenDirName(name)
}

/** 无配置时给用户的最小可用模板（报错文案用） */
export function minimalConfigTemplate() {
  return [
    '最小可用 docs.config.yaml（放内容目录根）：',
    '',
    'title: 我的文档站',
    'sidebar:',
    '  - text: 文档',
    '    path: .            # 本目录整体作为一个树根',
    '    order: 10',
  ].join('\n')
}

/* ---------- 配置解析（docs.config.yaml） ---------- */

/**
 * 读取并归一化内容根配置；无 docs.config.yaml 时返回 null（调用方决定报错或回退）。
 * @param root 内容目录（POSIX 形态路径）
 * @param io 同步 IO 实现
 * @param filename 配置文件名（默认 docs.config.yaml；聚合/指定文件时可传其他名字）
 */
export function loadDocsConfig(root, io, filename = DOCS_CONFIG_FILENAME) {
  const configPath = joinPosix(root, filename)
  if (!io.exists(configPath)) return null

  const raw = yamlParse(io.readText(configPath)) ?? {}
  const sidebar = Array.isArray(raw.sidebar)
    ? raw.sidebar
        .map(entry => ({
          text: entry?.text ? String(entry.text) : '',
          path: toPosixPath(entry?.path ?? ''),
          order: Number.isFinite(entry?.order) ? entry.order : null,
          collapsed: typeof entry?.collapsed === 'boolean' ? entry.collapsed : null,
        }))
        .filter(entry => entry.path)
    : []

  // 静态目录：自包含的 HTML 站点/资源，不参与 Markdown 渲染与目录树
  const staticDirs = []
  for (const entry of Array.isArray(raw.staticDirs) ? raw.staticDirs : []) {
    const path = toPosixPath(typeof entry === 'string' ? entry : (entry?.path ?? ''))
    if (!path) continue
    if (!io.exists(joinPosix(root, path))) {
      throw new Error(`docs.config.yaml 的 staticDirs 不存在: ${path}`)
    }
    staticDirs.push(path)
  }

  return {
    // 未写 title 时留空（聚合合并据此判断「外部是否声明了标题」；最终展示回退在展示层）
    title: raw.title ? String(raw.title) : '',
    description: raw.description ? String(raw.description) : '',
    sidebar,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(toPosixPath).filter(Boolean) : [],
    staticDirs,
    nav: Array.isArray(raw.nav) ? raw.nav : [],
    deadLinks: raw.deadLinks === 'strict' ? 'strict' : 'lenient',
  }
}

/* ---------- 目录树扫描 ---------- */

/**
 * 节点类型标记：图标 + 单行标题（HTML 由扫描阶段生成、经 v-html 渲染，这里手写转义）。
 */
const MARKERS = {
  doc: '<span class="at-tree-marker" data-kind="doc"></span>',
  group: '<span class="at-tree-marker" data-kind="group"></span>',
  leaf: '<span class="at-tree-marker" data-kind="leaf"></span>',
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function nodeText(kind, label) {
  const title = escapeHtml(label)
  return `${MARKERS[kind]}<span class="at-tree-title" title="${title}">${title}</span>`
}

function isContainerDirName(markerText) {
  const name = String(markerText)
    .replace(/<[^>]*>/g, '')
    .trim()
    .toLowerCase()
  return CONTAINER_DIR_NAMES.has(name)
}

/** 排除匹配器：目录（技能/）与其下全部内容、文件（README.md）精确匹配 */
export function createExcludeMatcher(exclude = []) {
  const patterns = exclude.map(toPosixPath).filter(Boolean)
  return function isExcluded(relativePath) {
    const path = toPosixPath(relativePath)
    return patterns.some(pattern => path === pattern || path.startsWith(`${pattern}/`))
  }
}

function naturalCompare(left, right) {
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

/** 读取文档元信息：首个 H1 作标题；frontmatter 的 `order` 作自定义排序键 */
function readDocMeta(io, file) {
  try {
    const content = io.readText(file)
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null
    let order = null
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (frontmatter) {
      const match = frontmatter[1].match(/^order:\s*(-?\d+(?:\.\d+)?)\s*$/m)
      if (match) order = Number(match[1])
    }
    return { title, order }
  } catch {
    return { title: null, order: null }
  }
}

/** 排序：(order 升序, 名称自然序)；order 只影响显式声明过的节点 */
function sortNodes(nodes) {
  return [...nodes].sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      naturalCompare(left.name, right.name),
  )
}

function directoryEntries(io, dir) {
  try {
    return io.readdir(dir)
  } catch {
    return []
  }
}

/**
 * 扫描一个目录，返回 { link, items }；无任何 Markdown 时返回 null。
 * level 为当前节点层级（顶层 = 1）：顶层目录默认展开，更深层默认折叠。
 */
function scanDir(io, absDir, relDir, isExcluded) {
  if (isExcluded(relDir)) return null

  const dirs = []
  const files = []
  for (const entry of directoryEntries(io, absDir)) {
    const name = entry.name
    if (name.startsWith('.') || BUILTIN_EXCLUDED.has(name)) continue
    if (entry.isDirectory() && isHiddenDirName(name)) continue
    const childRel = relDir ? `${relDir}/${name}` : name
    if (isExcluded(childRel)) continue
    const kind = entry.isSymbolicLink()
      ? io.statKind(joinPosix(absDir, name))
      : entry.isDirectory()
        ? 'dir'
        : 'file'
    if (kind === 'dir') {
      // 目录的排序键取它自己的 index.md（若有）
      const indexName = INDEX_BASENAMES.find(candidate =>
        io.exists(joinPosix(absDir, name, candidate)),
      )
      const order = indexName ? readDocMeta(io, joinPosix(absDir, name, indexName)).order : null
      dirs.push({ name, order })
    } else if (kind === 'file' && name.endsWith('.md')) {
      const meta = readDocMeta(io, joinPosix(absDir, name))
      files.push({ name, title: meta.title, order: meta.order })
    }
  }

  const items = []

  for (const dir of sortNodes(dirs)) {
    const child = scanDir(io, joinPosix(absDir, dir.name), `${relDir}/${dir.name}`, isExcluded)
    if (!child) continue
    // 有落地页 = 可选中（文档图标）；否则纯分组（文件夹图标）
    items.push({
      text: nodeText(child.link ? 'doc' : 'group', dir.name),
      docFooterText: dir.name,
      ...(child.link ? { link: child.link } : {}),
      // 嵌套目录默认折叠；顶层由 buildDocsSidebar 决定（默认展开）
      ...(child.items.length ? { items: child.items, collapsed: true } : {}),
    })
  }

  // 落地页优先级：index.md → 索引.md → README.md
  const indexFile =
    INDEX_BASENAMES.map(name => files.find(file => file.name === name)).find(Boolean) ?? null
  const routeBase = relDir
  const dirLink = indexFile
    ? `/${[routeBase, indexFile.name.replace(/\.md$/, '')].filter(Boolean).join('/')}`
    : null

  for (const file of sortNodes(files)) {
    if (file.name === indexFile?.name) continue
    const title = file.title ?? file.name.replace(/\.md$/, '')
    items.push({
      text: nodeText('leaf', title),
      docFooterText: title,
      link: `/${[routeBase, file.name.replace(/\.md$/, '')].filter(Boolean).join('/')}`,
    })
  }

  if (!items.length && !dirLink) return null

  // 容器目录合并：目录有落地页、且可见子项只有唯一一个「没有落地页的容器子目录」时，
  // 把容器里的条目提升上来（典型：课程目录 index.md + chapters/）
  if (
    dirLink &&
    items.length === 1 &&
    !items[0].link &&
    items[0].items?.length &&
    isContainerDirName(items[0].text)
  ) {
    return { link: dirLink, items: items[0].items }
  }

  return { link: dirLink, items }
}

/**
 * 生成整站侧边栏：声明的顶层目录 → 各自的递归子树；
 * 未声明 sidebar 时自动扫描顶层目录与顶层散装 Markdown。
 */
export function buildDocsSidebar(root, config = {}, io) {
  const isExcluded = createExcludeMatcher(config?.exclude ?? [])
  const declared = Array.isArray(config?.sidebar) ? config.sidebar : []

  if (declared.length) {
    const ordered = [...declared].sort(
      (left, right) =>
        (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
        naturalCompare(left.path, right.path),
    )
    const items = []
    for (const entry of ordered) {
      // 声明为 '.'（最小模板写法）→ 指内容根本身；内存快照宿主无法解析 'root/.'（node 侧可），
      // 必须在此中心化归一，否则本地宿主扫出空树
      const relEntry = entry.path === '.' ? '' : entry.path
      const node = scanDir(io, relEntry ? joinPosix(root, relEntry) : root, relEntry, isExcluded, 1)
      if (!node) continue
      const text = entry.text || basenamePosix(relEntry) || basenamePosix(root)
      items.push({
        text: nodeText(node.link ? 'doc' : 'group', text),
        docFooterText: text,
        ...(node.link ? { link: node.link } : {}),
        ...(node.items.length ? { items: node.items, collapsed: entry.collapsed ?? false } : {}),
      })
    }
    return items
  }

  // 未声明：自动扫描顶层目录 + 顶层散装 Markdown
  const items = []
  const entries = directoryEntries(io, root)
    .filter(entry => !entry.name.startsWith('.') && !BUILTIN_EXCLUDED.has(entry.name))
    .filter(entry => !isExcluded(entry.name))
  for (const entry of entries
    .filter(entry => entry.isDirectory())
    .sort((left, right) => naturalCompare(left.name, right.name))) {
    const node = scanDir(io, joinPosix(root, entry.name), entry.name, isExcluded, 1)
    if (node) {
      items.push({
        text: nodeText(node.link ? 'doc' : 'group', entry.name),
        docFooterText: entry.name,
        ...(node.link ? { link: node.link } : {}),
        ...(node.items.length ? { items: node.items, collapsed: false } : {}),
      })
    }
  }
  const rootFiles = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .sort((left, right) => naturalCompare(left.name, right.name))
  for (const entry of rootFiles) {
    const meta = readDocMeta(io, joinPosix(root, entry.name))
    const title = meta.title ?? entry.name.replace(/\.md$/, '')
    items.push({
      text: nodeText('leaf', title),
      docFooterText: title,
      link: `/${entry.name.replace(/\.md$/, '')}`,
    })
  }
  return items
}

/* ---------- 索引构建（tree + search-index） ---------- */

/** 纯 JS 内容指纹（cyrb53 变体）：版本号只需「内容一变就变」，无需密码学强度 */
function createHasher() {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  return {
    update(str) {
      for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i)
        h1 = Math.imul(h1 ^ ch, 2654435761)
        h2 = Math.imul(h2 ^ ch, 1597334677)
      }
    },
    digest() {
      let a = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
      let b = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
      return (b >>> 0).toString(16).padStart(8, '0') + (a >>> 0).toString(16).padStart(8, '0')
    },
  }
}

/** 内容版本指纹：全部 md 的 路径+内容 摘要（同一内容 → 同一版本号，mtime 变化不影响） */
export function contentFingerprint(root, io) {
  const hasher = createHasher()
  for (const { rel, content } of collectMarkdown(io, root)) {
    hasher.update(`${rel}\0${content}\0`)
  }
  return hasher.digest().slice(0, 12)
}

/**
 * 收集内容根下全部 md（相对路径升序 + 内容）。顺序确定以保证指纹稳定；
 * 一次读取同时供指纹与搜索语料使用。exclude 规则应用与树扫描同口径
 * （README 承诺：exclude 的内容「不进站点、不进搜索」）。
 */
function collectMarkdown(io, root, isExcluded = () => false) {
  const found = []
  const walk = (dir, rel) => {
    for (const entry of directoryEntries(io, dir)) {
      const name = entry.name
      if (name.startsWith('.') || BUILTIN_EXCLUDED.has(name)) continue
      const relChild = rel ? `${rel}/${name}` : name
      if (isExcluded(relChild)) continue
      if (entry.isDirectory()) {
        walk(joinPosix(dir, name), relChild)
      } else if (entry.isFile() && name.endsWith('.md')) {
        try {
          found.push({ rel: relChild, content: io.readText(joinPosix(dir, name)) })
        } catch {
          // 单篇读失败（权限/竞态删除）不拖垮整份索引：跳过该篇，其余照常
        }
      }
    }
  }
  walk(root, '')
  return found.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0))
}

/** 正文文本化：剥 frontmatter → markdown-it 渲染 → 去标签（搜索语料） */
function extractText(md, raw) {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  let fmTitle = null
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (fm) {
    try {
      // 轻量取 title，不整份解析（容错：frontmatter 坏了标题回退 H1/文件名）
      fmTitle = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? null
    } catch {
      // frontmatter 损坏时保留 null，标题回退 H1 / 文件名
    }
  }
  const text = md
    .render(body)
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    title: fmTitle ?? body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null,
    text,
  }
}

/** 与壳 src/search.ts 同一口径：英文/数字词 + CJK 单字 */
export function tokenize(text) {
  return Array.from(text.toLowerCase().matchAll(/[a-z0-9]+|[\u4e00-\u9fff]/g)).map(m => m[0])
}

/**
 * 轻量构建：配置 + 目录树 + 内容指纹 + 文档清单（原始正文，供搜索索引用）。
 * 搜索索引（markdown-it 渲染 + MiniSearch 建索引）是耗时大头，拆给 buildSearchIndex
 * 单独构建——本地宿主在 UI 就绪后后台分片构建，装载不被阻塞（见 local-source.ts）。
 * @param root 内容根（含 docs.config.yaml）
 * @param io 同步 IO 实现
 * @param options.autoscan 无配置时是否自动扫描（本地查看器 true；发布场景 false 由调用方前置要求）
 * @returns {{ version: string, tree: object, docs: Array<{ path: string, raw: string }> }}
 */
export function buildDocsTree(root, io, options = {}) {
  const config = loadDocsConfig(root, io)
  if (!config && !options.autoscan) throw new Error(`内容根 ${root} 下没有 docs.config.yaml`)

  const isExcluded = createExcludeMatcher(config?.exclude ?? [])
  const hasher = createHasher()
  const docs = []
  for (const { rel, content } of collectMarkdown(io, root, isExcluded)) {
    hasher.update(`${rel}\0${content}\0`)
    docs.push({ path: `/${rel.replace(/\.md$/, '')}`, raw: content })
  }
  const version = hasher.digest().slice(0, 12)

  return {
    version,
    docs,
    tree: {
      version,
      title: config?.title || basenamePosix(root) || '文档',
      description: config?.description || '',
      configSource: config ? 'yaml' : 'autoscan',
      roots: buildDocsSidebar(root, config ?? {}, io),
    },
  }
}

/**
 * 搜索索引构建（重活）。chunkSize 分批并在批间让出主线程：
 * 本地宿主后台构建传小值（约 12），长任务被切成百毫秒级小片，UI 不被占住；
 * node 侧省略 chunkSize 一次建完。入口先让出一拍，保证调用方（装载流程）不被首批阻塞。
 * @param version 内容指纹（应与 tree.version 一致）
 * @param docs buildDocsTree 的文档清单（{ path, raw }）
 * @param options.chunkSize 每批文档数（>0 时批间让出主线程）
 * @param options.yield 让出主线程的实现（测试可注入）
 * @returns {Promise<{ version: string, index: object, docs: Array<{ path: string, title: string, summary: string }> }>}
 */
export async function buildSearchIndex(version, docs, options = {}) {
  const chunkSize = options.chunkSize ?? 0
  const yieldFn = options.yield ?? (() => new Promise(resolve => setTimeout(resolve, 0)))
  if (chunkSize > 0) await yieldFn()

  const md = new MarkdownIt({ html: true })
  const mini = new MiniSearch({
    idField: 'path',
    fields: ['title', 'content'],
    storeFields: ['title', 'summary'],
    tokenize,
    searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 4 } },
  })
  const metas = []
  for (let index = 0; index < docs.length; index++) {
    if (chunkSize > 0 && index > 0 && index % chunkSize === 0) await yieldFn()
    const { path, raw } = docs[index]
    const { title, text } = extractText(md, raw)
    const meta = {
      path,
      title: title ?? basenamePosix(path),
      content: text,
      summary: text.slice(0, 160),
    }
    mini.add(meta)
    metas.push({ path: meta.path, title: meta.title, summary: meta.summary })
  }
  return { version, index: mini.toJSON(), docs: metas }
}

/** 两份索引产物一次构建（node 宿主：deployer / dev 中间件 / 校验脚本）。 */
export async function buildDocsIndex(root, io, options = {}) {
  const { version, tree, docs } = buildDocsTree(root, io, options)
  const searchIndex = await buildSearchIndex(version, docs)
  return { version, tree, searchIndex }
}
