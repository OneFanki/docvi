import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import {
  findPluginBlocks,
  renderMarkdown,
  readFrontmatter,
  type ComponentRegistry,
  type DeclarativeMount,
  type PluginSyntaxDeclaration,
} from '@docvi/renderer-core'

/**
 * Live Preview 装饰层（飞书手感）。
 *
 * 三条硬规则（design 7.3）：
 *  1. **行内语法永远隐形**：`#`、`**`、反引号、`-`、`>`、链接的 `[..](url)` 等标记
 *     任何时刻都不显示（含光标所在行），只保留渲染后的样式。这是「所见即成品」的前提。
 *  2. **IME 冻结**：组合输入期间不重建装饰，否则中文输入法会被中途改写打断。
 *  3. **块级组件不参与选区**：块 Widget（代码块 / 表格 / 组件卡片 / 插件容器）覆盖的
 *     区间一旦与选区相交就退回源码文本，否则用户无法把光标放进块里编辑。
 *     这是能力边界，与规则 1 不是一回事：行内标记藏掉后照样能编辑，块级结构
 *     藏掉后却没有可编辑的落点，所以只有块级保留光标守卫。
 *
 * 为什么装饰只重建、不改文档：Markdown 原文是唯一事实源。所有渲染都是
 * 「在原文上覆盖一层替换装饰」，任何时刻关掉装饰就能回到完整源码。
 */

export interface LivePreviewOptions {
  /** 组件注册表：块级组件卡片与阅读态共用同一个，保证两处渲染一致 */
  registry: ComponentRegistry
  /**
   * 插件声明的容器语法（`::: merged` 之类）。
   *
   * 编辑态必须与阅读态用同一份声明：否则同一个块在阅读时是卡片、编辑时是一坨
   * 裸 YAML，用户会以为「插入的组件坏了」。真实注册表在宿主手里，这里只接收结论。
   */
  containerSyntax?: PluginSyntaxDeclaration[]
  /**
   * 当前文档在内容根内的相对路径。
   *
   * 块内渲染要按它解析相对图片（`![](img/a.png)` 相对**文档所在目录**）；
   * 不传时退化成根目录，写在子目录里的文档会取错图片。
   */
  docPath?: string
  /**
   * 图片前缀（桌面端为 `docvi://asset/<工作区>`，容器为 `/<仓库>`）。
   *
   * 与阅读视图同一份：编辑态与阅读态看到同一张图，不能一边能显示一边破图。
   */
  assetPrefix?: string
  /** 点击块内的「编辑表格」按钮：把源码区间交给宿主打开网格编辑器 */
  onEditTable?: (payload: { from: number; to: number; source: string }) => void
  /** 点击图片块：把源码区间交给宿主打开图片编辑弹窗 */
  onEditImage?: (payload: { from: number; to: number; source: string }) => void
}

/* ---------- 块级 Widget：复用同一条渲染管线 ---------- */

/**
 * 通用「把一段源码渲染成 HTML」的块 Widget。
 *
 * 关键复用点：块内容（代码块 / 表格 / 图片 / 组件卡片）不另写渲染器，而是把源码
 * 交给 renderer-core 的同一条管线，保证编辑态与阅读态**长得一模一样**——
 * 两套渲染器迟早会漂移，这是最贵的一类不一致。
 */
class RenderedBlockWidget extends WidgetType {
  readonly source: string
  readonly kind: string
  readonly fingerprint: string
  readonly frontmatter: Record<string, unknown> | null
  readonly registry: ComponentRegistry
  readonly tableEdit: {
    from: number
    to: number
    onEdit: (payload: { from: number; to: number; source: string }) => void
  } | null
  readonly imageEdit: RenderedBlockWidget['tableEdit']
  readonly containerSyntax: PluginSyntaxDeclaration[]
  readonly docPath: string
  readonly assetPrefix: string | undefined

  constructor(
    source: string,
    kind: string,
    fingerprint: string,
    frontmatter: Record<string, unknown> | null,
    registry: ComponentRegistry,
    tableEdit: RenderedBlockWidget['tableEdit'] = null,
    containerSyntax: PluginSyntaxDeclaration[] = [],
    docPath = 'live-preview.md',
    assetPrefix?: string,
    imageEdit: RenderedBlockWidget['tableEdit'] = null,
  ) {
    super()
    this.source = source
    this.kind = kind
    this.fingerprint = fingerprint
    this.frontmatter = frontmatter
    this.registry = registry
    this.tableEdit = tableEdit
    this.imageEdit = imageEdit
    this.containerSyntax = containerSyntax
    this.docPath = docPath
    this.assetPrefix = assetPrefix
  }

