import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import type { ShareTarget } from './http.ts'
import { renderMarkdown } from '@docvi/renderer-core/markdown'

/**
 * 临时分享的页面渲染与静态资源读取。
 *
 * 分享页面是**独立的只读一页**：不走 app 的渲染进程，也就不依赖窗口与插件注册表。
 * 样式内联在页面里（一处定义，不用再给服务进程打包 CSS 资源），
 * 深浅色跟随系统 `prefers-color-scheme`——分享给别人的页面不该强推我们的主题。
 */

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.obsidian', '.vitepress'])
const INDEX_BASENAMES = ['index.md', '索引.md', 'README.md']
const MAX_DOC_BYTES = 4 * 1024 * 1024

function excluded(name: string): boolean {
  return name.startsWith('.') || EXCLUDED_DIRS.has(name)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** 标题：首个 H1，回退文件名 */
function titleOf(text: string, relPath: string): string {
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
  if (h1) return h1
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/i, '')
}

/**
 * 把分享根与相对路径解析成真实文件，并确认仍在分享根内。
 * 目录分享才有根；文件分享直接返回该文件。
 */
function resolveTarget(share: ShareTarget, relPath: string): string | null {
  try {
    if (share.kind === 'file') {
      const real = realpathSync(share.path)
      return statSync(real).isFile() ? real : null
    }
    const rootReal = realpathSync(share.path)
    const segments = relPath ? relPath.split('/').filter(Boolean) : []
    if (segments.some(seg => seg === '..' || seg === '.' || seg.includes('\\'))) return null
    const real = realpathSync(resolve(rootReal, ...segments))
    const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
    if (real !== rootReal && !real.startsWith(prefix)) return null
    return real
  } catch {
    return null
  }
}

/** 目录分享的导航树：只收目录与 .md，落地页优先 */
interface NavNode {
  name: string
  /** 相对分享根的 POSIX 路径；目录为目录路径 */
  rel: string
  kind: 'dir' | 'doc'
  children?: NavNode[]
}

function scanNav(root: string, relDir: string, depth: number): NavNode[] {
  if (depth > 8) return []
  let entries
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true })
  } catch {
    return []
  }
  const dirs: NavNode[] = []
  const docs: NavNode[] = []
  for (const entry of entries) {
    if (excluded(entry.name)) continue
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const children = scanNav(root, rel, depth + 1)
      if (children.length) dirs.push({ name: entry.name, rel, kind: 'dir', children })
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      docs.push({ name: entry.name.replace(/\.md$/i, ''), rel, kind: 'doc' })
    }
  }
  const natural = (a: NavNode, b: NavNode): number =>
    a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
  return [...dirs.sort(natural), ...docs.sort(natural)]
}

/** 读文档正文（含 4MB 上限） */
function readDocText(file: string): string | null {
  try {
    if (!statSync(file).isFile() || statSync(file).size > MAX_DOC_BYTES) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 链接重写：`.md` 结尾的站内链接转成分享路由；外链原样保留 */
function rewriteLinks(html: string, shareId: string, relDir: string): string {
  return html.replace(/href="([^"]+)"/g, (whole, href: string) => {
    if (/^(https?:|mailto:|#|\/\/)/i.test(href)) return whole
    const [pathPart, hash] = href.split('#')
    if (!pathPart) return whole
    const cleanPath = pathPart.replace(/\.md$/i, '')
    const base = relDir ? `${relDir}/` : ''
    const target = cleanPath.startsWith('/') ? cleanPath.slice(1) : `${base}${cleanPath}`
    const encoded = target
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/')
    return `href="/s/${shareId}/${encoded}${hash ? `#${hash}` : ''}"`
  })
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf8; --fg: #1f2328; --muted: #6b7280; --line: #e5e2dc;
  --accent: #2f6f8f; --code: #f2f0ec; --quote: #6b7280;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #16181c; --fg: #e6e4e0; --muted: #9aa0a8; --line: #2a2e35;
          --accent: #6fb3d0; --code: #23272e; --quote: #9aa0a8; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 15px; line-height: 1.78; -webkit-font-smoothing: antialiased;
}
.shell { display: flex; min-height: 100vh; }
nav {
  width: 248px; flex: none; padding: 28px 16px; border-right: 1px solid var(--line);
  position: sticky; top: 0; max-height: 100vh; overflow-y: auto; font-size: 13px;
}
nav a { display: block; padding: 5px 8px; border-radius: 5px; color: var(--muted); text-decoration: none; }
nav a:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); color: var(--fg); }
nav a.is-active { color: var(--accent); font-weight: 600; }
nav .group { margin: 14px 0 4px; font-size: 11px; letter-spacing: .06em;
             text-transform: uppercase; color: var(--muted); opacity: .75; }
main { flex: 1; min-width: 0; padding: 48px 40px 96px; }
article { max-width: 760px; margin: 0 auto; }
.brand { max-width: 760px; margin: 0 auto 32px; font-size: 11.5px; letter-spacing: .08em;
         text-transform: uppercase; color: var(--muted); }
h1, h2, h3, h4 { line-height: 1.3; letter-spacing: -0.01em; margin: 1.9em 0 .6em; }
h1 { font-size: 28px; margin-top: 0; }
h2 { font-size: 21px; } h3 { font-size: 17px; } h4 { font-size: 15px; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1.05em; }
a { color: var(--accent); text-underline-offset: 2px; }
img { max-width: 100%; height: auto; border-radius: 6px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em;
       background: var(--code); padding: .15em .38em; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 13px; line-height: 1.6; }
