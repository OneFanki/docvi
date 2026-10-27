import { EditorState, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'

import type { ComponentRegistry } from '@docvi/renderer-core'

import { createLivePreview, refreshDecorations } from './live-preview.ts'
import { headingBadge } from './heading-badge.ts'
import { contextReporter, type ContextCallbacks } from './context.ts'
import { emptyLineHint } from './hint.ts'
import { leadingWhitespace } from './leading-whitespace.ts'

/**
 * CM6 装配。
 *
 * 三条取舍：
 *  1. **不引入任何 CM6 官方主题**：所有视觉都走 `--dv-ed-*`（编辑器主题维度），
 *     这样才能与「UI 主题 / 文档主题」三者独立切换。
 *  2. 阅读模式**不挂载 CM6**（design 7.1）——零编辑器开销是本项目读优先的体现。
 *  3. 语法高亮用最小 HighlightStyle：Markdown 只是源码，不是代码文件，
 *     不需要 CM6 那套完整的代码着色体系。
 */

/** 主题隔间：切换外观时只重配主题，不重建文档与撤销栈 */
const themeCompartment = new Compartment()
/** 装饰隔间：三种模式（源码 / 实时预览）只换这一层 */
const decorationsCompartment = new Compartment()
/** 行号隔间：只有源码模式带行号与行首空白点 */
const gutterCompartment = new Compartment()
/**
 * 折行隔间。
 *
 * 默认折行——文档不是代码，横向滚动会让读者左右找丢失的行首；
 * 但表格、宽代码块这类内容的作者可能希望「一行就是一行」，所以要能切。
 * 用隔间是为了切换时不重建编辑器：重建会丢掉撤销栈与滚动位置。
 */
const wrapCompartment = new Compartment()

/**
 * Markdown 语法着色：只区分结构层级，且**只改颜色不改字重/斜体**。
 *
 * 为什么不带 fontWeight / fontStyle：源码模式下必须「所见即文件内容」——
 * 给 `**加粗**` 的文字加粗会让用户以为加粗效果已经生效（其实只是语法树标记）；
 * 实时预览里的加粗由装饰层的 `.cm-lp-strong` 提供，职责分开。
 */
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--dv-ed-md-heading)' },
  { tag: tags.strong, color: 'var(--dv-ed-md-strong)' },
  { tag: tags.emphasis, color: 'var(--dv-ed-md-emphasis)' },
  { tag: tags.link, color: 'var(--dv-ed-md-link)' },
  { tag: tags.url, color: 'var(--dv-ed-md-link)' },
  { tag: tags.monospace, color: 'var(--dv-ed-md-code)' },
  { tag: tags.quote, color: 'var(--dv-ed-md-quote)' },
  { tag: tags.list, color: 'var(--dv-ed-md-marker)' },
  { tag: tags.processingInstruction, color: 'var(--dv-ed-md-marker)' },
  { tag: tags.contentSeparator, color: 'var(--dv-ed-md-marker)' },
  { tag: tags.comment, color: 'var(--dv-ed-syntax-comment)' },
])

/**
 * 编辑器主题：颜色全部取自 `--dv-ed-*`，由 `:root[data-theme]` 提供。
 *
 * 字号与行高**直接读正文令牌**（`--dv-content-font-size` / `--dv-content-line-height`），
 * 不写字面量。编辑的是文档不是代码，用 IDE 那种 13px 等宽会立刻让用户觉得
 * 「这是程序员工具」。
 *
 * ⚠️ 这两个值必须与阅读态同一个来源。此前这里硬编码 15.5px / 1.75，而阅读态
 * 用 16px / 1.8，切模式时整篇文字会跳一下字号、行距与左边距（实测正文左边缘
 * 差 8px、行高差 1.7px），用户观感是「实时预览没对准」。tokens.css 里本来就有
 * 这两个令牌，只是没人消费——现在接上。
 */