  /** kind + 内容指纹：内容没变就不重建 DOM（否则每次滚动都重建 → 闪烁 + 泄漏） */
  override eq(other: RenderedBlockWidget): boolean {
    return (
      other.fingerprint === this.fingerprint &&
      other.kind === this.kind &&
      other.tableEdit?.from === this.tableEdit?.from &&
      other.tableEdit?.to === this.tableEdit?.to &&
      other.imageEdit?.from === this.imageEdit?.from &&
      other.imageEdit?.to === this.imageEdit?.to
    )
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement('div')
    wrapper.className = `cm-lp-block cm-lp-block--${this.kind || 'md'}`
    wrapper.dataset.kind = this.kind

    const body = document.createElement('div')
    // 必须同时带 doc-surface：doc.css 的正文排版（表格边框、代码块、引用线）
    // 全部挂在 .doc-surface 后代选择器上，只加 at-doc 会让块内退化成裸文本
    body.className = 'doc-surface at-doc cm-lp-block__body'
    wrapper.appendChild(body)

    /*
     * 表格块右上角的「编辑表格」：点它打开网格编辑器，产物写回**同一段
     * Markdown 原文**（不转成组件、不加私有语法）。
     * 按钮放在块外沿（absolute），不挤压表格本身。
     */
    if (this.tableEdit) {
      const edit = this.tableEdit
      // 区间与原文一起写进 DOM：整块点击（见 tableBlockClickHandler）要读它，
      // 靠 posAtDOM 反推在缩进/相邻块的情况下会算错
      wrapper.dataset.tableFrom = String(edit.from)
      wrapper.dataset.tableTo = String(edit.to)
      wrapper.dataset.tableSource = this.source
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-lp-table-edit'
      button.textContent = '编辑表格'
      button.contentEditable = 'false'
      button.addEventListener('mousedown', event => {
        // 抢在 CM6 之前拦下：否则按下瞬间光标会进入块区间、块装饰被撤掉，按钮当场消失
        event.preventDefault()
        event.stopPropagation()
        edit.onEdit({ from: edit.from, to: edit.to, source: this.source })
      })
      wrapper.appendChild(button)
    }

    /*
     * 图片块：整块可点。
     *
     * 图片的「可编辑」入口不能只靠悬停按钮——图片本身占满整块，用户的
     * 第一反应就是点图。按钮只为可发现性存在（悬停时出现在右上角），
     * 点图片本体同样打开弹窗。
     */
    if (this.imageEdit) {
      const edit = this.imageEdit
      const open = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
        edit.onEdit({ from: edit.from, to: edit.to, source: this.source })
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'cm-lp-image-edit'
      button.textContent = '编辑图片'
      button.contentEditable = 'false'
      button.addEventListener('mousedown', open)
      wrapper.appendChild(button)
      wrapper.addEventListener('mousedown', event => {
        const target = event.target as HTMLElement | null
        if (!target?.closest('img')) return
        open(event)
      })
    }

    let mount: DeclarativeMount | null = null
    let disposed = false

    void import('@docvi/renderer-core').then(async core => {
      if (disposed) return
      try {
        // 组件卡片需要 frontmatter 里的数据：拼一页「只含该组件」的迷你文档走同一条管线
        const doc =
          this.kind === 'component' && this.frontmatter
            ? `---\ncomponents: ${JSON.stringify(this.frontmatter)}\n---\n\n${this.source}\n`
            : this.source
        // 块内图片要按**真实文档路径**解析相对引用：写死 live-preview.md 会让
        // 子目录文档里的 `![](img/a.png)` 全部取错；前缀与阅读视图同一份
        const result = renderMarkdown(doc, this.docPath, {
          containerSyntax: this.containerSyntax,
          ...(this.assetPrefix ? { assetPrefix: this.assetPrefix } : {}),
        })
        body.innerHTML = result.html
        if (this.kind === 'component') {
          mount = core.mountDeclarativeComponents(
            body,
            (result.frontmatter.components as
              Record<string, Record<string, unknown>> | undefined) ?? null,
            this.registry,
            { onMissing: () => undefined },
          )
        } else if (this.kind === 'container' || this.kind === 'fence') {
          // 结构化块的数据在块内 YAML，不走 frontmatter：挂载器读占位元素的 payload。
          // container 与 fence 共用同一条挂载路径——区别只在围栏长什么样，
          // 渲染时 source 里已经带着围栏行，extractPluginBlocks 统一处理。
          mount = core.mountPluginBlocks(body, this.registry, { onMissing: () => undefined })
        }
        await core.highlightPass(body)
        await core.mermaidPass(body, document.documentElement.dataset.theme !== 'paper')
      } catch {
        // 渲染失败保留源码文本，不打断编辑
        body.textContent = this.source
      }
    })

    // destroy() 拿不到闭包里的 mount，挂到元素上让 destroy 读取
    ;(wrapper as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
      disposed = true
      mount?.dispose()
      mount = null
    }

    return wrapper
  }

  override destroy(dom: HTMLElement): void {
    const cleanup = (dom as HTMLElement & { __cleanup?: () => void }).__cleanup
    cleanup?.()
  }

  /*
   * 高度估计必须给，且必须**明显大于一行**。
   *
   * ⚠️ 不实现这个 getter 时 CM6 用默认值（约一行高 20px）估算块 widget 的高度。
   * 而组件卡片实际可能是 200~400px（表格、图、时间线），估算与真实的差值会一直
   * 累积进高度预言机——表现为「表格之后的所有行，鼠标点到行中间偏下就跳到下一行」。
   * 实测：表格块实际 219.9px、按 20px 估，其后的行只有上部 35% 能命中本行。
   *
   * 这个值不要求精确（真实高度渲染后 CM6 会自己量），但量级必须对：宁可高估也不
   * 低估，低估会让点击坐标持续偏上。400px 覆盖绝大多数卡片，表格再多也只是让它
   * 更早被修正。
   */
  override get estimatedHeight(): number {
    return 400
  }

  /** 让事件冒泡给 CM6：点击卡片 = 把光标放进对应源码行 */
  override ignoreEvent(): boolean {
    return false
  }
}

/**
 * 折叠的 frontmatter：只显示条目数。
 *
 * 为什么默认折叠、且必须点一下才展开：这块是组件数据与页面元信息，写一次就不再动；
 * 实时预览里把它整段摊开，占满首屏又没人看得懂。点击后才把光标放进 frontmatter，
 * 由「光标在属性区内」的既有规则展开原文——想改的人点一下就能改。
 */
class FrontmatterWidget extends WidgetType {
  readonly keys: string[]

  constructor(keys: string[]) {
    super()
    this.keys = keys
  }

  override eq(other: FrontmatterWidget): boolean {
    return other.keys.join(',') === this.keys.join(',')
  }