blockquote { margin-left: 0; padding: 2px 0 2px 16px; border-left: 3px solid var(--line); color: var(--quote); }
table { border-collapse: collapse; width: 100%; font-size: 13.5px; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 7px 11px; text-align: left; }
th { background: color-mix(in srgb, var(--fg) 4%, transparent); font-weight: 600; }
hr { border: none; border-top: 1px solid var(--line); margin: 2em 0; }
.frontmatter { display: none; }
.plugin-missing { border: 1px dashed var(--line); border-radius: 6px; padding: 10px 12px;
                  color: var(--muted); font-size: 12.5px; }
footer { max-width: 760px; margin: 56px auto 0; padding-top: 16px; border-top: 1px solid var(--line);
         font-size: 11.5px; color: var(--muted); }
@media (max-width: 820px) {
  .shell { display: block; }
  nav { position: static; width: auto; max-height: none; border-right: none;
        border-bottom: 1px solid var(--line); }
  main { padding: 28px 20px 64px; }
}
`

function page(options: {
  title: string
  body: string
  nav?: string
  active?: string
  footer: string
}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="shell">
${options.nav ?? ''}
<main>
<div class="brand">docvi · 临时分享</div>
<article>${options.body}</article>
<footer>${escapeHtml(options.footer)}</footer>
</main>
</div>
</body>
</html>`
}

function navHtml(nodes: NavNode[], shareId: string, activeRel: string, depth = 0): string {
  const lines: string[] = []
  for (const node of nodes) {
    if (node.kind === 'doc') {
      const href = `/s/${shareId}/${node.rel.split('/').map(encodeURIComponent).join('/')}`
      const active = node.rel === activeRel ? ' class="is-active"' : ''
      lines.push(
        `<a href="${href}"${active} style="padding-left:${8 + depth * 10}px">${escapeHtml(node.name)}</a>`,
      )
      continue
    }
    lines.push(`<div class="group">${escapeHtml(node.name)}</div>`)
    if (node.children) lines.push(navHtml(node.children, shareId, activeRel, depth + 1))
  }
  return `<nav>${lines.join('\n')}</nav>`
}

export interface ShareRenderer {
  readShareFile(
    share: ShareTarget,
    relPath: string,
  ): Promise<{ body: Buffer; type: string } | 'not-found'>
  renderShareDoc(share: ShareTarget, relPath: string): Promise<string | null>
  renderShareIndex(share: ShareTarget): Promise<string | null>
}

export function createShareRenderer(): ShareRenderer {
  const renderDoc = async (share: ShareTarget, relPath: string): Promise<string | null> => {
    // 目录分享：relPath 可以是目录（找落地页）或 .md（可直接省略扩展名）
    let rel = relPath
    if (share.kind === 'file') {
      rel = ''
    } else if (!rel || !rel.toLowerCase().endsWith('.md')) {
      const target = resolveTarget(share, rel)
      if (!target) {
        // 目录不存在：链接可能省略了 .md 扩展名（导航里就是这么生成的）
        rel = `${rel}.md`
      } else if (statSync(target).isDirectory()) {
        let names: string[] = []
        try {
          names = readdirSync(target)
        } catch {
          return null
        }
        const landing = INDEX_BASENAMES.find(name => names.includes(name))
        if (!landing) return null
        rel = rel ? `${rel}/${landing}` : landing
      } else {
        rel = `${rel}.md`
      }
    }

    const file = resolveTarget(share, rel)
    if (!file) return null
    const text = readDocText(file)
    if (text === null) return null

    const docPath = share.kind === 'file' ? basename(share.path) : rel
    const docDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : ''
    const result = renderMarkdown(text, docPath)
    const html = rewriteLinks(result.html, share.id, docDir)
    const title = result.h1 ?? titleOf(text, docPath)

    // 目录分享带导航；文件分享是一页，没有导航
    let nav: string | undefined
    if (share.kind === 'dir') {
      const nodes = scanNav(realpathSync(share.path), '', 0)
      nav = navHtml(nodes, share.id, rel)
    }

    return page({
      title,
      body: html || '<p>（空文档）</p>',
      ...(nav ? { nav } : {}),
      footer: `共享路径：${share.path}`,
    })
  }

  return {
    async readShareFile(share, relPath) {
      const target = resolveTarget(share, relPath)
      if (!target) return 'not-found'
      try {
        const stat = statSync(target)
        if (!stat.isFile() || stat.size > 20 * 1024 * 1024) return 'not-found'
        return { body: readFileSync(target), type: 'application/octet-stream' }
      } catch {
        return 'not-found'
      }
    },

    renderShareDoc: renderDoc,

    async renderShareIndex(share) {
      if (share.kind === 'file') return null
      let rootReal: string
      try {
        rootReal = realpathSync(share.path)
      } catch {
        return null
      }
      const nodes = scanNav(rootReal, '', 0)
      if (!nodes.length) return null

      // 有落地页就直接呈现它（读者点分享链接第一眼看到内容，不是目录清单）
      let names: string[] = []
      try {
        names = readdirSync(rootReal)
      } catch {
        return null
      }
      const landing = INDEX_BASENAMES.find(name => names.includes(name))
      if (landing) return renderDoc(share, landing)

      const links = nodes
        .filter(node => node.kind === 'doc')
        .map(node => {
          const href = `/s/${share.id}/${node.rel.split('/').map(encodeURIComponent).join('/')}`
          return `<li><a href="${href}">${escapeHtml(node.name)}</a></li>`
        })
      const dirs = nodes
        .filter(node => node.kind === 'dir')
        .map(node => `<li><strong>${escapeHtml(node.name)}</strong></li>`)
      const body = `<h1>${escapeHtml(basename(rootReal))}</h1><ul>${[...dirs, ...links].join('')}</ul>`
      return page({
        title: basename(rootReal),
        body,
        footer: `共享路径：${share.path}`,
      })
    },
  }
}