const editorTheme = EditorView.theme({
  '&': {
    color: 'var(--dv-ed-text)',
    backgroundColor: 'var(--dv-ed-bg)',
    fontSize: 'var(--dv-content-font-size, 16px)',
    height: '100%',
  },
  /*
   * 整列（行号槽 + 正文）一起居中，不是各自居中。
   *
   * CM6 的 scroller 是 flex 行：gutters 与 content 是兄弟。只给 content 加
   * max-width + auto 边距，会让 content 在「扣掉 gutter 后的剩余空间」里居中，
   * 结果行号贴左缘、正文在屏幕中间（实测差 200px）。
   * 把宽度约束加在 scroller 上，gutters 就自然紧贴正文左缘。
   */
  '.cm-scroller': {
    fontFamily: 'var(--dv-ed-font)',
    lineHeight: 'var(--dv-content-line-height, 1.8)',
    overflow: 'auto',
    width: '100%',
    maxWidth: 'var(--dv-content-max, none)',
    margin: '0 auto',
  },
  '.cm-content': {
    // 上留白与阅读态的 `.reader__page` 同为 40px，切模式时首行不上下跳
    padding: '40px 0 40vh',
    caretColor: 'var(--dv-ed-caret)',
  },
  // 左侧留白收窄到 14px：缩进（每级 2 个空格）必须能在分界线附近看出来。
  // 原来左右都留 32px，正文离行号区太远，首行有无空格在视觉上完全分辨不出。
  '.cm-line': { padding: '0 32px 0 14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dv-ed-caret)', borderLeftWidth: '2px' },
  /*
   * 选区：四件事必须一起做，少一件就会「选中了但看不见」或者「点不动」。
   *
   * 1. **盖在正文之上**（`z-index`）。CM6 默认把选区层放在文字**下面**（负
   *    z-index），于是任何有背景的行内元素都会把它盖掉——最典型的是光标所在
   *    行（`.cm-activeLine` 是不透明底色），用户拖选一整段时，最后一行的选区
   *    完全消失，看起来像「没选中」。行内代码的色块也有同样的问题。
   *    提到 1（光标层在 150，仍在最上）后，选区变成半透明覆盖层，文字透过它
   *    依然清晰。
   * 2. **层必须 `pointer-events: none`**。这是抬高层级的必经配套：选区矩形
   *    一旦能接事件，用户在有选区的情况下点选区内就会点不动（实测：选中一段
   *    后点任意一行，光标完全不移动，连选区的「已选中」状态都不会折叠）。
   *    选区层是纯视觉层，事件必须穿到下面的正文。
   * 3. **必须 `!important`**。`EditorView.theme` 没声明 `dark`，CM6 会把编辑器
   *    当成浅色，用 `&light.cm-focused > .cm-scroller > … .cm-selectionBackground`
   *    这条高特异度规则画出它自己的淡紫（#d7d4f0）——品牌色失效，而且在深色
   *    主题里那抹淡紫和正文区域对不上。普通声明压不过它。
   * 4. **`::selection` 也一起给**：没有 drawSelection 的场景（例如宿主里嵌的
   *    原生可编辑区）走浏览器原生选中，同样要跟着主题色。
   */
  '.cm-selectionLayer': { zIndex: '1 !important', pointerEvents: 'none !important' },
  '.cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--dv-ed-selection) !important',
    pointerEvents: 'none !important',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--dv-ed-selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--dv-ed-search-match)' },
  '.cm-searchMatch': { backgroundColor: 'var(--dv-ed-search-match)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--dv-ed-search-match-selected)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--dv-ed-gutter-bg)',
    color: 'var(--dv-ed-gutter-text)',
    // 行号与正文之间必须有可见的竖直分界：否则看源码时「这一行前面到底有没有空格」
    // 无从判断——行号与文字之间的空白既可能是缩进，也可能只是间隙
    borderRight: '1px solid var(--dv-ed-gutter-border)',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    // 行号右对齐 + 右侧留白：数字与分界线之间留出呼吸，缩进才显得是从界线开始的
    padding: '0 10px 0 14px',
    minWidth: '0',
  },
  '.cm-activeLine': { backgroundColor: 'var(--dv-ed-active-line)' },
  /*
   * 行首空白点：缩进从「一段看不清的留白」变成可数的点。
   *
   * 用背景绘制而不是塞字符：塞字符会改动文档内容（复制、查找、保存全被污染）。
   * 每个空格是一个独立 span（见 leading-whitespace.ts），所以点自然落在各自字形中央，
   * 不依赖字体是否等宽。
   */
  '.cm-leadingSpace': {
    backgroundImage:
      'radial-gradient(circle at center, var(--dv-ed-whitespace-dot) 0.9px, transparent 1.2px)',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
  '.cm-leadingTab': {
    backgroundImage:
      'radial-gradient(circle at center, var(--dv-ed-whitespace-dot) 1.4px, transparent 1.8px)',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--dv-ed-gutter-active)' },
  '.cm-panels': {
    backgroundColor: 'var(--dv-ed-panel)',
    color: 'var(--dv-ed-text)',
    borderColor: 'var(--dv-ed-panel-border)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--dv-ed-panel-border)' },
  '.cm-textfield': {
    backgroundColor: 'var(--dv-ed-bg)',
    color: 'var(--dv-ed-text)',
    border: '1px solid var(--dv-ed-panel-border)',
  },
  '.cm-button': {
    backgroundColor: 'var(--dv-ed-panel)',
    color: 'var(--dv-ed-text)',
    backgroundImage: 'none',
    border: '1px solid var(--dv-ed-panel-border)',
  },
  '.cm-placeholder': { color: 'var(--dv-ed-placeholder)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--dv-ed-matching-bracket)' },
})