  override toDOM(): HTMLElement {
    /*
     * ⚠️ 这个 widget 是 `block: true` 的替换装饰，DOM **必须是块级**。
     *
     * 原来是 `<span>` 加 `display: inline-flex`——块级替换装饰里放行内元素时，
     * CM6 的高度预言机按「一个块」记账，而真实 DOM 参与行内布局，两者口径不一致。
     * 后果不是显示错位（看起来完全正常），而是**点击命中错行**：整篇文档里
     * frontmatter 之后的所有行，鼠标点在行中间偏下就掉到下一行。
     * 实测同一篇文档：带 frontmatter 时命中率 68%~89%，去掉 frontmatter 后 100%。
     *
     * 用 div + flex：块级元素参与块布局，与装饰的语义一致。外观由 CSS 保证。
     */
    const chip = document.createElement('div')
    chip.className = 'cm-lp-frontmatter'
    chip.textContent = this.keys.length
      ? `属性 · ${this.keys.length} 项（${this.keys.slice(0, 3).join('、')}${this.keys.length > 3 ? '…' : ''}）`
      : '属性'
    chip.title = '点击展开编辑'
    return chip
  }

  /** 点击由 ViewPlugin 处理（要派发选区事务）；widget 自身不吞事件 */
  override ignoreEvent(): boolean {
    return false
  }
}

/** 无序列表的项目符号：替换 `-` / `*` / `+`，只改显示不改文档 */
class BulletWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const dot = document.createElement('span')
    dot.className = 'cm-lp-bullet'
    dot.textContent = '•'
    dot.setAttribute('aria-hidden', 'true')
    return dot
  }

  override ignoreEvent(): boolean {
    return true
  }
}

/** 任务列表的勾选框：点击即切换文档里的 `[ ]` / `[x]`（勾选状态由原文决定） */
class TaskBoxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  override eq(other: TaskBoxWidget): boolean {
    return other.checked === this.checked
  }

  override toDOM(): HTMLElement {
    const box = document.createElement('span')
    box.className = this.checked ? 'cm-lp-taskbox is-checked' : 'cm-lp-taskbox'
    box.textContent = this.checked ? '☑' : '☐'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.title = this.checked ? '标记为未完成' : '标记为完成'
    return box
  }

  /**
   * 必须让事件冒泡给 CM6。
   *
   * 返回 true（多数装饰部件的默认写法）时 CM6 会把部件内的事件当成「不是编辑器
   * 的事件」忽略掉，点击处理器永远收不到 mousedown——表现为「勾选框点不动」。
   */
  override ignoreEvent(): boolean {
    return false
  }
}

/** ListItem 的嵌套深度：外层每多一个 ListItem 就 +1 */
/**
 * 列表嵌套层级，**1 基**（最外层 = 1）。
 *
 * 必须返回 1 而不是 0：行装饰产出的类名是 `cm-lp-li-<depth>`，而 editor.css 里
 * 只定义了 `cm-lp-li-1` … `cm-lp-li-6`。此前最外层返回 0，落到 `cm-lp-li-0`——
 * 没有任何规则匹配，于是**第一级列表完全没有缩进**（实测 padding-left 停在
 * 基础值 14px，与阅读态的 1.5em 缩进对不上）。嵌套一层的项同样整体差一级。
 */
function listDepth(node: { parent: { name: string; parent: unknown } | null }): number {
  let depth = 0
  let current = node.parent as { name: string; parent: unknown } | null
  while (current) {
    if (current.name === 'ListItem') depth += 1
    current = current.parent as typeof current
  }
  return depth + 1
}

/* ---------- frontmatter 解析（编辑态需要它给组件卡片喂数据） ---------- */

interface FrontmatterInfo {
  /** 结束位置（含闭合 --- 与其后的换行） */
  end: number
  /**
   * `components` 段（组件卡片的数据源）。
   *
   * 只有这一段是编辑态真正要用的：块 Widget 需要它把数据喂给组件。
   * 其余键只用于「属性 · N 项」里列名字。
   */
  data: Record<string, Record<string, unknown>> | null
  keys: string[]
}

/**
 * 解析 frontmatter。
 *
 * ⚠️ 必须复用 renderer-core 的正式解析（`readFrontmatter`），不能在这里手写一份
 * 「两层 key: 标量」的简化版：组件数据普遍含数组与嵌套对象（`endpoints:` /
 * `decisions:`），简化版会把它们啃成空串与散落标量，组件拿到坏 props 渲染成空壳，
 * 而阅读态走正式解析一切正常——同一篇文档两种结果，用户只会当成随机故障。
 * 这里曾踩过：`endpoints` 变成 `''`，`props.endpoints.map()` 抛错，卡片全空白。
 */
function parseFrontmatter(text: string): FrontmatterInfo | null {
  const snapshot = readFrontmatter(text)
  if (snapshot.end === 0 && !snapshot.error) return null
  const data = snapshot.data
  const components =
    data.components && typeof data.components === 'object'
      ? (data.components as Record<string, Record<string, unknown>>)
      : null
  return {
    end: snapshot.end,
    data: components && Object.keys(components).length ? components : null,
    keys: Object.keys(data),
  }
}

/* ---------- 构建装饰 ---------- */

/** 选区覆盖的行号集合：这些行保持源码态 */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const start = state.doc.lineAt(range.from).number
    const end = state.doc.lineAt(range.to).number
    for (let line = start; line <= end; line += 1) lines.add(line)
  }
  return lines
}

function fingerprint(kind: string, source: string, extra = ''): string {
  let hash = 5381
  const text = `${kind}\u0000${extra}\u0000${source}`
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33) ^ text.charCodeAt(i)
  return `${text.length}:${hash >>> 0}`
}

/**
 * 构建结果：装饰本身 + 需要作为原子区间处理的隐藏标记。
 *
 * 分成两份而不是一份：`Decoration.replace` 只管显示，光标仍然可以落进被替换的
 * 区间；只有同时登记到 `atoms`（`atomicRanges`）才能让光标跳过它。
 */
interface BuildResult {
  decorations: DecorationSet
  atoms: DecorationSet
}

/**
 * 装饰字段的值：在构建结果之上多一枚**粘性**输入法冻结标记。
 *
 * 冻结必须粘住整个组合期，而不是只作用于第一个事务：组合输入跨多个事务
 * （每次按键一个新 transaction），只在首个事务带 effect 的话，后续按键仍会
 * 重建装饰、销毁块级 Widget，文档高度继续塌陷。所以状态要存进字段值里。
 */
