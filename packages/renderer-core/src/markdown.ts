/**
 * Markdown 渲染管线（自旧壳迁移，行为保持）。
 *
 * 结构对齐既有产物：custom-block 容器、header-anchor、language-x 代码块占位
 * （高亮与 mermaid 由异步 pass 接管）。渲染管线本身**不碰 DOM**——产出 HTML 字符串
 * + frontmatter + 大纲，宿主决定怎么插入。
 *
 * ⚠️ 与旧壳的一处差异：颜色增强与术语块开关改为**每次渲染传入**，不再用模块级
 * 可变状态。旧写法在「并发渲染两篇文档」时会串页（一篇的 colors:false 影响另一篇）。
 */
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance, Token } from 'markdown-it'
import anchor from 'markdown-it-anchor'
import container from 'markdown-it-container'
import { parse as parseYaml } from 'yaml'

import { colorLiteral } from './color-literal.ts'
import { findPluginBlocks, type PluginSyntaxDeclaration } from './plugin-blocks.ts'

export interface Frontmatter {
  title?: string
  order?: number
  components?: Record<string, Record<string, unknown>>
  /** colors: false = 本页关闭行内代码颜色色块（默认开） */
  colors?: boolean
  /** terms: false = 本页关闭段首加粗升格（默认开） */
  terms?: boolean
  [key: string]: unknown
}

export interface OutlineEntry {
  level: number
  text: string
  id: string
}

export interface RenderResult {
  html: string
  frontmatter: Frontmatter
  /** 文档首个 H1（标签标题与 <title> 的回退源） */
  h1: string | null
  outline: OutlineEntry[]
  /** frontmatter 解析失败时的可读错误（不白屏，按纯 markdown 渲染） */
  error: string | null
}

export interface RenderOptions {
  /** 临时分享等前缀路由：根相对链接与图片加前缀 */
  urlPrefix?: string
  /**
   * 图片 src 的独立前缀（缺省跟随 `urlPrefix`）。
   *
   * 桌面端的链接与图片不在同一地址空间：链接是工作区相对路径（无前缀），
   * 图片必须走 `docvi://asset/<工作区>/`。共用 `urlPrefix` 会让图片请求落到
   * 渲染产物目录，图上就是破图。
   */
  assetPrefix?: string
  /**
   * 插件提供的容器语法扩展（manifest 的 markdownSyntax，form: container）。
   *
   * `name` 是容器名（`::: merged`），`component` 是目标组件 kind。
   * 渲染成 `<div data-plugin-syntax="<name>" data-plugin-component="<kind>">`
   * 内嵌 YAML —— 组件挂载由宿主在 DOM 插入后按 data-plugin-component 触发，
   * 渲染管线本身不认识任何具体插件。
   */
  containerSyntax?: Array<{ name: string; component: string }>
  /**
   * 给块级元素标注 `data-source-line`（原文件 0-based 行号）。
   *
   * 只有需要「源行 ↔ 渲染块」对齐的宿主才开：分屏同步滚动靠它精确定位。
   * 导出 / 分享页不开——多出来的属性会污染产出文件。
   */
  sourceLines?: boolean
}

/** frontmatter 剥离：行首 --- 边界（缩进的 --- 不算，对照 gray-matter 语义） */
function splitFrontmatter(src: string): {
  data: Frontmatter
  content: string
  error: string | null
  /** 正文首行在**原文件**里的 0-based 行号（frontmatter 占掉的函数） */
  lineOffset: number
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src)
  if (!match) return { data: {}, content: src, error: null, lineOffset: 0 }
  // match[0] 以换行结尾：按行切最后一段是空串，减 1 才是行数
  const lineOffset = Math.max(0, match[0].split(/\r?\n/).length - 1)
  try {
    const data = (parseYaml(match[1] ?? '') as Frontmatter) ?? {}
    return { data, content: src.slice(match[0].length), error: null, lineOffset }
  } catch (error) {
    return {
      data: {},
      content: src,
      error: `frontmatter 解析失败：${(error as Error).message}`,
      lineOffset: 0,
    }
  }
}

/**
 * 标题 id 生成（对齐 VitePress slug 语义）：小写化；空白 → '-'；删除 ASCII/全角标点
 * 但保留中文、字母数字与 '-'/'_'/'·'；数字开头加 '_' 前缀。
 */
