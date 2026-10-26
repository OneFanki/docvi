/**
 * 分享的「目录 → 迷你站点」实现：现场扫描生成树载荷，规则与壳的内容模型同口径
 * （只收目录与 .md、落地页优先级 index.md → 索引.md → README.md、自然序、限深 16、
 * 排除 `.` 前缀与 node_modules/dist/.git）。
 *
 * 为什么单独成文件：这是唯一一处「不复用 docs-core 的扫描」的例外——分享是只读旁路，
 * 且必须对任意目录（没有 docs.config.yaml、甚至不是文档仓）成立；docs-core 要求配置或
 * 显式 autoscan，此处直接按 autoscan 的最小语义实现，规则对齐但不引入配置加载。
 * 扫描口径的改动必须同时核对 scripts/lib/docs-core.mjs。
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const INDEX_BASENAMES = ['index.md', '索引.md', 'README.md']
const EXCLUDED_NAMES = new Set(['node_modules', 'dist', '.git'])
const MAX_SCAN_DEPTH = 16
const TITLE_SNIFF_BYTES = 2048

export function isExcludedName(name) {
  return name.startsWith('.') || EXCLUDED_NAMES.has(name)
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 树节点文本（含图标 marker span——壳侧栏 v-html 渲染，与 docs-core nodeText 同形状） */
function nodeText(kind, label) {
  const markerKind = kind === 'doc' ? 'doc' : kind === 'group' ? 'group' : 'leaf'
  const marker = `<span class="at-tree-marker" data-kind="${markerKind}"></span>`
  const title = escapeHtml(label)
  return `${marker}<span class="at-tree-title" title="${title}">${title}</span>`
}

/** 自然序：数字段按数值（`2-甲` < `10-乙`），其余按小写码点 */
export function naturalCompare(left, right) {
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const lc = left[i]
    const rc = right[j]
    if (/[0-9]/.test(lc) && /[0-9]/.test(rc)) {
      let ln = 0
      while (i < left.length && /[0-9]/.test(left[i])) {
        ln = ln * 10 + Number(left[i])
        i += 1
      }
      let rn = 0
      while (j < right.length && /[0-9]/.test(right[j])) {
        rn = rn * 10 + Number(right[j])
        j += 1
      }
      if (ln !== rn) return ln - rn
      continue
    }
    const lf = lc.toLowerCase()
    const rf = rc.toLowerCase()
    if (lf !== rf) return lf < rf ? -1 : 1
    i += 1
    j += 1
  }
  if (i >= left.length && j >= right.length) return 0
  return i >= left.length ? -1 : 1
}

function stripMdExt(name) {
  return name.replace(/\.md$/i, '')
}

/** 标题提取：frontmatter `title:` → 首个 `# ` 标题 → null（调用方回落文件名） */
export function titleFromText(text) {
  const source = text.replace(/^\uFEFF/, '')
  const lines = source.split(/\r?\n/)
  let cursor = 0
  if (lines[0]?.trim() === '---') {
    cursor = 1
    for (; cursor < lines.length; cursor += 1) {
      const trimmed = lines[cursor].trim()
      if (trimmed === '---') {
        cursor += 1
        break
      }
      if (trimmed.startsWith('title:')) {
        const value = trimmed
          .slice('title:'.length)
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim()
        if (value) return value
      }
    }
  }
  for (; cursor < lines.length; cursor += 1) {
    if (lines[cursor].startsWith('# ')) {
      const title = lines[cursor].slice(2).trim()
      if (title) return title
    }
  }
  return null
}

/** 读文件标题（前 2KB；读不到返回 null） */
function docTitle(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(TITLE_SNIFF_BYTES)
    const read = readSync(fd, buffer, 0, TITLE_SNIFF_BYTES, 0)
    if (read <= 0) return null
    return titleFromText(buffer.subarray(0, read).toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 扫描统计（version 指纹：文件数 + 最近 mtime 秒） */
function createCounter() {
  return {
    count: 0,
    latest: 0,
    feed(file) {
      this.count += 1
      try {
        const mtime = Math.floor(statSync(file).mtimeMs / 1000)
        if (mtime > this.latest) this.latest = mtime
      } catch {
        // 竞态删除：计数已加，mtime 用旧值
      }
    },
  }
}

/** 扫描一个目录：返回 { link, items } 或 null（空目录） */
function scanDir(dir, rel, depth, counter) {
  if (depth > MAX_SCAN_DEPTH) return null
  const dirNames = []
  const files = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (isExcludedName(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      dirNames.push(entry.name)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      counter.feed(full)
      files.push({ name: entry.name, title: docTitle(full) ?? stripMdExt(entry.name) })
    }
  }
  dirNames.sort(naturalCompare)
  files.sort((a, b) => naturalCompare(a.name, b.name))

  const indexName = INDEX_BASENAMES.find(name => files.some(file => file.name === name))
  const link = indexName ? `/${[rel, stripMdExt(indexName)].filter(Boolean).join('/')}` : undefined

  const items = []
  for (const name of dirNames) {
    const childRel = rel ? `${rel}/${name}` : name
    const node = subtreeNode(join(dir, name), name, childRel, depth + 1, counter)
    if (node) items.push(node)
  }
  for (const file of files) {
    if (file.name === indexName) continue
    items.push({
      text: nodeText('leaf', file.title),
      docFooterText: file.title,
      link: `/${rel}/${stripMdExt(file.name)}`,
    })
  }

  if (items.length === 0 && !link) return null
  return { link, items }
}

function subtreeNode(dir, name, rel, depth, counter) {
  const scan = scanDir(dir, rel, depth, counter)
  if (!scan) return null
  const node = {
    text: nodeText(scan.link ? 'doc' : 'group', name),
    docFooterText: name,
  }
  if (scan.link) node.link = scan.link
  if (scan.items.length > 0) {
    node.items = scan.items
    node.collapsed = depth > 1
  }
  return node
}

/**
 * 分享根 → 树载荷 `{ version, title, configSource: 'autoscan', roots }`。
 * 顶层目录在前、顶层散装 Markdown 在后（与 docs-core 未声明 sidebar 时一致）。
 */
export function buildTreePayload(root) {
  const dirNames = []
  const rootFiles = []
  const counter = createCounter()
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    throw new Error(`读取目录失败：${error.message}`)
  }
  for (const entry of entries) {
    if (isExcludedName(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      dirNames.push(entry.name)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      counter.feed(full)
      rootFiles.push({
        name: entry.name,
        title: docTitle(full) ?? stripMdExt(entry.name),
      })
    }
  }
  dirNames.sort(naturalCompare)
  rootFiles.sort((a, b) => naturalCompare(a.name, b.name))

  const roots = []
  for (const name of dirNames) {
    const node = subtreeNode(join(root, name), name, name, 1, counter)
    if (node) roots.push(node)
  }
  for (const file of rootFiles) {
    roots.push({
      text: nodeText('leaf', file.title),
      docFooterText: file.title,
      link: `/${stripMdExt(file.name)}`,
    })
  }

  return {
    version: `${counter.count.toString(16)}-${counter.latest.toString(16)}`,
    title: root.split(/[\\/]/).filter(Boolean).pop() ?? '文档',
    configSource: 'autoscan',
    roots,
  }
}
