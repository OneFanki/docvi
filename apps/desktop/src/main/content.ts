import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

import type { DocPayload, SearchCorpus, SearchDoc, TreeNode, TreeSortMode } from '@docvi/shared'

import { readConfig, CONFIG_FILENAME } from './config.ts'

/**
 * 内容访问层：目录扫描与文档读取。
 *
 * 扫描口径沿用旧平台（`scripts/lib/docs-core.mjs`）已验证的规则，保证同一批
 * 内容在新旧宿主里呈现同样的树形：
 *  - 排除 `node_modules` / `.git` / `dist` / 点开头目录；
 *  - `snippets` / `assets` 是素材目录，不进树（正文仍可引用）；
 *  - 落地页优先级 index.md → 索引.md → README.md；
 *  - 排序默认 = frontmatter `order` 升序，其次名称自然序（zh-CN, numeric）；
 *    工作区可切到 mtime 模式（修改时间倒序），见 `TreeSortMode`。
 */

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vitepress',
  'dist',
  '.idea',
  '.pytest_cache',
  '.obsidian',
])

const HIDDEN_DIRS = new Set(['snippets', 'assets'])

const INDEX_BASENAMES = ['index.md', '索引.md', 'README.md']

const CONTAINER_DIRS = new Set(['chapters', 'chapter', 'docs', 'pages'])

/** 单文档上限：超过直接拒绝，避免把 200MB 文件读进主进程内存 */
const MAX_DOC_BYTES = 20 * 1024 * 1024

const MAX_DEPTH = 16

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

function isDirExcluded(name: string): boolean {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name) || HIDDEN_DIRS.has(name)
}

/**
 * 目录监视用：这个相对路径的变化会不会影响内容（树 / 搜索语料）。
 *
 * 扫描时本来就把 `.git` / `node_modules` / 点开头目录排除在外；监视器必须用同一份
 * 规则过滤，否则 `git status` 刷新 `.git/index`、`git checkout` 写对象库都会被当成
 * 「内容变了」，每隔几百毫秒就整树重扫 + 重建一次搜索索引。
 *
 * 末段单独处理：监听到的路径无法区分「目录」与「文件」，而 `.hidden.md` 是合法
 * 文档（`isDirExcluded` 的「点开头」只该作用于目录），所以末段只按精确的目录名排除。
 *
 * 空路径表示平台没给文件名（目录被整体替换等），保守上报。
 */
export function isContentRelPath(relPath: string): boolean {
  const segments = relPath.split('/').filter(Boolean)
  if (!segments.length) return true
  if (segments.slice(0, -1).some(isDirExcluded)) return false
  const last = segments[segments.length - 1] ?? ''
  return !EXCLUDED_DIRS.has(last) && !HIDDEN_DIRS.has(last)
}

interface RawNode {
  name: string
  type: 'dir' | 'doc'
  order: number | null
  /**
   * 修改时间（毫秒）。mtime 排序用；读不到时为 0（排到最后）。
   *
   * 目录取它自己的 stat.mtime——目录项里新增/删除文件会更新它，
   * 正好对应「这个文件夹最近有动静」的直觉。
   */
  mtime: number
  landing?: string
  children: RawNode[]
  relPath: string
}

/** 读首个 H1 与 frontmatter order（只读文件头，大文件不做全文解析） */
/**
 * 目录树只需要 Markdown 开头的元信息：frontmatter 的 `order` 决定同层排序。
 *
 * 读前 4KB 而不是整篇：目录变化现在会自动触发重扫（AI 写文件、每次保存都会
 * 落一批事件），整篇读盘会让扫描成本随「库里的总字数」而不是「文档数」增长——
 * 一个夹着几篇大文档的库，保存一次就要读几十 MB 只为取一个 order。
 */
const META_HEAD_BYTES = 4096

/** 文件/目录的修改时间（毫秒）；读不到给 0，mtime 排序时落到最后 */
function mtimeOf(absPath: string): number {
  try {
    return statSync(absPath).mtimeMs
  } catch {
    return 0
  }
}

function readDocMeta(absPath: string): { title: string | null; order: number | null } {
  let fd: number | null = null
  try {
    fd = openSync(absPath, 'r')
    const buffer = Buffer.allocUnsafe(META_HEAD_BYTES)
    const read = readSync(fd, buffer, 0, META_HEAD_BYTES, 0)
    const text = buffer.subarray(0, read).toString('utf8')
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null
    let order: number | null = null
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const orderMatch = fm ? /^order:\s*(-?\d+(?:\.\d+)?)\s*$/m.exec(fm[1] ?? '') : null
    if (orderMatch?.[1] !== undefined) order = Number(orderMatch[1])
    return { title, order }
  } catch {
    return { title: null, order: null }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // 关闭失败不影响已读到的内容
      }
    }
  }
}