interface DecorationValue extends BuildResult {
  frozen: boolean
}

/**
 * 构建装饰。
 *
 * ⚠️ 必须由 StateField 调用，不能由 ViewPlugin 提供——CM6 明确禁止插件提供
 * **块级**装饰（`Block decorations may not be specified via plugins`）：
 * 块装饰会改变行高与布局，必须由状态层持有才能在各视口重绘时保持一致。
 *
 * 构建区间恒为**全文**：不做视口窗口化（原因见 `decorationField` 的 update）。
 */
function buildDecorations(
  state: EditorState,
  options: LivePreviewOptions,
  frontmatterInfo: FrontmatterInfo | null,
): BuildResult {
  const active = activeLines(state)
  const builder: Array<{ from: number; to: number; decoration: Decoration }> = []
  /*
   * 被藏掉的行内标记区间，单独收一份给 `EditorView.atomicRanges`。
   *
   * 标记看不见以后，光标若停在区间**内部**，用户完全不知道自己站在 `**` 中间，
   * 敲字就会把字符插进标记里（`*X*`），原文被静默改坏。把它声明成原子区间后，
   * 光标移动、点击、方向键都会跳过整段，Backspace 一次删掉整对标记。
   */
  const atoms: Array<{ from: number; to: number; decoration: Decoration }> = []
  const doc = state.doc
  const text = doc.toString()

  /*
   * 拿到**整篇文档**的语法树。
   *
   * ⚠️ 两个陷阱叠在一起，这里都踩过：
   *
   * 1. **Lezer 是惰性增量解析**。它只保证当前视口附近的节点可用，文档其余
   *    部分可能还没解析。`syntaxTree(state)` 返回的就是这棵「局部树」——实测
   *    45KB 文档只拿到 3134 字符的树。用 `iterate` 遍历它，正文里的
   *    ATXHeading / Emphasis / ListItem 根本不存在，装饰自然建不出来。
   *
   * 2. **`ensureSyntaxTree` 的返回值才是完整树，`syntaxTree()` 不会因此变成
   *    完整树**。前者不会写回 state 缓存的视口树，只是额外解析并返回一份。
   *    所以必须先调它、再用它的返回值遍历，不能「调完 continue 用 syntaxTree」。
   *
   * 症状：带大 frontmatter 的长文档切到实时预览后，正文仍是 `## 标题`、
   * `**加粗**` 原样，点一下 / 滚动一下才逐渐渲染（交互挪了视口，解析器跟上）。
   * 小文档或没有 frontmatter 时视口树恰好覆盖全文，所以看起来「时好时坏」。
   */
  const tree = ensureSyntaxTree(state, doc.length, 100) ?? syntaxTree(state)

  const lineHasCursor = (lineNumber: number): boolean => active.has(lineNumber)
  const rangeHasCursor = (from: number, to: number): boolean => {
    const first = doc.lineAt(from).number
    const last = doc.lineAt(Math.max(from, to - 1)).number
    for (let line = first; line <= last; line += 1) if (active.has(line)) return true
    return false
  }

  /*
   * 块级替换：**保留光标守卫**。
   *
   * 代码块 / 表格 / 组件卡片 / 插件容器一旦被块 Widget 覆盖，选区就没有可落脚的
   * 源码位置——光标进不来也就改不了。所以光标（或选区）与块区间相交时必须退回
   * 源码文本，这是能力边界。
   *
   * 与行内标记的区别：`#`、`**` 这类标记只是**视觉噪音**，藏掉之后光标仍能落在
   * 行内、Backspace 仍能改写原文；块级结构不是噪音，藏掉就没了编辑入口。
   * 两者用同一个 hide() 处理会造成「块内不可编辑」，用同一个 block() 处理会留下
   * 「光标行冒出 `#`」，所以这里的分工必须继续存在。
   */
  const block = (from: number, to: number, kind: string, source: string, extra?: string): void => {
    if (rangeHasCursor(from, to)) return
    const startLine = doc.lineAt(from)
    const endLine = doc.lineAt(Math.max(from, to - 1))
    // 文档主题进指纹：主题切换会让块内配色变，指纹不变的话 CM6 会复用旧 DOM
    const theme = document.documentElement.dataset.theme ?? 'slate'
    builder.push({
      from: startLine.from,
      to: endLine.to,
      decoration: Decoration.replace({
        block: true,
        widget: new RenderedBlockWidget(
          source,
          kind,
          fingerprint(kind, source, `${extra ?? ''}\u0001${theme}`),
          frontmatterInfo?.data ?? null,
          options.registry,
          // 表格块的「编辑表格」按钮要能定位原文区间，位置在建立装饰时才知道
          kind === 'table' && options.onEditTable
            ? { from: startLine.from, to: endLine.to, onEdit: options.onEditTable }
            : null,
          options.containerSyntax ?? [],
          options.docPath ?? 'live-preview.md',
          options.assetPrefix,
          kind === 'image' && options.onEditImage
            ? { from: startLine.from, to: endLine.to, onEdit: options.onEditImage }
            : null,
        ),
      }),
    })
  }

  /**
   * 隐藏行内语法标记：**不看光标行，无条件隐藏**。
   *
   * 旧写法在光标所在行保留标记，用户看到的是「标题行还露着 `#`」，与飞书不一致。
   * 现在标记永远不可见，编辑能力靠「标记仍在文档里」保证：光标可以落在标记前后，
   * Backspace 改写原文后语法树重新解析，标记节点消失，样式自然回落。
   */
  const hide = (from: number, to: number): void => {
    if (to <= from) return
    const decoration = Decoration.replace({})
    builder.push({ from, to, decoration })
    atoms.push({ from, to, decoration })
  }

  /**
   * 行内样式：**不区分光标行**，始终生效。
   *
   * 旧写法在光标所在行整行跳过样式，于是「刚敲下 `# ` 的那一行」还是普通正文，
   * 要等光标移开才变成标题——用户报的正是这个：「要求我鼠标离开这一行才渲染」。
   * 现在样式与标记隐藏都始终生效，敲完立刻看到成品。
   */
  const style = (from: number, to: number, className: string): void => {
    if (to <= from) return
    builder.push({ from, to, decoration: Decoration.mark({ class: className }) })
  }

  /** 行级样式（标题字号、引用线、列表缩进）：同样始终生效 */
  const lineStyle = (lineNumber: number, className: string): void => {
    const line = doc.line(lineNumber)
    builder.push({
      from: line.from,
      to: line.from,
      decoration: Decoration.line({ class: className }),
    })
  }

  /*
   * frontmatter 折叠：光标在属性区内部才展开，否则折叠成属性卡。
   *
   * 「光标恰好在文档开头（offset 0）」不算进入 frontmatter——进入编辑模式时
   * 选区默认落在 0，若按普通行判定，所有带 frontmatter 的文档一进编辑态
   * 就顶着三行属性原文，属性卡等于永远不出现。
   */
  const cursorInsideFrontmatter =
    frontmatterInfo !== null &&
    state.selection.ranges.some(range => range.from > 0 && range.from < (frontmatterInfo?.end ?? 0))
  if (frontmatterInfo && !cursorInsideFrontmatter) {
    builder.push({
      from: 0,
      to: frontmatterInfo.end,
      decoration: Decoration.replace({
        block: true,
        widget: new FrontmatterWidget(frontmatterInfo.keys),
      }),
    })
  }

  /*
   * 遍历范围 = **全文**（frontmatter 之后）。
   *
   * 这里曾按 `viewport ± 2000px` 裁一段来遍历语法树，想把长文档的重建成本压
   * 下来。但视口在编辑器刚挂载 / 刚切换模式时还没测量，读到的是 0 或极小值，
   * 于是只遍历了文档开头——正文里的 `##`、`**`、列表全都保持源码形态。用户看到
   * 的就是「切到实时预览还是源码，点一下才渲染」：点击产生选区变化触发重建，
   * 而那次……同样被裁，只是起点变了，看起来「点一下就好了」。
   *
   * 实测 45KB 文档（1100+ 行）全文遍历后重建耗时仍在毫秒级，窗口化没有收益，
   * 只有这类静默缺失。删除。
   */
  tree.iterate({
    from: frontmatterInfo?.end ?? 0,
    to: doc.length,
    enter: ref => {
      const node = ref.node
      const name = node.name

      /* ---- 块级 ---- */

      if (name === 'FencedCode') {
        // 组件卡片：代码围栏写成 ```at-card {...} 也能出卡片（与行内标签等价）
        const raw = text.slice(ref.from, ref.to)
        const info = /^```+\s*([\w+-]*)/.exec(raw)?.[1] ?? ''
        block(ref.from, ref.to, /^at-|^component/.test(info) ? 'component' : info, raw)
        return false
      }

      if (name === 'Table') {
        block(ref.from, ref.to, 'table', text.slice(ref.from, ref.to))
        return false
      }

      if (name === 'HorizontalRule') {
        const line = doc.lineAt(ref.from)
        if (!lineHasCursor(line.number)) {
          builder.push({
            from: line.from,
            to: line.to,
            decoration: Decoration.replace({}),
          })
          builder.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({ class: 'cm-lp-hr' }),
          })
        }
        return false
      }

      /* ---- 标题 ---- */

      if (/^ATXHeading[1-6]$/.test(name)) {
        const level = Number(name.slice(-1))
        // 标题样式**始终生效**（含光标行）：敲完 `# ` 立刻变大，不用等光标离开
        lineStyle(doc.lineAt(ref.from).number, `cm-lp-heading cm-lp-h${level}`)
        return
      }

      if (name === 'HeaderMark') {
        /*
         * 连同标记后的分隔空格一起藏。
         *
         * `#` 只是语法，`# ` 里的那个空格也是语法的一部分——只藏 `#` 的话，
         * 标题文字会比行首多出半个字的缩进，看起来像「标题没对齐」。
         * 行尾的闭合 `#`（`## 标题 ##`）后面没有空格，扩展自然为 0。
         */
        const line = doc.lineAt(ref.from)
        let end = ref.to
        while (end < line.to && (text[end] === ' ' || text[end] === '\t')) end += 1
        hide(ref.from, end)
        return
      }

      /* ---- 行内 ---- */

      if (name === 'StrongEmphasis') {
        const inner = innerRange(node)
        if (inner) style(inner.from, inner.to, 'cm-lp-strong')
        return
      }
      if (name === 'Emphasis') {
        const inner = innerRange(node)
        if (inner) style(inner.from, inner.to, 'cm-lp-em')
        return
      }
      if (name === 'InlineCode') {
        const inner = innerRange(node)
        if (inner) style(inner.from, inner.to, 'cm-lp-code')
        return
      }
      if (name === 'Strikethrough') {
        const inner = innerRange(node)
        if (inner) style(inner.from, inner.to, 'cm-lp-strike')
        return
      }
      if (name === 'EmphasisMark' || name === 'CodeMark' || name === 'StrikethroughMark') {
        hide(ref.from, ref.to)
        return
      }

      /*
       * ---- 列表 ----
       *
       * 实时预览此前完全没有列表分支：`- 项` 只剩 `- 项` 这行纯文本，项目符号
       * 不改色、不缩进，任务列表的 `[ ]` 原样露出来。看起来像「列表语法没渲染」。
       *
       * 做法是**只改显示不改文档**：
       *  - 项目符号 `-`/`*`/`+` 藏掉，换成居中圆点；
       *  - 按嵌套深度加左缩进（行装饰 + 深度 class），层级一眼可见；
       *  - 任务列表 `[ ]`/`[x]` 换成方框字形。
       * 不用块 Widget：列表项要能放光标进去编辑，块级替换会让整项不可编辑。
       */
      if (name === 'ListItem') {
        // 缩进与层级始终生效：光标行也保持排版，不然打完 `- ` 要移开光标才缩进
        const depth = Math.min(listDepth(node), 6)
        lineStyle(doc.lineAt(ref.from).number, `cm-lp-li cm-lp-li-${depth}`)
        return
      }

      if (name === 'ListMark') {
        /*
         * 有序列表的数字保持原样：`1.` 本身就是读者要看的形态，换成符号反而丢信息。
         * 其余标记（`-` / `*` / `+`）无条件替换成圆点——光标行也一样，否则
         * 刚敲下 `- ` 时项目符号与缩进都要等光标移开才出现。
         */
        const line = doc.lineAt(ref.from)
        if (/^\s*\d+[.)]/.test(line.text)) return
        // 任务列表项由 TaskMarker 画勾选框，圆点会让一行出现两个符号
        if (/^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) {
          hide(ref.from, ref.to)
          return
        }
        hide(ref.from, ref.to)
        builder.push({
          from: ref.from,
          to: ref.from,
          decoration: Decoration.widget({ widget: new BulletWidget(), side: 1 }),
        })
        return
      }

      if (name === 'TaskMarker') {
        const checked = /\[[xX]\]/.test(text.slice(ref.from, ref.to))
        hide(ref.from, ref.to)
        builder.push({
          from: ref.from,
          to: ref.from,
          decoration: Decoration.widget({ widget: new TaskBoxWidget(checked), side: 1 }),
        })
        return
      }

      if (name === 'Link') {
        // 只留链接文字：`[` 与 `](url)` 都藏起来
        const marks = node.getChildren('LinkMark')
        const first = marks[0]
        const second = marks[1]
        if (!first || !second) return false
        hide(node.from, first.to)
        style(first.to, second.from, 'cm-lp-link')
        hide(second.from, node.to)
        return false
      }

      if (name === 'URL') {
        // 裸 URL（autolink）保留原样；图片与链接里的 URL 由上面的 Link 分支处理
        if (node.parent?.name === 'Image' || node.parent?.name === 'Link') hide(ref.from, ref.to)
        return
      }

      if (name === 'Image') {
        // 独占一行的图片渲染成块；行内图片保留源码（v1 明确取舍）
        const line = doc.lineAt(ref.from)
        if (line.from === ref.from && line.to === ref.to) {
          block(ref.from, ref.to, 'image', text.slice(ref.from, ref.to))
          return false
        }
        return
      }

      /* ---- 引用 ---- */

      if (name === 'Blockquote') {
        const first = doc.lineAt(ref.from).number
        const last = doc.lineAt(Math.max(ref.from, ref.to - 1)).number
        // 引用线始终画（光标行也画）；`>` 由 QuoteMark 分支无条件藏掉
        for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
          lineStyle(lineNumber, 'cm-lp-quote')
        }
        return
      }
      if (name === 'QuoteMark') {
        hide(ref.from, ref.to)
        return
      }

      return
    },
  })

  /* ---- 组件标签：<at-kind ... /> 独占一行 ---- */

  const componentTag = /^[ \t]*<at-([\w-]+)([\s\S]*?)\/?>[ \t]*$/
  for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
    const line = doc.line(lineNumber)
    const match = componentTag.exec(line.text)
    if (!match) continue
    block(line.from, line.to, 'component', line.text.trim())
  }

  /*
   * ---- 插件结构化块：`::: name` 容器与 ```` ```name ```` 围栏 ----
   *
   * 不用语法树：markdown-it 的容器扩展在 CM6 的 Lezer 语法里根本不存在，
   * `::: merged` 会被解析成普通段落；围栏虽然能被语法树认出来，但那是「代码块」，
   * 这里要的是把它换成组件卡片。
   *
   * 扫描实现来自 renderer-core 的 `findPluginBlocks`——与阅读态、导出、分享
   * **同一份**。曾经这里与渲染管线各写一份正则，结果缩进两格的收尾 `:::` 在
   * 编辑态被识别、阅读态不认，同一篇文档两处长得不一样。
   */
  const syntax = options.containerSyntax ?? []
  if (syntax.length) {
    const lines = Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).text)
    for (const span of findPluginBlocks(lines, syntax)) {
      const startLine = doc.line(span.startLine + 1)
      const endLine = doc.line(span.endLine + 1)
      // kind 用 form 而不是语法名：Widget 按 'container' / 'fence' 决定怎么重新渲染块
      block(startLine.from, endLine.to, span.form, text.slice(startLine.from, endLine.to))
    }
  }

  /*
   * 组装 RangeSet。
   *
   * 三个约束：
   *  1. **块装饰不能互相重叠**（CM6 硬约束）：嵌套块（列表里的代码块、引用里的表格）
   *     只保留外层先出现的那个，内层退回源码——否则运行期直接抛错。
   *  2. **行装饰与同位置的替换装饰必须共存**：行装饰长度为零，`Decoration.set(.., true)`
   *     会按 startSide 排好序，不能像旧写法那样把「同位置」当重叠丢掉。
   *  3. 交给库排序而不是自己拼 RangeSetBuilder：手写排序规则一旦漏一种 side 组合
   *     就会抛 "Ranges must be added sorted"，而这类错误只在特定文档上才出现。
   */
  const blocks = builder.filter(item => item.decoration.spec.block)
  const others = builder.filter(item => !item.decoration.spec.block)

  blocks.sort((a, b) => a.from - b.from || a.to - b.to)
  const keptBlocks: Array<{ from: number; to: number; decoration: Decoration }> = []
  let blockEnd = -1
  for (const block of blocks) {
    if (block.from < blockEnd) continue
    keptBlocks.push(block)
    blockEnd = block.to
  }

  const ranges = [...keptBlocks, ...others].map(item => item.decoration.range(item.from, item.to))
  return {
    decorations: Decoration.set(ranges, true),
    atoms: Decoration.set(
      atoms.map(item => item.decoration.range(item.from, item.to)),
      true,
    ),
  }
}