export interface CreateEditorOptions {
  doc: string
  parent: HTMLElement
  /** live = 实时预览（光标行展开源码），source = 纯源码 */
  mode: 'live' | 'source'
  /** 组件注册表：块级组件卡片与阅读态共用 */
  registry: ComponentRegistry
  /**
   * 插件声明的容器语法（`::: merged` 之类），与阅读视图同一份。
   * 缺省时容器块按普通文本显示——不会假装渲染一个没注册的语法。
   */
  containerSyntax?: Array<{ name: string; component: string; form?: 'container' | 'fence' }>
  /** 文档在内容根内的相对路径：块内图片按它解析相对引用 */
  docPath?: string
  /** 图片前缀（桌面端 `docvi://asset/<工作区>`，容器 `/<仓库>`），与阅读视图同一份 */
  assetPrefix?: string
  placeholder?: string
  /**
   * 空行提示文案（实时预览专用，例如「输入 / 插入内容」）。
   *
   * 与 `placeholder` 的区别：placeholder 只在**整篇为空**时出现，
   * 这里针对的是「文档中间新起一行、光标停在空行」——用户此刻最不知道能做什么。
   */
  emptyHint?: string
  onChange?: (text: string) => void
  onSave?: () => void
  /** 滚动上报：`topLine` 是视口顶部的 0-based 源行（分屏按源行同步用） */
  onScroll?: (payload: { topLine: number; ratio: number }) => void
  /** 斜杠菜单 / 选区气泡的上下文上报（见 context.ts） */
  context?: ContextCallbacks
  /** 点击「编辑表格」按钮：宿主打开网格编辑器 */
  onEditTable?: (payload: { from: number; to: number; source: string }) => void
  /** 源码模式是否折行（默认 true）；实时预览恒折行，不受此项影响 */
  wrap?: boolean
}

export interface EditorHandle {
  view: EditorView
  getText(): string
  setText(text: string): void
  setMode(mode: 'live' | 'source'): void
  /** 文档主题变了：块级 Widget 的配色来自文档主题，需要重建 */
  refresh(): void
  getScroll(): number
  restoreScroll(top: number): void
  /**
   * 滚动比例（0–1）。
   *
   * 分屏同步用它而不是像素：左右两侧内容高度不同（左侧等宽源码、右侧
   * 排过版的正文），按像素对齐会越滚越偏。不可滚动时返回 0。
   */
  getScrollRatio(): number
  /** 按比例滚动（0–1）：右侧渲染完成后回同步用 */
  scrollToRatio(ratio: number): void
  /**
   * 视口顶部所在文档的 0-based 行号。
   *
   * 分屏同步的**主通道**：阅读侧每个块都带 `data-source-line`，按源行对齐
   * 才是结构上正确的同步——两侧内容高度比例不同（源码里一行表格渲染后可能
   * 是几十行），按滚动百分比同步必然越滚越偏。
   */
  getTopLine(): number
  focus(): void
  destroy(): void
  /** 当前选区（已归一化：from <= to） */
  selection(): { from: number; to: number; empty: boolean }
  /** 替换区间并保留撤销栈（一次变更） */
  replaceRange(from: number, to: number, text: string): void
  /**
   * 一次事务应用多处变更（位置都相对当前文档），可选设置光标。
   * 斜杠插入富组件时「写文件头 + 写正文」必须是同一事务，否则撤销会留半截。
   */
  applyChanges(changes: Array<{ from: number; to: number; insert: string }>, caret?: number): void
  /** 包裹选区（加粗 / 斜体 / 行内代码） */
  wrapSelection(marker: string): void
  /** 把当前行设为标题级别（0 = 取消） */
  setHeading(level: number): void
  /**
   * 切换行前缀（列表 / 引用）。
   *
   * 作用范围是**选区覆盖的所有行**，不是只看光标那一行——用户选中三段文字
   * 点「无序列表」，期望三段都变成列表项。同一前缀再点一次即取消（与
   * `wrapSelection` 的来回切语义一致）。
   */
  toggleLinePrefix(kind: LinePrefixKind): void
  /** 插入链接：有选中文字则包成 [文字](url)，否则插入 [](url) 并选中文字位 */
  insertLink(url: string): void
  /** 光标放到指定位置并滚进视野 */
  gotoPos(pos: number): void
  /** 源码折行开关（不重建编辑器，保留撤销栈与滚动位置） */
  setWrap(wrap: boolean): void
}

