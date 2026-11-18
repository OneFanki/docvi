import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

import type { ShareTheme } from '@docvi/shared'
import { DEFAULT_SHARE_THEME, sanitizeThemeTokens } from '@docvi/shared'

import type { ShareTarget } from './http.ts'
import { renderMarkdown } from '@docvi/renderer-core/markdown'

/**
 * 临时分享的页面渲染与静态资源读取。
 *
 * 分享页面是**独立的只读一页**：不走 app 的渲染进程，也就不依赖窗口与插件注册表。
 *
 * 主题与正文排版直接复用 `renderer-core` 的 theme.css / doc.css（由调用方传进来
 * 的 `baseCss` 内联进页面）：自己维护一套迷你样式的代价已经付过——配色对不上
 * 本机主题、mermaid 没有配套容器样式、组件角色 token 缺失。现在分享页与桌面
 * 阅读态是同一套变量。
 *
 * 主题会**跟随分享者本机当前设置**（`ShareTheme` 快照注入 `<html>` 属性），
 * 不再按访客的 `prefers-color-scheme` 猜——分享者选了深色，访客打开就该是深色。
 */

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', '.obsidian', '.vitepress'])
const INDEX_BASENAMES = ['index.md', '索引.md', 'README.md']
const MAX_DOC_BYTES = 4 * 1024 * 1024

/** 分享页外部运行时（mermaid 与图表增强）的固定前缀，见 http.ts */
export const SHARE_ASSET_PREFIX = '/share-assets/'

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

/**
 * 页面壳的样式。
 *
 * 只写「分享页独有」的东西：侧栏、页头、下载按钮、正文列宽。配色与排版不在这儿
 * ——那是 theme.css / doc.css 的职责，直接内联在它前面。
 */