function scanDir(absDir: string, relDir: string, depth: number, sort: TreeSortMode): RawNode[] {
  if (depth > MAX_DEPTH) return []

  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs: RawNode[] = []
  const docs: RawNode[] = []

  for (const entry of entries) {
    const name = entry.name
    const rel = relDir ? `${relDir}/${name}` : name
    if (entry.isDirectory()) {
      if (isDirExcluded(name)) continue
      // 空目录也要进树：用户刚建好的文件夹落盘成功却被这里剔除，界面毫无
      // 变化，看起来像「创建失败」——这是 2026-10-28 修掉的误报源头。
      const dirAbs = join(absDir, name)
      const children = scanDir(dirAbs, rel, depth + 1, sort)
      // 落地页取本目录直接的 index.md/索引.md/README.md（子目录里的不算）
      const landingName = INDEX_BASENAMES.find(base =>
        children.some(c => c.type === 'doc' && `${c.name}.md` === base),
      )
      dirs.push({
        name,
        type: 'dir',
        order: null,
        mtime: mtimeOf(dirAbs),
        ...(landingName ? { landing: rel ? `${rel}/${landingName}` : landingName } : {}),
        children,
        relPath: rel,
      })
    } else if (entry.isFile() && name.toLowerCase().endsWith('.md')) {
      const absFile = join(absDir, name)
      const meta = readDocMeta(absFile)
      docs.push({
        name: name.replace(/\.md$/i, ''),
        type: 'doc',
        order: meta.order,
        mtime: mtimeOf(absFile),
        children: [],
        relPath: rel,
      })
    }
  }

  // 落地页排最前：它是目录自身的正文，读者点目录名就该落到它
  const landingDoc = INDEX_BASENAMES.find(base => docs.some(d => `${d.name}.md` === base))
  const sortKey = (node: RawNode) => node.order ?? Number.MAX_SAFE_INTEGER
  const sorted = (list: RawNode[], isDocList: boolean) =>
    [...list].sort((a, b) => {
      if (isDocList && landingDoc) {
        const aLanding = `${a.name}.md` === landingDoc
        const bLanding = `${b.name}.md` === landingDoc
        if (aLanding !== bLanding) return aLanding ? -1 : 1
      }
      if (sort === 'mtime') {
        // 最新改动的排最前；同毫秒回落到名称，保证顺序稳定（否则每次重扫都可能抖）
        return b.mtime - a.mtime || naturalCompare(a.name, b.name)
      }
      return sortKey(a) - sortKey(b) || naturalCompare(a.name, b.name)
    })

  return [...sorted(dirs, false), ...sorted(docs, true)]
}

function toTreeNodes(raw: RawNode[]): TreeNode[] {
  return raw.map(node => {
    if (node.type === 'doc') {
      return { path: node.relPath, name: node.name, type: 'doc' }
    }
    // 落地页由目录行本身代表：再从子项里列一遍会出现「指南 > index」这种噪音行
    const children = toTreeNodes(node.children).filter(
      child => child.type !== 'doc' || child.path !== node.landing,
    )
    // 容器目录合并：目录自身有落地页，且唯一子项是无落地页的容器目录时提升
    if (node.landing && children.length === 1) {
      const only = children[0]
      if (only?.type === 'dir' && !only.landing && CONTAINER_DIRS.has(only.name.toLowerCase())) {
        return {
          path: node.relPath,
          name: node.name,
          type: 'dir',
          landing: node.landing,
          children: only.children ?? [],
        }
      }
    }
    return {
      path: node.relPath,
      name: node.name,
      type: 'dir',
      ...(node.landing ? { landing: node.landing } : {}),
      // 空目录也带 children: []——树侧靠「有无 children 字段」画不出箭头会
      // 误判成文件，靠 type 判断；带上空数组让「目录」这个事实自明。
      children,
    }
  })
}

export function scanTree(root: string, sort: TreeSortMode = 'manual'): TreeNode[] {
  const config = readConfig(root)
  const scanned = toTreeNodes(scanDir(root, '', 0, sort))

  // 无 sidebar 声明：整棵树直接作为根列表（自动扫描模式）
  if (!config?.sidebar?.length) return scanned

  // 有声明：按配置映射到实际目录。path 相对内容根，'.' 表示内容根本身。
  const byPath = new Map<string, TreeNode>()
  for (const node of scanned) {
    byPath.set(node.path, node)
    for (const child of node.children ?? []) byPath.set(`${node.path}/${child.name}`, child)
  }

  const roots: TreeNode[] = []
  for (const entry of [...config.sidebar].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const normalized = entry.path.replace(/^\.\/?/, '').replace(/\/+$/, '')
    // '.' = 内容根整体：把扫出来的顶层节点全部并入这个声明项下
    if (!normalized) {
      roots.push({ path: '', name: entry.text, type: 'dir', children: scanned })
      continue
    }
    const direct = scanned.find(node => node.path === normalized)
    if (direct) {
      roots.push({ ...direct, name: entry.text })
      continue
    }
    // 声明的路径可能是嵌套目录（如 a/b）：在树里递归找
    const found = findNode(scanned, normalized)
    if (found) roots.push({ ...found, name: entry.text })
  }

  return roots.length ? roots : scanned
}