/**
 * 行前缀类型：无序列表 / 有序列表 / 引用。
 *
 * 只做这三种——它们是「行开头的标记」，与选区气泡里其它「文字包裹型」操作
 * （加粗、斜体）语义不同，但用户心里是同一组「把这段变个样子」。
 */
export type LinePrefixKind = 'bullet' | 'ordered' | 'quote'

/** 各前缀的正则：识别「这一行已经是这个前缀」用 */
const PREFIX_PATTERNS: Record<LinePrefixKind, RegExp> = {
  bullet: /^(\s*)[-*+]\s+/,
  ordered: /^(\s*)\d+[.)]\s+/,
  quote: /^(\s*)>\s?/,
}

/**
 * 切换选区覆盖的每一行的行前缀。
 *
 * 三条与 Markdown 语义绑定的规则：
 *  1. **全部已带该前缀 → 全部取消**；否则**全部加上**。混合状态按「加上」处理，
 *     这是列表编辑里最不容易出错的默认（Word / 飞书同此）。
 *  2. 缩进保留：`  - item` 变成 `  1. item`，不要因为换前缀把嵌套层级抹掉。
 *  3. 先剥掉「另一种行前缀」再套新的：`- item` 点有序列表应变成 `1. item`，
 *     不能叠成 `1. - item`。标题（`#`）不在此列——它是块级语义，宁可叠加也
 *     不擅自清掉用户写的标题。
 */
function toggleLinePrefix(view: EditorView, kind: LinePrefixKind): void {
  const range = view.state.selection.main
  const first = view.state.doc.lineAt(Math.min(range.from, range.to))
  const last = view.state.doc.lineAt(Math.max(range.from, range.to))
  const lines: Array<{ from: number; to: number; text: string }> = []
  for (let n = first.number; n <= last.number; n += 1) {
    const line = view.state.doc.line(n)
    lines.push({ from: line.from, to: line.to, text: line.text })
  }
  if (!lines.length) return

  // 空行不参与：给一段末尾的空行加 `- ` 会制造一个空列表项
  const candidates = lines.filter(line => line.text.trim() !== '')
  if (!candidates.length) return

  const own = PREFIX_PATTERNS[kind]
  const allHave = candidates.every(line => own.test(line.text))
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let ordered = 0

  for (const line of candidates) {
    // 先把三种行前缀都剥掉（保留缩进），再按需套上目标前缀
    let body = line.text
    let indent = ''
    for (const pattern of Object.values(PREFIX_PATTERNS)) {
      const match = pattern.exec(body)
      if (match) {
        indent = match[1] ?? ''
        body = body.slice(match[0].length)
        break
      }
    }
    if (!indent) indent = /^(\s*)/.exec(line.text)?.[1] ?? ''

    let next = `${indent}${body}`
    if (!allHave) {
      ordered += 1
      if (kind === 'bullet') next = `${indent}- ${body}`
      else if (kind === 'ordered') next = `${indent}${ordered}. ${body}`
      else next = `${indent}> ${body}`
    }
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }

  if (!changes.length) return
  view.dispatch({ changes })
  view.focus()
}