/** 取「标记内部」的区间：第一个子节点结束 → 最后一个子节点开始 */
function innerRange(node: {
  firstChild: { to: number } | null
  lastChild: { from: number } | null
}): { from: number; to: number } | null {
  const first = node.firstChild
  const last = node.lastChild
  if (!first || !last) return null
  if (first.to >= last.from) return null
  return { from: first.to, to: last.from }
}

/**
 * frontmatter 信息用 StateField 缓存：只在文本变化时重算一次，
 * 装饰重建（滚动、选区变化）直接复用，避免每次重排都跑一遍解析。
 */
function frontmatterField(): StateField<FrontmatterInfo | null> {
  return StateField.define<FrontmatterInfo | null>({
    create: state => parseFrontmatter(state.doc.toString()),
    update(value, tr) {
      if (!tr.docChanged) return value
      return parseFrontmatter(tr.state.doc.toString())
    },
  })
}

/**
 * 装饰重建请求。
 *
 * 曾经携带 `{from, to}` 视口区间用于窗口化构建，那条路径已删除（视口在挂载/
 * 切模式时尚未测量，会裁掉整篇装饰）。现在它只是一个「请重算」的信号。
 */
const refreshEffect = StateEffect.define<true>()

/** 强制重算装饰（文档主题切换、外部重载等场景） */
export function refreshDecorations(view: EditorView): void {
  view.dispatch({ effects: refreshEffect.of(true) })
}