function findNode(nodes: TreeNode[], target: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === target) return node
    if (node.children) {
      const hit = findNode(node.children, target)
      if (hit) return hit
    }
  }
  return null
}

/**
 * 路径安全：把「相对的 POSIX 路径」解析到 workspace 根内。
 *
 * 两道防线（缺一不可）：
 *  1. 字符串层拒绝绝对路径、盘符、`..` 段；
 *  2. realpath 后判定结果仍在 realpath(root) 之内——防符号链接逃逸。
 */
export function resolveInside(root: string, relPath: string): string {
  if (!relPath || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath) || relPath.includes('\0')) {
    throw Object.assign(new Error('路径非法'), { code: 'E_INVALID' as const })
  }
  const segments = relPath.replaceAll('\\', '/').split('/')
  if (segments.some(seg => seg === '..' || seg === '')) {
    throw Object.assign(new Error('路径包含非法段'), { code: 'E_INVALID' as const })
  }

  const rootReal = realpathSync(root)
  const target = resolve(rootReal, ...segments)
  let targetReal: string
  try {
    targetReal = realpathSync(target)
  } catch {
    throw Object.assign(new Error('目标不存在'), { code: 'E_NOT_FOUND' as const })
  }
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (targetReal !== rootReal && !targetReal.startsWith(rootPrefix)) {
    throw Object.assign(new Error('目标在内容根之外'), { code: 'E_FORBIDDEN' as const })
  }
  return targetReal
}

/** 标题：首个 H1 优先，缺失时用文件名（与磁盘上的名字一致，便于用户对上号） */
function docTitle(text: string, filePath: string): string {
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
  if (h1) return h1
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  return base.replace(/\.md$/i, '')
}

export function readDoc(root: string, relPath: string): DocPayload {
  const abs = resolveInside(root, relPath)
  const stat = statSync(abs)
  if (!stat.isFile()) {
    throw Object.assign(new Error('目标不是文件'), { code: 'E_INVALID' as const })
  }
  if (stat.size > MAX_DOC_BYTES) {
    throw Object.assign(new Error('文档超过 20MB 上限'), { code: 'E_TOO_LARGE' as const })
  }
  const text = readFileSync(abs, 'utf8')
  return {
    path: relPath.replaceAll('\\', '/'),
    absolutePath: abs,
    title: docTitle(text, abs),
    text,
    mtime: stat.mtimeMs,
    size: stat.size,
  }
}

/**
 * 读取工作区外的单个 Markdown 文件（拖放 / 命令行 / 文件关联）。
 *
 * 与 readDoc 的区别：这里没有「内容根」可比对，路径本身就是用户的意图，
 * 因此不做 in-root 校验；但仍要求**绝对路径且扩展名为 .md**，
 * 避免渲染进程用相对路径把任意文件读进界面。
 */
export function readStandaloneDoc(absolutePath: string): DocPayload {
  if (!isAbsolute(absolutePath) || absolutePath.includes('\0')) {
    throw Object.assign(new Error('需要绝对路径'), { code: 'E_INVALID' as const })
  }
  if (!/\.md$/i.test(absolutePath)) {
    throw Object.assign(new Error('只支持 Markdown 文件'), { code: 'E_INVALID' as const })
  }
  let abs: string
  try {
    abs = realpathSync(absolutePath)
  } catch {
    throw Object.assign(new Error('文件不存在'), { code: 'E_NOT_FOUND' as const })
  }
  const stat = statSync(abs)
  if (!stat.isFile()) {
    throw Object.assign(new Error('目标不是文件'), { code: 'E_INVALID' as const })
  }
  if (stat.size > MAX_DOC_BYTES) {
    throw Object.assign(new Error('文档超过 20MB 上限'), { code: 'E_TOO_LARGE' as const })
  }
  const text = readFileSync(abs, 'utf8')
  return {
    path: abs.replaceAll('\\', '/'),
    absolutePath: abs,
    title: docTitle(text, abs),
    text,
    mtime: stat.mtimeMs,
    size: stat.size,
  }
}