function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(
      /[[\]~/!@#$%^&*()+=.,;:?"'<>|{}「」『』【】（）［］｛｀～！＠＃￥％…＆×（）——＋＝、。；：？"'`*]/g,
      '',
    )
  return /^[0-9]/.test(slug) ? `_${slug}` : slug
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 插件的结构化块语法声明。
 *
 * `form` 缺省按 `container` 处理（老清单只有容器一种形态）。
 * 两种形态的数据都写在块内 YAML，区别只在围栏长什么样。
 */
export type ContainerSyntax = PluginSyntaxDeclaration

/**
 * 把插件结构化块替换成占位 HTML。
 *
 * 两种形态：`::: <name>` 容器与 ```` ```<name> ```` 围栏。缩小为同一个
 * `data-plugin-*` 占位元素，挂载器按 data-plugin-component 触发——渲染管线
 * 本身不认识任何具体插件。
 *
 * 为什么在 Markdown 解析之前处理：块内是 YAML，不是 Markdown。交给容器规则
 * 或围栏规则渲染会把 `title: xxx` 变成正文段落；这里整块摘出来，原始 YAML
 * 用 percent-encoding 放进 data 属性。
 *
 * 行扫描统一走 `findPluginBlocks`（与编辑态同一份实现）：两处各写一份正则曾
 * 导致缩进两格的收尾 `:::` 在编辑态被识别、阅读态不认。
 */
export function extractPluginBlocks(
  markdown: string,
  syntax: ContainerSyntax[],
  /**
   * 行号对齐：`null` = 不对齐（默认，导出与分享页用）；数字 = 正文首行在**原文件**
   * 里的 0-based 行号（有 frontmatter 时 > 0，没有时也是 0——所以能不能用 0 判断
   * "是否要对齐"是错的，必须用 null 显式区分）。
   */
  lineOffset: number | null = null,
): string {
  if (!syntax.length) return markdown

  // 按行切并保留原始行尾，替换时只动插件块所在的行，其余字节不动
  const lines = markdown.split(/\r?\n/)
  const spans = findPluginBlocks(lines, syntax)
  if (!spans.length) return markdown

  const crlf = /\r\n/.test(markdown) ? '\r\n' : '\n'
  const out: string[] = []
  let cursor = 0
  for (const span of spans) {
    out.push(...lines.slice(cursor, span.startLine))
    /*
     * 数据放 data 属性而不是 <script> 子节点，且用 percent-encoding：
     *  - 属性值可安全承载换行（编码后没有裸换行），不会被 Markdown 的 HTML 块规则截断；
     *  - 不依赖「script 文本在 HTML 解析后保真」——实测把换行替换成占位字符后，
     *    浏览器会把它规范化成 U+FFFD，YAML 直接解析失败。
     */
    const payload = encodeURIComponent(span.body.trim())
    const linePart = lineOffset === null ? '' : ` data-source-line="${span.startLine + lineOffset}"`
    out.push(
      `<div class="at-plugin-block"${linePart}` +
        ` data-plugin-syntax="${escapeHtml(span.name)}"` +
        ` data-plugin-form="${span.form}"` +
        ` data-plugin-component="${escapeHtml(span.component)}"` +
        ` data-plugin-payload="${escapeHtml(payload)}"></div>`,
    )
    /*
     * 保持行数：一个 N 行的插件块被替换成 1 行 HTML 之后，后续块的行号会整体
     * 前移 N-1——分屏同步滚动与「源行 ↔ 渲染块」的映射靠行号，一漂就全错。
     * 补 N-1 个空行，空行在 Markdown 里不产生任何输出。
     */
    if (lineOffset !== null) {
      for (let i = span.startLine + 1; i <= span.endLine; i += 1) out.push('')
    }
    cursor = span.endLine + 1
  }
  out.push(...lines.slice(cursor))
  return out.join(crlf)
}

/** 相对路径按 baseDir 归一为根相对（折叠 `..` / `.` / 空段） */
function toRootRelative(rawPath: string, baseDir: string): string {
  const segments = (rawPath.startsWith('/') ? rawPath : `${baseDir}/${rawPath}`).split('/')
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') continue
    if (segment === '..') stack.pop()
    else stack.push(segment)
  }
  return `/${stack.join('/')}`
}