/**
 * IME 冻结开关：true = 冻结（保留当前装饰、只跟随位置映射）。
 *
 * ⚠️ 早期实现是「清空装饰回到纯源码」，代价是**布局高度瞬间塌陷**：
 * 表格、组件卡片这些块级 Widget 一消失，整篇文档高度骤降，`scrollTop`
 * 超出新高度被浏览器夹到 0——用户看到的就是「输入法一打字，页面直接跳到顶部」。
 * 触发条件很日常：想打 `/` 但没切英文，输入了顿号「、」，组合期一到位置就跳。
 *
 * 现在改成**只映射不清空**：装饰与 Widget 原地保留，位置随事务前移。
 * 组合期间本来也不该重建（候选框才稳定），映射正好满足——既不重建，也不塌高。
 */
const freezeEffect = StateEffect.define<boolean>()

/**
 * decorator StateField：持有所有装饰（含块级）。
 *
 * 为什么是 StateField 而不是 ViewPlugin：CM6 的块级替换装饰必须由状态层提供，
 * 插件层提供会直接抛 `Block decorations may not be specified via plugins`。
 */
function decorationField(
  options: LivePreviewOptions,
  frontmatter: StateField<FrontmatterInfo | null>,
) {
  return StateField.define<DecorationValue>({
    create(state) {
      // 初始没有 viewport 信息：先按全文构建（文档第一次挂载时视口覆盖全文）
      const info = state.field(frontmatter, false) ?? null
      return { ...buildDecorations(state, options, info), frozen: false }
    },
    update(value, tr) {
      const freezeSignal = tr.effects.find(effect => effect.is(freezeEffect))?.value

      /*
       * 冻结 = **保留现有装饰，只做位置映射**。
       *
       * 不能返回 `Decoration.none`：块级 Widget 消失会让文档高度瞬间塌陷，
       * `scrollTop` 被夹到 0，用户看到「打字时页面跳到顶部」（实测由输入法
       * 组合触发：想打 `/` 却没切英文，输入了「、」）。
       *
       * 冻结必须是**粘性**的：组合输入跨多个事务，只在第一个事务带 signal
       * 的话，后续按键仍会重建装饰、继续销毁 Widget。信号只在解冻时重建一次。
       */
      if (freezeSignal === true) {
        return {
          decorations: value.decorations.map(tr.changes),
          atoms: value.atoms.map(tr.changes),
          frozen: true,
        }
      }
      if (value.frozen && freezeSignal !== false) {
        return {
          decorations: value.decorations.map(tr.changes),
          atoms: value.atoms.map(tr.changes),
          frozen: true,
        }
      }

      const refreshed = tr.effects.some(effect => effect.is(refreshEffect))
      const info = tr.state.field(frontmatter, false) ?? null

      // 文档/选区变了就重建；否则只有显式刷新（主题切换、解冻）时才重建
      if (!tr.docChanged && !tr.selection && !refreshed && freezeSignal !== false) return value

      /*
       * **永远按全文构建，不做视口窗口化。**
       *
       * 早先按 `view.viewport` 只构建可见区间，想省长文档的重建成本。但视口在
       * 编辑器刚挂载 / 刚切换模式时**还没测量**，读到的是 `{0, 0}` 或一段极小的
       * 区间；拿它当构建区间就把装饰裁成只剩 frontmatter，整篇文档退回纯源码——
       * 用户看到的是「切到实时预览还是 `**加粗**` 原文，点一下才渲染」（点击产生
       * 选区变化，走的是全文重建，于是突然好了）。
       *
       * 而且窗口化本来就没有收益：选区变化（每次点击、每次移动光标）都走全文
       * 重建，滚动并不重建。省下的只有「滚动到未构建区域」这一种情况，代价却是
       * 一类很难复现的渲染缺失。删除。
       */
      return { ...buildDecorations(tr.state, options, info), frozen: false }
    },
    provide: field => [
      EditorView.decorations.from(field, value => value.decorations),
      /*
       * 原子区间：读字段当前值而不是视图当前位置，避免光标在「字段已重建、
       * 视图还没同步」的空档里落进隐藏标记。声明成原子后 CM6 的方向键、点击
       * 与删除都会跳过整段（`skipAtomicRanges`）。
       */
      EditorView.atomicRanges.of(view => view.state.field(field, false)?.atoms ?? Decoration.none),
    ],
  })
}