/**
 * 搜索语料：整库文档全文，供渲染进程建索引。
 *
 * 为什么在主进程一次性给全量而不是边搜边读：索引建在 worker 里，
 * 一次 IPC 传完比「每敲一个字符来回读文件」少几百倍系统调用；
 * 单篇超过 SEARCH_DOC_LIMIT 的部分截断——搜索命中位置不会落在尾部，
 * 但把 20MB 文档整段塞进索引会把内存吃满。
 *
 * ## 为什么要按仓库规模降级
 *
 * 建索引的成本由**正文字数**决定：实测 2500 篇 / 14M 字符要 10 秒单核，
 * 索引常驻内存 350MB。开发仓库（两千多篇构建产物里的 README）天天被工具
 * 改写，每次都整库重读 + 重建，在后台看就是「没在用却一直烧 CPU」。
 *
 * 超过 `MAX_FULLTEXT_DOCS` 的仓库只索引**文件名与路径**：正文不读盘、不进索引，
 * 按文件名搜依然命中——这也正是大仓里最常用的检索方式。返回 `fullText: false`，
 * 由界面说明「该仓库仅索引文件名」，而不是静默少搜一部分。
 */
const SEARCH_DOC_LIMIT = 512 * 1024

/**
 * 全文索引的仓库规模上限（按文档篇数，不读盘就能判定）。
 *
 * 为什么用篇数而不是字符数：篇数在 walk 阶段就能拿到，判定不需要先读一遍文件；
 * 而单篇已有 512KB 上限，篇数足以控制总量级。800 的依据是实测：400 余篇的
 * 文档库约 2 秒建成，可接受；两千余篇的开发仓库要 10 秒、索引常驻 350MB，
 * 超出「打开应用顺手就能搜」的预算。
 */
export const MAX_FULLTEXT_DOCS = 800

export function collectSearchCorpus(root: string): SearchCorpus {
  const paths: string[] = []
  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      const rel = relDir ? `${relDir}/${name}` : name
      if (entry.isDirectory()) {
        if (isDirExcluded(name)) continue
        walk(join(absDir, name), rel, depth + 1)
      } else if (entry.isFile() && name.toLowerCase().endsWith('.md')) {
        paths.push(rel)
      }
    }
  }
  walk(root, '', 0)

  // 大仓只回路径：读 18MB 正文再丢给索引建 10 秒，纯粹是为搜不到的正文付钱
  if (paths.length > MAX_FULLTEXT_DOCS) {
    return { docs: paths.map(path => ({ path, text: '' })), fullText: false }
  }

  const docs: SearchDoc[] = []
  for (const path of paths) {
    try {
      const text = readFileSync(join(root, path), 'utf8')
      docs.push({ path, text: text.slice(0, SEARCH_DOC_LIMIT) })
    } catch {
      // 单篇读失败不影响整库索引
    }
  }
  return { docs, fullText: true }
}

/* ---------- 添加目录时的内容根探测 ---------- */

export interface WorkspaceProbe {
  /** 本目录有 docs.config.yaml（或本身就像内容根） */
  hasConfig: boolean
  /** 只探测一层：直接子目录中自带 docs.config.yaml 的候选内容根 */
  candidates: Array<{ name: string; path: string }>
  /** 本目录直接含有 .md 文件（无配置但仍是合理的内容根） */
  hasDocs: boolean
}

/**
 * 探测一个目录到底是不是内容根。
 *
 * 场景：用户常常选中的是「仓库根」或「文档总目录」，真正的文档根在里面一层
 * （`docs/`、`前端文档/` 之类）。旧版会列出候选让用户挑；不做这层探测的话，
 * 选中上级目录就得到一棵把 node_modules 之外所有目录都摊开的树，落地页也没有。
 *
 * 判定不猜：有配置就是内容根；否则看有没有直接子目录带配置（候选）；
 * 都没有再看本目录有没有 .md（自动扫描模式也成立）。
 */
export function probeWorkspace(root: string): WorkspaceProbe {
  let hasDocs = false
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return { hasConfig: false, candidates: [], hasDocs: false }
  }

  const candidates: Array<{ name: string; path: string }> = []
  for (const entry of entries) {
    const name = entry.name
    if (entry.isDirectory()) {
      if (isDirExcluded(name)) continue
      try {
        if (statSync(join(root, name, CONFIG_FILENAME)).isFile()) {
          candidates.push({ name, path: join(root, name) })
        }
      } catch {
        // 没有配置：不是候选
      }
    } else if (entry.isFile() && name.toLowerCase().endsWith('.md')) {
      hasDocs = true
    }
  }

  const hasConfig = (() => {
    try {
      return statSync(join(root, CONFIG_FILENAME)).isFile()
    } catch {
      return false
    }
  })()

  return { hasConfig, candidates, hasDocs }
}