/**
 * 解析站内链接：`.md` 与无扩展名的相对/根路径统一归一为根相对（剥 .md、折叠 ../ ./）。
 * 原样保留：裸锚点、外链（含 //）、带扩展名的资产文件。
 */
export function resolveLink(href: string, docPath: string): string {
  const [rawPath = '', anchorPart] = href.split('#', 2)
  if (!rawPath) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(rawPath) || rawPath.startsWith('//')) return href
  const lastSegment = rawPath.split('/').pop() ?? ''
  if (lastSegment.includes('.') && !/\.md$/i.test(rawPath)) return href
  const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : ''
  const normalized = toRootRelative(rawPath.replace(/\.md$/i, ''), baseDir)
  return anchorPart !== undefined ? `${normalized}#${anchorPart}` : normalized
}

const CONTAINERS = ['tip', 'note', 'info', 'warning', 'danger'] as const

/**
 * 把「段首加粗」升格为可扫读的标题块。
 *
 * 文档体系里有大量统一写法：`**术语**：定义…`、`**短语**。正文…`、
 * `**小节名**` 单独成段、有序列表里的 `1. **步骤名**` + 缩进说明。
 * 语义上都是「标题 + 说明」，但 Markdown 只有 `<p><strong>`，渲染出来是一整块
 * 连续正文——读者失去扫读锚点。
 *
 * 四种形态（都要求加粗在段落最前面）：
 *   ① 段首 strong 紧跟 `。` 或 `：` → 术语块（剥标点）
 *   ② 整段只有一个 strong → 独立小标题
 *   ③ 列表项 strong 独占首段且后面还有正文 → 步骤标题
 *   ④ 其他不动（正文强调句、行内加粗不误伤）
 */
function promoteTermParagraphs(md: MarkdownItInstance, enabled: () => boolean): void {
  md.core.ruler.push('docvi_term_blocks', state => {
    if (!enabled()) return
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i += 1) {
      const open = tokens[i]
      if (open?.type !== 'paragraph_open') continue
      const inline = tokens[i + 1]
      if (!inline || inline.type !== 'inline' || !inline.children) continue
      const topLevel = open.level === 0
      const inListItem =
        open.level > 0 &&
        tokens
          .slice(0, i)
          .reverse()
          .find(token => token.type === 'list_item_open') !== undefined
      if (!topLevel && !inListItem) continue

      const children = inline.children
      // ⚠️ markdown-it 在段首插一个**内容为空的 text token**，直接取 children[0]
      // 判断类型会永远落空——曾让本规则静默失效一整轮。
      let start = 0
      while (
        start < children.length &&
        children[start]?.type === 'text' &&
        !children[start]?.content
      ) {
        start += 1
      }
      const first = children[start]
      if (!first || first.type !== 'strong_open') continue

      let closeIndex = -1
      for (let j = start + 1; j < children.length; j += 1) {
        if (children[j]?.type === 'strong_close') {
          closeIndex = j
          break
        }
      }
      if (closeIndex < 0) continue

      const restAfterClose = children[closeIndex + 1]
      const punctuation =
        restAfterClose?.type === 'text' ? (/^[。：:]/.exec(restAfterClose.content)?.[0] ?? '') : ''
      const tailIsEmpty = children
        .slice(closeIndex + 1)
        .every(child => child.type === 'text' && !child.content)
      const isStandalone = tailIsEmpty
      const isDefinition = punctuation !== ''

      let stepLabel = false
      if (inListItem && (isStandalone || isDefinition)) {
        stepLabel = hasBodyParagraphAfter(tokens, i)
      }
      if (!isStandalone && !isDefinition) continue
      if (inListItem && !stepLabel) continue

      const termText = children
        .slice(start + 1, closeIndex)
        .map(child => child.content ?? '')
        .join('')
        .trim()
      if (!termText) continue
      if ([...termText].length > 48) continue
      // 加粗内部以句末标点收尾 = 整句加粗（论断），不是标题标签
      if (/[。！]$/.test(termText)) continue
      const isQuestion = /[？?]\s*$/.test(termText)

      open.attrSet('class', isQuestion ? 'at-question' : stepLabel ? 'at-step' : 'at-term')
      open.attrSet('data-term', termText)
      for (let j = start; j <= closeIndex; j += 1) {
        const child = children[j]
        if (child?.type === 'strong_open') {
          child.attrSet(
            'class',
            isQuestion ? 'at-question__label' : stepLabel ? 'at-step__label' : 'at-term__label',
          )
        }
      }
      if (isDefinition && restAfterClose) {
        restAfterClose.content = restAfterClose.content.replace(/^[。：:]/, '')
      }
    }
  })
}

