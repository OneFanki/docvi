/**
 * 死链报告（宽松策略的配套）：扫描内容根内全部未排除的 Markdown，
 * 校验相对链接与站内绝对链接在磁盘上是否存在。
 *
 * 只报告、不阻塞（宽松策略下死链不应阻断发布）：
 * - 缺失（磁盘上找不到目标）→ 计为问题，`--strict` 时以非零码退出；
 * - 指向被排除内容（如 AI 技能目录）→ 单列提示，不算问题。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadDocsConfig } from './docs-config.mjs'
import { createExcludeMatcher } from './scan-docs.mjs'

const BUILTIN_EXCLUDED = new Set([
  'node_modules',
  '.git',
  '.vitepress',
  'dist',
  '.idea',
  '.pytest_cache',
  '.obsidian',
])
const SKIP_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i

function naturalCompare(left, right) {
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

/** 收集内容根下全部未排除的 Markdown（相对内容根的 POSIX 路径） */
export function collectMarkdownFiles(root, isExcluded, relativeDir = '') {
  const files = []
  const entries = (() => {
    try {
      return readdirSync(relativeDir ? join(root, relativeDir) : root, { withFileTypes: true })
    } catch {
      return []
    }
  })()
  for (const entry of entries.sort((a, b) => naturalCompare(a.name, b.name))) {
    const name = entry.name
    if (name.startsWith('.') || BUILTIN_EXCLUDED.has(name)) continue
    const relative = relativeDir ? `${relativeDir}/${name}` : name
    if (isExcluded(relative)) continue
    let kind = entry.isDirectory()
      ? 'dir'
      : entry.isSymbolicLink()
        ? 'link'
        : entry.isFile()
          ? 'file'
          : null
    if (kind === 'link') {
      try {
        kind = statSync(join(root, relative)).isDirectory() ? 'dir' : 'file'
      } catch {
        continue
      }
    }
    if (kind === 'dir') files.push(...collectMarkdownFiles(root, isExcluded, relative))
    else if (kind === 'file' && name.endsWith('.md')) files.push(relative)
  }
  return files
}

/** 提取 Markdown 链接目标（跳过围栏代码块、外链与锚点） */
export function extractLinks(content) {
  const links = []
  let inFence = false
  content.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    for (const match of line.matchAll(/\[[^\]]*\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]
      if (SKIP_SCHEME.test(target)) continue
      links.push({ target, line: index + 1 })
    }
  })
  return links
}

function candidatesFor(root, fromFile, target) {
  const clean = target.replace(/[?#].*$/, '')
  if (!clean) return []
  // 链接按 URL 规则编码（如空格 → %20），磁盘路径需解码后再比对，否则误报缺失
  const decoded = (() => {
    try {
      return decodeURIComponent(clean)
    } catch {
      return clean
    }
  })()
  const base = decoded.startsWith('/')
    ? posix.normalize(decoded.replace(/^\/+/, ''))
    : posix.normalize(posix.join(posix.dirname(fromFile), decoded))
  if (base.startsWith('..')) return []
  const candidates = [base]
  if (!posix.extname(base)) {
    candidates.push(`${base}.md`)
    for (const name of ['index.md', '索引.md', 'README.md']) candidates.push(posix.join(base, name))
  }
  return candidates
}

/**
 * 检查一批 Markdown 的链接。
 * 返回 { checked, missing, excludedRefs }，元素形如 { file, line, target, resolved }。
 */
export function checkLinks(root, files, isExcluded) {
  const missing = []
  const excludedRefs = []
  let checked = 0
  for (const file of files) {
    const content = readFileSync(join(root, file), 'utf8')
    for (const { target, line } of extractLinks(content)) {
      const candidates = candidatesFor(root, file, target)
      if (!candidates.length) continue
      checked += 1
      if (candidates.some(candidate => existsSync(join(root, candidate)))) {
        if (isExcluded(candidates[0]))
          excludedRefs.push({ file, line, target, resolved: candidates[0] })
        continue
      }
      missing.push({ file, line, target, resolved: candidates[0] })
    }
  }
  return { checked, missing, excludedRefs }
}

function main() {
  const [rawRoot = process.env.DOCS_ROOT ?? '.', ...flags] = process.argv.slice(2)
  const root = rawRoot
  const config = loadDocsConfig(root)
  const isExcluded = createExcludeMatcher(config?.exclude ?? [])
  const files = collectMarkdownFiles(root, isExcluded)
  const { checked, missing, excludedRefs } = checkLinks(root, files, isExcluded)

  console.log(`\n▶ 死链检查: ${root}`)
  console.log(`  扫描 ${files.length} 篇文档 / ${checked} 条站内链接`)
  for (const item of excludedRefs) {
    console.log(`  · 指向排除内容（不进站点）: ${item.file}:${item.line} → ${item.target}`)
  }
  for (const item of missing) {
    console.log(`  ✗ 缺失: ${item.file}:${item.line} → ${item.target}`)
  }
  console.log(missing.length ? `  共 ${missing.length} 条缺失链接\n` : '  ✓ 未发现缺失链接\n')

  if (flags.includes('--strict') && missing.length) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
