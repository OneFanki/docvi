import { syntaxTree } from '@codemirror/language'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * 编辑器「上下文上报」：把斜杠菜单与选区气泡需要的状态推给宿主。
 *
 * 为什么由 editor 包上报、由 app 画 UI：
 *  - 位置必须从 CM6 拿（`coordsAtPos` 才是真实屏幕坐标），宿主自己算会漂；
 *  - 但菜单/气泡要长得像应用的一部分（图标、分组、i18n），用 Vue 画最省事。
 * 所以这里是**纯上报**：只报「在哪、查什么词、当前已有什么格式」，不参与渲染。
 */

export interface SlashState {
  /** 斜杠本身的位置（插入时从这里替换整段 query） */
  from: number
  to: number
  query: string
  /** 屏幕坐标：菜单左下角贴这里 */
  rect: { left: number; top: number; bottom: number } | null
}

/**
 * 选区当前生效的格式。
 *
 * 气泡工具条据此显示**按下态**：光标在 `**加粗**` 里时加粗按钮要亮着。
 * 「点了加粗按钮却看不出是否生效」是用户明确报过的问题——按钮不反映状态，
 * 用户只能靠数原文里的星号来判断，而实时预览恰恰把星号藏了。
 */
export interface SelectionMarks {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  link: boolean
  /** 标题级别：0 = 不是标题 */
  heading: number
  bullet: boolean
  ordered: boolean
  quote: boolean
}

export interface SelectionState {
  from: number
  to: number
  empty: boolean
  /** 编辑器是否持有焦点：失焦时气泡必须收起，否则点工具栏按钮前它先消失 */
  focused: boolean
  /** 选中区顶部的屏幕坐标：气泡工具栏贴这里 */
  rect: { left: number; top: number; bottom: number } | null
  /** 选区起点处的格式状态（空选区取光标所在位置） */
  marks: SelectionMarks
}

export interface ContextCallbacks {
  onSlash: (state: SlashState | null) => void
  onSelection: (state: SelectionState) => void
}

/** 斜杠命令只认「行首空白 + / + 词」：正文中间的 `/` 是路径或分数，不该弹菜单 */
const SLASH_RE = /^[ \t]*\/([\w\u4e00-\u9fa5-]*)$/

/** 没有任何格式的基线：宿主读不到时报「全部未激活」，按钮一律不亮 */
export const NO_MARKS: SelectionMarks = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  heading: 0,
  bullet: false,
  ordered: false,
  quote: false,
}

function coordsAt(view: EditorView, pos: number): SlashState['rect'] {
  const coords = view.coordsAtPos(pos)
  if (!coords) return null
  return { left: coords.left, top: coords.top, bottom: coords.bottom }
}

/**
 * 读出位置所在的行内 / 行级格式。
 *
 * 判断方式是沿语法树向上找祖先节点：CM6 的 Markdown 语法把 `**x**` 解析成
 * StrongEmphasis 包住内容，光标落在 x 里时它必然是祖先。行级格式（标题、列表、
 * 引用）在同一棵树里也有对应节点，一并读掉，省得宿主再各算一份。
 *
 * 只读视口范围内的语法树（`syntaxTree`）就够：选区永远在视口内，为它触发
 * 全文解析得不偿失。
 */
function marksAt(view: EditorView, pos: number): SelectionMarks {
  const marks: SelectionMarks = { ...NO_MARKS }
  const { state } = view
  if (pos > state.doc.length) return marks

  const line = state.doc.lineAt(pos)
  if (/^\s*[-*+]\s+\[[ xX]\]/.test(line.text)) marks.bullet = true
  else if (/^\s*[-*+]\s+/.test(line.text)) marks.bullet = true
  else if (/^\s*\d+[.)]\s+/.test(line.text)) marks.ordered = true
  if (/^\s*>\s?/.test(line.text)) marks.quote = true

  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node) {
    switch (node.name) {
      case 'StrongEmphasis':
        marks.bold = true
        break
      case 'Emphasis':
        marks.italic = true
        break
      case 'Strikethrough':
        marks.strike = true
        break
      case 'InlineCode':
        marks.code = true
        break
      case 'Link':
        marks.link = true
        break
      case 'ATXHeading1':
      case 'ATXHeading2':
      case 'ATXHeading3':
      case 'ATXHeading4':
      case 'ATXHeading5':
      case 'ATXHeading6':
        marks.heading = Number(node.name.slice(-1))
        break
      case 'Blockquote':
        marks.quote = true
        break
      case 'BulletList':
        marks.bullet = true
        break
      case 'OrderedList':
        marks.ordered = true
        break
      default:
        break
    }
    if (!node.parent) break
    node = node.parent
  }
  return marks
}

export function contextReporter(callbacks: ContextCallbacks): Extension {
  const run = (view: EditorView): void => {
    const { state } = view
    const head = state.selection.main.head
    const line = state.doc.lineAt(head)
    const before = line.text.slice(0, head - line.from)

    const match = SLASH_RE.exec(before)
    if (match) {
      // 替换区间从**斜杠本身**开始，不能带上行首缩进——否则缩进会被菜单结果吃掉
      const slashStart = head - (match[1]?.length ?? 0) - 1
      callbacks.onSlash({
        from: slashStart,
        to: head,
        query: match[1] ?? '',
        rect: coordsAt(view, head),
      })
    } else {
      callbacks.onSlash(null)
    }

    const focused = view.hasFocus
    const range = state.selection.main
    const marks = marksAt(view, range.from)
    if (range.empty) {
      callbacks.onSelection({
        from: range.from,
        to: range.to,
        empty: true,
        focused,
        rect: null,
        marks,
      })
      return
    }
    // 气泡贴在选区的**上沿**：贴下沿时多行选中会盖住正文
    const coords = view.coordsAtPos(range.from)
    callbacks.onSelection({
      from: range.from,
      to: range.to,
      empty: false,
      focused,
      rect: coords ? { left: coords.left, top: coords.top, bottom: coords.bottom } : null,
      marks,
    })
  }

  return ViewPlugin.fromClass(
    class {
      private pending = false
      private destroyed = false

      constructor(readonly view: EditorView) {
        this.schedule()
      }

      /**
       * 只能等 update 结束后再量坐标。
       *
       * CM6 在 update() 期间禁止读取 DOM 布局（coordsAtPos 会抛异常），
       * 而斜杠菜单唯一的触发时机就是「刚打完字」这一帧。所以这里不直接算，
       * 而是合并成一次微任务：同一帧内的连续输入只上报一次。
       */
      private schedule(): void {
        if (this.pending || this.destroyed) return
        this.pending = true
        queueMicrotask(() => {
          this.pending = false
          if (this.destroyed || !this.view.dom.parentNode) return
          run(this.view)
        })
      }

      update(update: ViewUpdate): void {
        // 滚动也要重算：菜单跟着光标走
        if (
          update.docChanged ||
          update.selectionSet ||
          update.focusChanged ||
          update.geometryChanged
        ) {
          this.schedule()
        }
      }

      destroy(): void {
        this.destroyed = true
        callbacks.onSlash(null)
        callbacks.onSelection({
          from: 0,
          to: 0,
          empty: true,
          focused: false,
          rect: null,
          marks: NO_MARKS,
        })
      }
    },
  )
}