/** 列表项内的标题段落是否需要升格：该 list_item 在此段之后还有正文段落 */
function hasBodyParagraphAfter(tokens: Token[], paragraphIndex: number): boolean {
  let depth = 0
  for (let k = paragraphIndex; k < tokens.length; k += 1) {
    const token = tokens[k]
    if (!token) continue
    if (token.type === 'list_item_close') {
      if (depth === 0) return false
      depth -= 1
    } else if (token.type === 'list_item_open') {
      depth += 1
    } else if (k > paragraphIndex && token.type === 'paragraph_open' && depth === 0) {
      return true
    }
  }
  return false
}

/**
 * GFM 任务清单（`- [ ] 待办` / `- [x] 完成`）。
 *
 * markdown-it 默认不认这个语法。阅读态若不处理，同一份文档在实时预览里是勾选框、
 * 在阅读态里却是字面量「[ ] 待办」——用户会以为渲染坏了。
 *
 * 不引 `markdown-it-task-lists`：那个包会顺带把 li 改成可点击，而阅读态不该让
 * 用户点一下就改文档内容。这里只做两件事：把前缀换成禁用态复选框、给 li 打标记
 * 让 CSS 收掉项目符号。
 */
function taskLists(md: MarkdownItInstance): void {
  md.core.ruler.push('docvi_task_list', state => {
    const { tokens } = state
    for (let i = 0; i < tokens.length; i += 1) {
      const itemOpen = tokens[i]
      if (itemOpen?.type !== 'list_item_open') continue
      // 标记必须紧跟在 list_item_open 之后的段落里；松散列表的续段不参与
      const paragraphOpen = tokens[i + 1]
      const inline = tokens[i + 2]
      if (paragraphOpen?.type !== 'paragraph_open' || inline?.type !== 'inline') continue
      const children = inline.children
      const first = children?.[0]
      if (!children || first?.type !== 'text') continue
      const match = /^\[([ xX])\]\s+/.exec(first.content)
      if (!match) continue

      const checked = match[1] !== ' '
      first.content = first.content.slice(match[0].length)

      const box = new state.Token('html_inline', '', 0)
      box.content = `<input class="at-task__box" type="checkbox" disabled${
        checked ? ' checked' : ''
      }>`
      children.unshift(box)
      // 前缀被吃干净时这个 text token 已无内容，留着会渲染成空节点
      if (!first.content) children.splice(children.indexOf(first), 1)

      itemOpen.attrJoin('class', 'at-task')
    }
  })
}

interface BuildContext {
  docPath: string
  prefix: string
  /**
   * 图片 src 的前缀，缺省跟随 `prefix`。
   *
   * 链接与图片的「宿主地址空间」可能不同：链接走 SPA 路由（桌面端是无前缀的
   * 工作区相对路径），图片要走宿主资产协议（桌面端是 `docvi://asset/<工作区>/`）。
   * 两者共用一个前缀时，图片会被拼成 `docvi://app/img/a.png` 落到渲染产物目录，
   * 结果是破图——所以必须能分开指定。
   */
  assetPrefix?: string
  colorChips: boolean
  termBlocks: boolean
  /** 原文件里正文首行的 0-based 行号（有 frontmatter 时 > 0） */
  lineOffset: number
  /** 是否给块级元素标注 data-source-line（分屏同步用） */
  sourceLines: boolean
  onAnchor?: (token: Token, info: { slug: string; title: string }) => void
}

/**
 * 给块级元素打 `data-source-line`（原文件 0-based 起始行）。
 *
 * 用途：分屏同步滚动按**源行**对齐两侧，而不是按滚动进度百分比——两侧内容高度
 * 比例完全不同（源码里一行表格可能是渲染后的几十行），百分比同步必然越滚越偏。
 * 编辑器侧取顶部可见行，阅读侧找「起始行 ≤ 该行」的最后一个块并滚到它。
 *
 * 只标块级 token（它们才有 map）；行内 token 由所在块代表。
 */
