/**
 * MCP 的文档语料层：跨范围检索与全文读取（单一实现，桌面与容器共用）。
 *
 * 范围（scope）由宿主注入，形状 `{workspace, root, prefix?}`：
 *   - 桌面：每个已打开工作区一个范围，workspace = 工作区名，prefix 省略（path 即工作区相对路径）；
 *   - 容器：每个仓库的默认分支工作树一个范围，workspace = `<仓库名>@<分支>`，
 *     prefix = `<slug>/`（检索结果带仓库前缀，read_doc 据此定位到唯一仓库）。
 *
 * 刻意不复用主进程的 content.ts：那边服务「窗口正在读的文档」（含缓存、树、契约字段），
 * 这边只服务 MCP 的只读查询，扫描规则需要为 AI 检索独立演进。
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.vitepress',
  'dist',
  '.idea',
  '.obsidian',
  'snippets',
  'assets',
])
const MAX_DEPTH = 16
/** 单篇索引上限：尾部内容不会成为检索目标，读满会把内存吃穿 */
const MAX_DOC_BYTES = 1024 * 1024
/** 文件列表缓存时长：AI 连续调用时不必反复 walk，但内容改动能在几秒内可见 */
const LIST_TTL_MS = 3000

function excluded(name) {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name)
}

function walk(scope, absDir, relDir, depth, out) {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (excluded(entry.name)) continue
      walk(scope, join(absDir, entry.name), rel, depth + 1, out)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push({ scope, relPath: rel, absolutePath: join(absDir, entry.name) })
    }
  }
}

/** 读文本（超限返回 null，避免把超大文件读进内存） */
function readText(file) {
  try {
    if (statSync(file).size > MAX_DOC_BYTES * 4) return null
    return readFileSync(file, 'utf8').slice(0, MAX_DOC_BYTES)
  } catch {
    return null
  }
}

function titleOf(text, relPath) {
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
  if (h1) return h1
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '')
}

/** Markdown → 纯文本片段：去掉常见标记，折叠空白。只为「看一眼上下文」服务。 */
function plain(text) {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>#|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function snippetAt(text, token) {
  const flat = plain(text)
  const index = flat.toLowerCase().indexOf(token.toLowerCase())
  if (index < 0) return flat.slice(0, 120)
  const start = Math.max(0, index - 45)
  const end = Math.min(flat.length, index + token.length + 65)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** 路径必须在范围根内（realpath 后再判，防符号链接逃逸） */
function inside(root, candidate) {
  try {
    const rootReal = realpathSync(root)
    const targetReal = realpathSync(candidate)
    const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
    if (targetReal === rootReal || targetReal.startsWith(prefix)) return targetReal
    return null
  } catch {
    return null
  }
}

/** 范围内的展示路径：prefix + 相对路径（统一 POSIX 分隔） */
function displayPath(scope, relPath) {
  return `${scope.prefix ?? ''}${relPath}`
}

/** 绝对路径 → 范围内的相对路径（realpath 后截断，防 `..` 与符号链接） */
function relativeTo(scope, absolute) {
  const rootReal = realpathSync(scope.root)
  const rel = absolute.slice(rootReal.length + 1).replaceAll('\\', '/')
  return rel
}

export function createCorpus(listScopes) {
  let cache = { at: 0, files: [] }

  const scopes = () => listScopes().filter(item => item && item.root)

  const files = () => {
    if (Date.now() - cache.at < LIST_TTL_MS && cache.files.length) return cache.files
    const out = []
    for (const scope of scopes()) walk(scope, scope.root, '', 0, out)
    cache = { at: Date.now(), files: out }
    return out
  }

  return {
    search(query, limit) {
      // 多词 AND：每个词都出现才算命中——比 OR 更接近「查找相关资料」的意图
      const tokens = String(query).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
      if (!tokens.length) return []

      const scored = []
      for (const entry of files()) {
        const text = readText(entry.absolutePath)
        if (!text) continue
        const lower = text.toLowerCase()
        if (!tokens.every(token => lower.includes(token))) continue
        const title = titleOf(text, entry.relPath)
        const titleHit = tokens.some(token => title.toLowerCase().includes(token))
        // 标题命中优先；正文里首词出现次数作为次要排序，避免长文档霸榜
        const occurrences = lower.split(tokens[0]).length - 1
        scored.push({
          hit: {
            workspace: entry.scope.workspace,
            path: displayPath(entry.scope, entry.relPath),
            title,
            snippet: snippetAt(text, tokens[0]),
          },
          score: (titleHit ? 1000 : 0) + Math.min(occurrences, 50),
        })
      }
      return scored
        .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path))
        .slice(0, limit)
        .map(item => item.hit)
    },

    readDoc(path) {
      const active = scopes()
      if (!active.length) return '当前没有可读取的文档范围（未打开工作区 / 尚无已发布分支）。'

      // 绝对路径：找到包含它的范围（桌面宿主排错与脚本调用会直接用绝对路径）
      if (isAbsolute(path)) {
        for (const scope of active) {
          const abs = inside(scope.root, path)
          if (!abs) continue
          const text = readText(abs)
          if (text === null) return `文档不可读（超过大小上限或权限不足）：${path}`
          const rel = relativeTo(scope, abs)
          return {
            workspace: scope.workspace,
            path: displayPath(scope, rel),
            title: titleOf(text, rel),
            text,
          }
        }
        return `路径不在任何可读范围内：${path}`
      }

      const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '')
      if (normalized.split('/').some(seg => seg === '..')) return `路径包含非法段：${path}`

      // 相对路径：先按范围前缀匹配（容器 `slug/…`），再按工作区顺序尝试裸相对路径
      const prefixed = active
        .filter(scope => scope.prefix && normalized.startsWith(scope.prefix))
        .sort((a, b) => (b.prefix?.length ?? 0) - (a.prefix?.length ?? 0))
      const candidates = prefixed.map(scope => ({
        scope,
        rel: normalized.slice(scope.prefix?.length ?? 0),
      }))
      for (const scope of active) {
        if (scope.prefix && normalized.startsWith(scope.prefix)) continue
        candidates.push({ scope, rel: normalized })
      }

      for (const { scope, rel } of candidates) {
        if (!rel) continue
        const abs = inside(scope.root, resolve(scope.root, ...rel.split('/')))
        if (!abs) continue
        const text = readText(abs)
        if (text === null) return `文档不可读（超过大小上限或权限不足）：${path}`
        return {
          workspace: scope.workspace,
          path: displayPath(scope, rel),
          title: titleOf(text, rel),
          text,
        }
      }
      return `没有找到文档：${path}（先调用 search_docs 查找可用路径）`
    },
  }
}