/**
 * IME 冻结：组合输入期间清空装饰回到纯源码，组合结束恢复。
 *
 * 为什么是「清空」而不是「冻结不动」：组合期间文档会被输入法临时改写，
 * 任何基于旧文本的块装饰都会让候选框跳到别处。清空是唯一稳定的做法。
 */
function compositionGuard(): Extension {
  return ViewPlugin.fromClass(
    class {
      private frozen = false
      readonly view: EditorView

      constructor(view: EditorView) {
        this.view = view
      }

      update(update: ViewUpdate): void {
        const composing = update.view.composing
        if (composing === this.frozen) return
        this.frozen = composing
        // ⚠️ 不能在 update 回调里直接 dispatch：CM6 正在处理事务，期间再派发会抛
        // "Calls to EditorView.update are not allowed while an update is in progress"。
        // 推到下一帧执行——组合期间本来就不该有同步重排，晚一帧正好。
        const view = update.view
        requestAnimationFrame(() => {
          // 视图可能在这一帧内被销毁（切换模式/换文档）：用 parentNode 判断存活，
          // `destroyed` 是私有字段，外部读不到
          if (view.dom.parentNode) view.dispatch({ effects: freezeEffect.of(composing) })
        })
      }
    },
  )
}

/**
 * 创建 Live Preview 扩展。
 *
 * 每个编辑器各自调用一次，options 与各 field 都由闭包持有——
 * 不用全局可变状态，因此同屏多编辑器（将来分栏）不会互相串配置。
 */