/**
 * 判断选区是否已被同一标记包裹。
 *
 * 单字符标记（`*` / `` ` ``）要额外排除「多字符标记的一部分」：
 * `**加粗**` 里 from-1 是 `*`，若不检查再前一个字符，点斜体就会把加粗拆成斜体。
 */
function wrappedBy(doc: string, from: number, to: number, marker: string): boolean {
  const before = doc.slice(Math.max(0, from - marker.length), from)
  const after = doc.slice(to, to + marker.length)
  if (before !== marker || after !== marker) return false
  if (marker.length !== 1) return true
  // 前/后再紧贴一个同字符 → 属于更长的标记（** / __ 等），不当作本标记
  return doc[from - 2] !== marker && doc[to + 1] !== marker
}

/**
 * 用标记包裹选区（加粗 / 斜体）。
 *
 * 三个细节：
 *  1. 选区已被同一标记包裹 → **取消**包裹（同一个键来回切，不需要记状态）；
 *  2. 无选区时插入一对标记并把光标放在中间，用户接着打字即可；
 *  3. 反向选区（anchor > head）要归一化，否则插入位置会落到选区外侧。
 */
function toggleWrap(view: EditorView, marker: string): boolean {
  const { state } = view
  const range = state.selection.main
  const from = Math.min(range.from, range.to)
  const to = Math.max(range.from, range.to)
  const doc = state.doc.toString()
  const len = marker.length

  if (from !== to && wrappedBy(doc, from, to, marker)) {
    view.dispatch({
      changes: [
        { from: from - len, to: from },
        { from: to, to: to + len },
      ],
      selection: { anchor: from - len, head: to - len },
    })
    return true
  }

  if (from === to) {
    view.dispatch({
      changes: { from, insert: `${marker}${marker}` },
      selection: { anchor: from + len },
    })
    return true
  }

  view.dispatch({
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: { anchor: from + len, head: to + len },
  })
  return true
}