const SHELL_CSS = `
/*
 * 阅读列宽必须写**固定像素**，不能用 ch。
 *
 * ch 是「当前元素所用字体里 0 的宽度」——同一个 84ch 被页头（12px）与正文
 * （16px）分别解析，会得到两个不同宽度：页头比正文窄一截，视觉上像两块拼不到
 * 一起的版心（实测页头 604px / 正文 805px，下载按钮因此被挤到文字被裁）。
 * 805px ≈ 正文 16px 等宽栈下的 84ch，与应用的阅读列同量级。
 */
:root { --share-measure: 805px; }
html, body { margin: 0; min-height: 100%; }
body {
  background: var(--dv-doc-bg); color: var(--dv-doc-text-body);
  font-family: var(--dv-font-sans);
  font-size: var(--dv-doc-font-size, 16px);
  line-height: var(--dv-doc-line-height, 1.8);
  -webkit-font-smoothing: antialiased;
}
.share-shell { display: flex; min-height: 100vh; }
.share-nav {
  width: 248px; flex: none; padding: 28px 16px; border-right: 1px solid var(--dv-ui-line);
  background: var(--dv-ui-surface-1); color: var(--dv-ui-text-2);
  position: sticky; top: 0; max-height: 100vh; overflow-y: auto; font-size: 13px;
}
.share-nav a {
  display: block; padding: 5px 8px; border-radius: var(--dv-radius-sm);
  color: var(--dv-ui-text-muted); text-decoration: none;
}
.share-nav a:hover { background: var(--dv-ui-surface-2); color: var(--dv-ui-text); }
.share-nav a.is-active { color: var(--dv-ui-accent); font-weight: 600; }
.share-nav .group {
  margin: 14px 0 4px; font-size: 11px; letter-spacing: .06em;
  text-transform: uppercase; color: var(--dv-ui-text-dim);
}
.share-main { flex: 1; min-width: 0; padding: 32px 32px 96px; }
.share-head {
  max-width: var(--share-measure); margin: 0 auto 20px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  font-size: 12px; color: var(--dv-ui-text-muted);
}
.share-brand { letter-spacing: .08em; text-transform: uppercase; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.share-download {
  display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px;
  border: 1px solid var(--dv-ui-line); border-radius: var(--dv-radius-sm);
  color: var(--dv-ui-text-2); text-decoration: none; font-size: 12px;
  /* flex 子项默认会收缩：不锁住就会被左侧的标题挤到文字被裁 */
  flex: none; white-space: nowrap;
}
.share-download:hover { border-color: var(--dv-ui-accent); color: var(--dv-ui-accent); }
.share-download svg { width: 13px; height: 13px; }
.share-article { max-width: var(--share-measure); margin: 0 auto; }
.share-foot {
  max-width: var(--share-measure); margin: 56px auto 0; padding-top: 16px;
  border-top: 1px solid var(--dv-ui-line); font-size: 11.5px; color: var(--dv-ui-text-dim);
}
@media (max-width: 820px) {
  .share-shell { display: block; }
  .share-nav {
    position: static; width: auto; max-height: none;
    border-right: none; border-bottom: 1px solid var(--dv-ui-line);
  }
  .share-main { padding: 24px 18px 64px; }
}

/*
 * 图放大层（mermaid 全屏查看）。
 *
 * 与桌面端的 ImageLightbox 同观感：铺满视口、实底（不用半透明模糊——图本身
 * 是细线稿，背后透出的文字会变成干扰纹理）、顶部一条工具栏。
 * 只消费主题变量，配色随分享页的主题走。
 */
.share-lightbox {
  position: fixed; inset: 0; z-index: 1200;
  display: flex; flex-direction: column;
  background: var(--dv-doc-bg);
}
.share-lightbox__head {
  flex: none; display: flex; align-items: center; gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--dv-doc-border);
  background: var(--dv-doc-surface);
}
.share-lightbox__title {
  flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  color: var(--dv-doc-text-2); font-size: 13px;
}
.share-lightbox__btn {
  flex: none; height: 26px; padding: 0 9px;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--dv-doc-border);
  border-radius: var(--dv-radius-sm);
  background: var(--dv-doc-bg); color: var(--dv-doc-text-2);
  font-size: 12px; font-family: inherit; cursor: pointer;
}
.share-lightbox__btn:hover {
  border-color: var(--dv-doc-accent); color: var(--dv-doc-accent);
}
.share-lightbox__btn--close { width: 26px; padding: 0; }
.share-lightbox__viewport {
  flex: 1; min-height: 0; position: relative;
  overflow: hidden; cursor: grab; touch-action: none;
}
.share-lightbox__viewport.is-dragging { cursor: grabbing; }
/*
 * 内容盒按原尺寸排版、由 transform 缩放：给 img/svg 设 max-width 会让放大后
 * 看到的仍是缩过的位图，白放大一场。
 */
.share-lightbox__content { width: max-content; user-select: none; }
.share-lightbox__content svg {
  display: block; max-width: none !important; max-height: none !important;
  transform-origin: 0 0; user-select: none;
}
`

/** lucide 的 download 图标（与桌面端按钮同形，内联避免引图标库） */
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'

/**
 * `<html>` 上的主题属性。
 *
 * 与桌面端渲染进程写的是同一组属性名：`data-theme` 选主题档、`data-appearance`
 * 给插件主题做继承基底。分享页没有随包字体，`data-font` 一律不写——字体由
 * theme.css 的系统字体栈回退，见 `ShareTheme` 的说明。
 */
function themeAttrs(theme: ShareTheme): string {
  return [
    `data-theme="${escapeHtml(theme.theme)}"`,
    `data-appearance="${theme.appearance === 'light' ? 'light' : 'dark'}"`,
  ].join(' ')
}