export function createLivePreview(options: LivePreviewOptions): Extension {
  const frontmatter = frontmatterField()
  const decorations = decorationField(options, frontmatter)
  return [
    frontmatter,
    decorations,
    compositionGuard(),
    frontmatterClickHandler(),
    taskBoxClickHandler(),
    tableBlockClickHandler(options),
  ]
}

/**
 * 点击表格块 = 直接开网格编辑器。
 *
 * 之前只有右上角一枚小按钮是入口，用户的第一反应是点表格本身，结果只是把光标
 * 放进块里、表格退回源码——看起来像「点了没反应」。表格是结构化内容，点它想
 * 做的事就是改它，所以表格本体整块都作为入口。
 *
 * ⚠️ 但**只认表格本体**（`.cm-lp-block--table table` 之内）：块的外框有上下
 * 各 0.6em 的留白，那是块与块之间的间距。用户点在表格下方那圈空白里，意图
 * 通常是「在表格后面继续写」，弹窗会打断他——那里必须留给 CM6 落光标。
 *
 * 区间从 widget 写进 DOM 的 dataset 取，不用 `posAtDOM` + 向下扫行：
 * 后者遇到「表格后面紧跟另一个 `|` 开头的段落」或缩进差异就会算错区间，
 * 而 widget 建立时本来就知道准确区间。
 *
 * `mousedown` 而不是 `click`：点击会让 CM6 把光标放进块区间，块装饰随即撤除，
 * 到 click 阶段表格 DOM 已经不存在了。
 */
function tableBlockClickHandler(options: LivePreviewOptions): Extension {
  return EditorView.domEventHandlers({
    mousedown(event) {
      const onEdit = options.onEditTable
      if (!onEdit) return false
      const target = event.target as HTMLElement | null
      // 按钮自己处理过（且 stopPropagation），这里只兜底「点在表格本体上」
      if (target?.closest('.cm-lp-table-edit')) return false
      // 必须是表格本体（table 之内）：块外框的留白要留给「插入正文」
      if (!target?.closest('.cm-lp-block--table table')) return false
      const wrapper = target.closest<HTMLElement>('.cm-lp-block--table')
      const from = Number(wrapper?.dataset.tableFrom)
      const to = Number(wrapper?.dataset.tableTo)
      if (!wrapper || !Number.isFinite(from) || !Number.isFinite(to)) return false
      event.preventDefault()
      const source = wrapper.dataset.tableSource ?? ''
      onEdit({ from, to, source })
      return true
    },
  })
}

/**
 * 勾选框点击 = 改文档里的 `[ ]` / `[x]`。
 *
 * 实时预览里勾选框是**替换装饰**画出来的假控件，它自己没有状态——勾选状态的
 * 唯一真相是原文。所以点击必须回来改文本：把该行 TaskMarker 区间换成另一种写法，
 * 装饰随文档重建，方框才会真的变。
 *
 * 为什么用 mousedown 而不是 click：CM6 的鼠标按下会先设选区并可能触发块装饰
 * 撤除（光标进入块区间），click 阶段部件已经被销毁，事件就丢了。
 */
function taskBoxClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = (event.target as HTMLElement | null)?.closest('.cm-lp-taskbox')
      if (!target) return false
      event.preventDefault()

      const coords = view.posAtCoords({ x: event.clientX, y: event.clientY })
      if (coords === null) return true
      const line = view.state.doc.lineAt(coords)
      // TaskMarker 只在行首的 `- [ ]` 位置；整行扫一遍比依赖 widget 的坐标更稳
      const match = /\[\s*([ xX]?)\s*\]/.exec(line.text)
      if (!match || match.index === undefined) return true
      const checked = /[xX]/.test(match[1] ?? '')
      const from = line.from + match.index
      view.dispatch({
        changes: { from, to: from + match[0].length, insert: checked ? '[ ]' : '[x]' },
      })
      return true
    },
  })
}

/**
 * 折叠卡点击 = 把光标放进 frontmatter，随后「光标在属性区内」的规则自然展开原文。
 *
 * 为什么必须显式处理：折叠卡是覆盖整个 frontmatter 区间的替换装饰，CM6 把点击
 * 映射到该区间起点（offset 0），而 offset 0 被特意排除在「属性区内」之外
 * （否则带 frontmatter 的文档一进编辑态就永远展开）。结果点它毫无反应，
 * 想改 frontmatter 只能切源码模式——与「默认折叠、点开可改」的预期相反。
 */
function frontmatterClickHandler(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.cm-lp-frontmatter')) return false
      const info = parseFrontmatter(view.state.doc.toString())
      if (!info) return false
      event.preventDefault()
      // 落在开头 `---` 之后：既在属性区内（会展开），又不至于挤在分隔符上
      const pos = Math.min(info.end, 4)
      view.dispatch({ selection: { anchor: pos } })
      view.focus()
      return true
    },
  })
}