function annotateSourceLines(md: MarkdownItInstance, lineOffset: number): void {
  md.core.ruler.push('docvi_source_lines', state => {
    for (const token of state.tokens) {
      if (!token.map) continue
      token.attrSet('data-source-line', String(token.map[0] + lineOffset))
    }
  })
}

function lineAttr(token: Token | undefined): string {
  const value = token?.attrGet('data-source-line')
  return value === null || value === undefined
    ? ''
    : ` data-source-line="${escapeHtml(String(value))}"`
}

function createMarkdownIt(ctx: BuildContext): MarkdownItInstance {
  const md: MarkdownItInstance = new MarkdownIt({ html: true, linkify: true, typographer: true })
  const { docPath, prefix } = ctx
  const assetPrefix = ctx.assetPrefix ?? prefix

  // 链接：站内 .md → 规范路径（.html/外链/资产不动），目标页由宿主路由接管
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options_, env, self) => {
    const href = tokens[idx]?.attrGet('href')
    if (href !== null && href !== undefined) {
      const resolved = resolveLink(String(href), docPath)
      tokens[idx]?.attrSet(
        'href',
        prefix && resolved.startsWith('/') && !resolved.startsWith('//')
          ? prefix + resolved
          : resolved,
      )
    }
    return defaultLinkOpen(tokens, idx, options_, env, self)
  }

  // 图片：内容根内相对路径 → 根相对，再补宿主的资产前缀
  const defaultImage =
    md.renderer.rules.image ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options_, env, self) => {
    const src = tokens[idx]?.attrGet('src')
    if (src !== null && src !== undefined && !/^(https?:|data:|\/\/)/.test(String(src))) {
      const baseDir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : ''
      const next = toRootRelative(String(src), baseDir)
      tokens[idx]?.attrSet('src', assetPrefix ? assetPrefix + next : next)
    }
    return defaultImage(tokens, idx, options_, env, self)
  }

  // 标题锚点 + permalink；callback 采集大纲。
  // ariaHidden：`#` 只是视觉提示，读屏器不该把它当标题文字念出来；
  // 大纲与标签的标题另有 token 文本来源，不依赖这里。
  //
  // placement: 'before' 是硬要求：默认把 `<a>` 放在标题文字**之后**，
  // 配合 CSS 的 float:left 时，长标题折行会让 `#` 落到**最后一行**行首
  // （实测 h1「Product Knowledge Agent Guide」两行时 `#` 跑到第二行）。
  // 放在文字之前，定位点就永远跟着第一行。
  md.use(anchor, {
    slugify,
    permalink: anchor.permalink.linkInsideHeader({
      symbol: '#',
      ariaHidden: true,
      placement: 'before',
    }),
    callback: ctx.onAnchor,
  })

  // 自定义容器（::: tip 标题 … :::）
  for (const kind of CONTAINERS) {
    md.use(container, kind, {
      // markdown-it-container 的 render 未声明参数类型，这里显式标注
      render(tokens: Token[], idx: number) {
        const token = tokens[idx]
        if (!token) return ''
        if (token.nesting === 1) {
          const title = token.info.trim().slice(kind.length).trim() || kind
          return `<div class="custom-block ${kind}"${lineAttr(token)}><p class="custom-block-title">${escapeHtml(title)}</p>\n`
        }
        return `</div>\n`
      },
    })
  }
  md.use(container, 'details', {
    render(tokens: Token[], idx: number) {
      const token = tokens[idx]
      if (!token) return ''
      if (token.nesting === 1) {
        const title = token.info.trim().slice('details'.length).trim() || '详情'
        return `<details class="custom-block details"${lineAttr(token)}><summary>${escapeHtml(title)}</summary>\n`
      }
      return `</details>\n`
    },
  })

  /*
   * 插件容器语法不走 markdown-it-container：容器内的内容是一段 YAML，
   * 交给容器规则会被当作普通 Markdown 渲染成段落（`title: xxx` 变成正文）。
   * 改在渲染前把整块替换成占位 HTML（见 extractPluginBlocks），
   * 渲染管线不认识任何具体插件，组件挂载由宿主按 data-plugin-component 完成。
   */

  // 代码块：占位结构（lang 标签 + 复制按钮），高亮由异步 pass 替换
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]
    if (!token) return ''
    const lang = (token.info.trim().split(/\s+/)[0] || 'text').toLowerCase()
    const code = token.content
    if (lang === 'mermaid') {
      return `<pre class="at-mermaid-src" data-mermaid${lineAttr(token)}>${escapeHtml(code)}</pre>\n`
    }
    return (
      `<div class="language-${escapeHtml(lang)}"${lineAttr(token)}><button class="at-copy" aria-label="复制代码"></button>` +
      `<span class="lang">${escapeHtml(lang)}</span>` +
      `<pre v-pre><code>${escapeHtml(code)}</code></pre></div>\n`
    )
  }

  // 行内代码：颜色字面量前置色块（只命中行内代码这一个语法位置）
  const defaultCodeInline =
    md.renderer.rules.code_inline ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    const color = ctx.colorChips ? colorLiteral(token.content) : null
    if (!color) return defaultCodeInline(tokens, idx, options, env, self)
    return (
      `<code class="at-color-literal"><span class="at-color-chip" aria-hidden="true" style="background-color:${color}"></span>` +
      `${escapeHtml(token.content)}</code>`
    )
  }

  // 表格：包一层滚动容器（5 列表格在窄阅读列里会把中文压成逐字竖排）
  const defaultTableOpen =
    md.renderer.rules.table_open ??
    ((tokens, idx, options_, _env, self) => self.renderToken(tokens, idx, options_))
  md.renderer.rules.table_open = (tokens, idx, options_, env, self) =>
    `<div class="at-table-wrap">${defaultTableOpen(tokens, idx, options_, env, self)}`
  const defaultTableClose =
    md.renderer.rules.table_close ??
    ((tokens, idx, options_, _env, self) => self.renderToken(tokens, idx, options_))
  md.renderer.rules.table_close = (tokens, idx, options_, env, self) =>
    `${defaultTableClose(tokens, idx, options_, env, self)}</div>\n`

  if (ctx.sourceLines) annotateSourceLines(md, ctx.lineOffset)
  promoteTermParagraphs(md, () => ctx.termBlocks)
  taskLists(md)

  return md
}