export function createEditor(options: CreateEditorOptions): EditorHandle {
  const { parent, doc, mode } = options
  let currentMode = mode

  // 两个模式的装饰层都提前构造：切换时只替换隔间内容，不重建文档
  const liveExtension: Extension = [
    createLivePreview({
      registry: options.registry,
      containerSyntax: options.containerSyntax ?? [],
      ...(options.docPath ? { docPath: options.docPath } : {}),
      ...(options.assetPrefix ? { assetPrefix: options.assetPrefix } : {}),
      ...(options.onEditTable ? { onEditTable: options.onEditTable } : {}),
    }),
    /*
     * 标题悬浮徽标只在实时预览出现：源码模式的承诺是「所见即文件」，
     * 在行首浮一个 H1 按钮会与「这里就是 Markdown 原文」相矛盾。
     */
    headingBadge(),
    /*
     * 空行提示只在实时预览挂：它引导的是「输入 / 插入内容」这种可视化入口，
     * 源码模式的承诺是「所见即文件」，多一句浮字就破了这个承诺。
     * 放进同一个隔间是为了让 setMode 一并切换——单独挂会在切到源码后残留。
     */
    ...(options.emptyHint ? [emptyLineHint(options.emptyHint)] : []),
  ]

  const extensions: Extension[] = [
    history(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // 行号只在源码模式出现：文档编辑不是写代码，常驻行号是代码编辑器的视觉包袱
    gutterCompartment.of(currentMode === 'source' ? [lineNumbers(), leadingWhitespace()] : []),
    wrapCompartment.of(options.wrap === false ? [] : EditorView.lineWrapping),
    // base 必须是 markdownLanguage（含 GFM）——默认的 commonmark 解析不出表格节点
    markdown({ base: markdownLanguage }),
    syntaxHighlighting(markdownHighlight),
    // 只保留文档编辑需要的键位：默认键位里有大量代码编辑语义（补全、折叠）
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          options.onSave?.()
          return true
        },
      },
      { key: 'Mod-b', preventDefault: true, run: view => toggleWrap(view, '**') },
      { key: 'Mod-i', preventDefault: true, run: view => toggleWrap(view, '*') },
    ]),
    themeCompartment.of(editorTheme),
    decorationsCompartment.of(currentMode === 'live' ? liveExtension : []),
  ]

  // 上下文上报只挂在编辑态：没有它，斜杠菜单与选区气泡就拿不到真实屏幕坐标
  if (options.context) extensions.push(contextReporter(options.context))

  if (options.placeholder) extensions.push(cmPlaceholder(options.placeholder))

  if (options.onChange || options.onSave) {
    extensions.push(
      EditorView.updateListener.of(update => {
        if (update.docChanged) options.onChange?.(update.state.doc.toString())
      }),
    )
  }

  if (options.onScroll) {
    const onScroll = options.onScroll
    extensions.push(
      EditorView.domEventHandlers({
        scroll: (_event, view) => {
          // 两个量一起报：阅读侧优先用源行对齐，取不到块时才回落到比例
          const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
          const el = view.scrollDOM
          const range = el.scrollHeight - el.clientHeight
          onScroll({
            topLine: view.state.doc.lineAt(block.from).number - 1,
            ratio: range > 0 ? el.scrollTop / range : 0,
          })
          return false
        },
      }),
    )
  }

  const view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  })

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      // 全量替换：外部重载（文件被外部修改）走这条，保留撤销栈里的一次记录
      const current = view.state.doc.toString()
      if (current === text) return
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      })
    },
    setMode(next) {
      currentMode = next
      view.dispatch({
        effects: [
          decorationsCompartment.reconfigure(next === 'live' ? liveExtension : []),
          gutterCompartment.reconfigure(
            next === 'source' ? [lineNumbers(), leadingWhitespace()] : [],
          ),
        ],
      })
    },
    refresh() {
      refreshDecorations(view)
    },
    getScroll: () => view.scrollDOM.scrollTop,
    restoreScroll(top) {
      view.scrollDOM.scrollTop = top
    },
    getScrollRatio() {
      const el = view.scrollDOM
      const range = el.scrollHeight - el.clientHeight
      return range > 0 ? el.scrollTop / range : 0
    },
    scrollToRatio(ratio) {
      const el = view.scrollDOM
      const range = el.scrollHeight - el.clientHeight
      if (range <= 0) return
      el.scrollTop = Math.max(0, Math.min(1, ratio)) * range
    },
    getTopLine() {
      // scrollTop 是相对滚动容器内容顶部的偏移，lineBlockAtHeight 也按同一坐标系
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop)
      return view.state.doc.lineAt(block.from).number - 1
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    selection() {
      const range = view.state.selection.main
      const from = Math.min(range.from, range.to)
      const to = Math.max(range.from, range.to)
      return { from, to, empty: from === to }
    },
    replaceRange(from, to, text) {
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      })
      view.focus()
    },
    applyChanges(changes, caret) {
      if (!changes.length) return
      view.dispatch({
        changes,
        ...(caret === undefined ? {} : { selection: { anchor: caret } }),
      })
      view.focus()
    },
    wrapSelection(marker) {
      toggleWrap(view, marker)
      view.focus()
    },
    setHeading(level) {
      const range = view.state.selection.main
      const line = view.state.doc.lineAt(range.head)
      const current = /^(#{1,6})\s+/.exec(line.text)
      const body = current ? line.text.slice(current[0].length) : line.text
      // level = 0：去掉标题标记；否则设置成对应级别（点同一级别不叠加）
      const same = current && current[1]?.length === level
      const next = level === 0 || same ? body : `${'#'.repeat(level)} ${body}`
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: next },
        selection: { anchor: line.from + next.length },
      })
      view.focus()
    },
    toggleLinePrefix(kind) {
      toggleLinePrefix(view, kind)
    },
    insertLink(url) {
      const range = view.state.selection.main
      const from = Math.min(range.from, range.to)
      const to = Math.max(range.from, range.to)
      if (from === to) {
        // 没有选中文字：插入空文字位并把光标停在括号里，用户直接输入链接文字
        view.dispatch({
          changes: { from, insert: `[](${url})` },
          selection: { anchor: from + 1 },
        })
      } else {
        const text = view.state.doc.sliceString(from, to)
        view.dispatch({
          changes: { from, to, insert: `[${text}](${url})` },
          selection: { anchor: from + text.length + url.length + 4 },
        })
      }
      view.focus()
    },
    gotoPos(pos) {
      const clamped = Math.max(0, Math.min(pos, view.state.doc.length))
      view.dispatch({ selection: { anchor: clamped } })
      view.focus()
    },
    setWrap(wrap) {
      view.dispatch({ effects: wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []) })
    },
  }
}