/** 插件主题的覆盖变量：与渲染进程注入 `<style>` 的写法完全一致 */
function themeTokensCss(theme: ShareTheme): string {
  const tokens = sanitizeThemeTokens(theme.tokens)
  const body = Object.entries(tokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')
  if (!body) return ''
  return `:root[data-theme='${escapeHtml(theme.theme)}'] {\n${body}\n}`
}

function page(
  options: {
    title: string
    body: string
    theme: ShareTheme
    nav?: string
    download?: string
    footer: string
  },
  baseCss: string,
): string {
  const tokens = themeTokensCss(options.theme)
  return `<!doctype html>
<html lang="zh-CN" ${themeAttrs(options.theme)} data-assets="${SHARE_ASSET_PREFIX}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${baseCss}</style>
<style>${SHELL_CSS}</style>
${tokens ? `<style>${tokens}</style>` : ''}
</head>
<body>
<div class="share-shell">
${options.nav ?? ''}
<main class="share-main">
<div class="share-head">
<span class="share-brand">docvi · 临时分享</span>
${
  options.download
    ? `<a class="share-download" href="${escapeHtml(options.download)}">${DOWNLOAD_ICON}下载源文件</a>`
    : ''
}
</div>
<article class="share-article doc-surface at-doc">${options.body}</article>
<footer class="share-foot">${escapeHtml(options.footer)}</footer>
</main>
</div>
<script type="module" src="${SHARE_ASSET_PREFIX}runtime.js"></script>
</body>
</html>`
}

/**
 * 导航项（不含外层 `<nav>`）。
 *
 * 递归时只产出**条目**：早期版本让递归也返回 `<nav>`，结果每个子目录都套一层
 * 导航容器——侧栏里出现嵌套的 `<nav>`，样式与语义都错。
 */
function navItems(nodes: NavNode[], shareId: string, activeRel: string, depth = 0): string {
  const lines: string[] = []
  for (const node of nodes) {
    if (node.kind === 'doc') {
      const href = `/s/${shareId}/${encodeURI(node.rel)}`
      const active = node.rel === activeRel ? ' class="is-active"' : ''
      lines.push(
        `<a href="${href}"${active} style="padding-left:${8 + depth * 10}px">${escapeHtml(node.name)}</a>`,
      )
      continue
    }
    lines.push(`<div class="group">${escapeHtml(node.name)}</div>`)
    if (node.children) lines.push(navItems(node.children, shareId, activeRel, depth + 1))
  }
  return lines.join('\n')
}

/**
 * 把内容根的根相对路径转成分享路由。
 *
 * 逐段 `encodeURIComponent`：**目录段也要编码**。这条曾经踩过——渲染管线里
 * markdown-it 只编码链接目标（文件名那段），而 `urlPrefix` 是宿主拼的原文，
 * 于是同一页上「正文链接 = /s/id/指南/%E5%85%B6%E5%AE%83，侧栏 = 全编码」
 * 两种形态并存，指同一个文件却互相认不出。
 *
 * 解法是让 `docPath` 也按同一规则编码后交给渲染管线（见 renderDoc），这样
 * 正文、图片、侧栏、下载按钮四个入口的输出逐字一致。
 */
function encodeRel(rel: string): string {
  return rel
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
}

function shareHref(shareId: string, rel: string): string {
  return `/s/${shareId}/${encodeRel(rel)}`
}

export interface ShareRenderer {
  readShareFile(
    share: ShareTarget,
    relPath: string,
  ): Promise<{ body: Buffer; type: string } | 'not-found'>
  /**
   * 把请求里的路径归一成真实文档的相对路径（目录 → 落地页、省略扩展名 → 补 .md）。
   *
   * 下载与阅读必须共用这一份：各写一遍的后果是「页面能打开、下载却 404」，
   * 而且只在从导航点进去（地址不带 `.md`）时才复现。
   */
  resolveDocRel(share: ShareTarget, relPath: string): string | null
  /** 渲染一篇分享文档（`rel` 是归一后的真实路径，下载按钮要用） */
  renderShareDoc(
    share: ShareTarget,
    relPath: string,
    theme: ShareTheme,
  ): Promise<{ html: string; rel: string } | null>
  renderShareIndex(share: ShareTarget, theme: ShareTheme): Promise<string | null>
}

/**
 * @param baseCss 主题与正文样式文本（主题变量 + doc.css）。由调用方传入而不是
 *   在这里 `?raw` 导入：那是打包器语义，Node 直接跑会按扩展名解析 `.css`
 *   而失败（见 share-css.ts）。
 */
export function createShareRenderer(baseCss = ''): ShareRenderer {
  /**
   * 路径归一：目录分享的 relPath 可以是目录（找落地页）或 .md（可省略扩展名）。
   * 只做路径计算，不读文件内容。
   */
  const resolveDocRel = (share: ShareTarget, relPath: string): string | null => {
    if (share.kind === 'file') return ''
    let rel = relPath
    if (!rel || !rel.toLowerCase().endsWith('.md')) {
      const target = resolveTarget(share, rel)
      if (!target) {
        // 目录不存在：链接可能省略了 .md 扩展名（导航里就是这么生成的）
        return `${rel}.md`
      }
      let stat
      try {
        stat = statSync(target)
      } catch {
        return null
      }
      if (stat.isDirectory()) {
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
    return rel
  }

  const renderDoc = async (
    share: ShareTarget,
    relPath: string,
    theme: ShareTheme,
  ): Promise<{ html: string; rel: string } | null> => {
    const rel = resolveDocRel(share, relPath)
    if (rel === null) return null

    const file = resolveTarget(share, rel)
    if (!file) return null
    const text = readDocText(file)
    if (text === null) return null

    const docPath = share.kind === 'file' ? basename(share.path) : rel
    /*
     * 站内链接与图片都按 `/s/<id>/` 前缀化：这是分享页唯一存在的站点根。
     * 交给渲染管线做（urlPrefix / assetPrefix 是两个独立入口），不再自己用
     * 正则改 HTML——那里不认识代码块里的示例链接，会一起改坏。
     *
     * `docPath` 传**逐段编码后**的版本：渲染管线拿它算相对基准，目录段若保持
     * 原文，产出的地址会与侧栏（全编码）不一致。详见 encodeRel 的说明。
     */
    const prefix = `/s/${share.id}`
    const result = renderMarkdown(text, encodeRel(docPath), {
      urlPrefix: prefix,
      assetPrefix: prefix,
    })
    const title = result.h1 ?? titleOf(text, docPath)

    // 目录分享带导航；文件分享是一页，没有导航
    let nav: string | undefined
    if (share.kind === 'dir') {
      const nodes = scanNav(realpathSync(share.path), '', 0)
      nav = `<nav class="share-nav">${navItems(nodes, share.id, rel)}</nav>`
    }

    // 下载链接：指向同一路径 + `?download`，由 http 层改写为附件响应
    const downloadHref = shareHref(share.id, rel)
    const html = page(
      {
        title,
        body: result.html || '<p>（空文档）</p>',
        theme,
        ...(nav ? { nav } : {}),
        download: `${downloadHref}?download=1`,
        // 不写分享者的本机绝对路径：拿到链接的任何人都不该看到它
        footer: '链接由分享者的电脑实时提供，关闭分享或断开网络即失效。',
      },
      baseCss,
    )
    return { html, rel }
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

    resolveDocRel,

    async renderShareIndex(share, theme) {
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
      if (landing) {
        const rendered = await renderDoc(share, landing, theme)
        return rendered?.html ?? null
      }

      const links = nodes
        .filter(node => node.kind === 'doc')
        .map(node => {
          const href = shareHref(share.id, node.rel)
          return `<li><a href="${href}">${escapeHtml(node.name)}</a></li>`
        })
      const dirs = nodes
        .filter(node => node.kind === 'dir')
        .map(node => `<li><strong>${escapeHtml(node.name)}</strong></li>`)
      const body = `<h1>${escapeHtml(basename(rootReal))}</h1><ul>${[...dirs, ...links].join('')}</ul>`
      return page(
        {
          title: basename(rootReal),
          body,
          theme,
          footer: '链接由分享者的电脑实时提供，关闭分享或断开网络即失效。',
        },
        baseCss,
      )
    },
  }
}

export { DEFAULT_SHARE_THEME }