/** 渲染一篇文档：frontmatter + 正文 HTML + 大纲（h2/h3） */
export function renderMarkdown(
  src: string,
  docPath: string,
  options: RenderOptions = {},
): RenderResult {
  const { data, content: rawContent, error, lineOffset } = splitFrontmatter(src)
  const sourceLines = options.sourceLines === true
  const content = extractPluginBlocks(
    rawContent,
    options.containerSyntax ?? [],
    sourceLines ? lineOffset : null,
  )
  const outline: OutlineEntry[] = []
  const md = createMarkdownIt({
    docPath,
    prefix: options.urlPrefix ?? '',
    // 未显式给出时图片与链接同前缀（分享页、容器版都是同一地址空间）
    assetPrefix: options.assetPrefix ?? options.urlPrefix ?? '',
    colorChips: data.colors !== false,
    termBlocks: data.terms !== false,
    lineOffset: sourceLines ? lineOffset : 0,
    sourceLines,
    onAnchor: (token, info) => {
      const level = Number(token.tag.slice(1))
      if (level === 2 || level === 3) outline.push({ level, text: info.title, id: info.slug })
    },
  })
  const html = md.render(content)
  const h1 = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? null
  return { html, frontmatter: data, h1, outline, error }
}

export interface FrontmatterSnapshot {
  data: Frontmatter
  /** frontmatter 结束位置（含闭合 `---` 与其后换行）；无 frontmatter 时为 0 */
  end: number
  /** 解析失败时的可读错误；此时 data 为空对象、end 为 0 */
  error: string | null
}

/**
 * 只读 frontmatter（不渲染正文）。
 *
 * 为什么单独导出：编辑态的 Live Preview 需要同一份 frontmatter 数据来给组件卡片
 * 喂 props。此前那里手写了一个「只认两层 key: 标量」的迷你解析器，遇到数组/嵌套
 * 对象（`endpoints:` / `decisions:`）会把数据啃成空串与散落标量——组件拿到坏 props
 * 后渲染成空壳，阅读态却正常，形成「同一篇文档两种结果」。
 * 解析规则只能有一份：这里就是那份。
 */
export function readFrontmatter(src: string): FrontmatterSnapshot {
  const { data, content, error } = splitFrontmatter(src)
  // 解析失败时 splitFrontmatter 原样返回 content（含 frontmatter 原文），end 记 0
  const end = error ? 0 : src.length - content.length
  return { data, end, error }
}
