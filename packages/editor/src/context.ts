import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * 编辑器「上下文上报」：把斜杠菜单与选区气泡需要的状态推给宿主。
 *
 * 为什么由 editor 包上报、由 app 画 UI：
 *  - 位置必须从 CM6 拿（`coordsAtPos` 才是真实屏幕坐标），宿主自己算会漂；
 *  - 但菜单/气泡要长得像应用的一部分（图标、分组、i18n），用 Vue 画最省事。
 * 所以这里是**纯上报**：只报「在哪、查什么词」，不参与渲染。
 */

export interface SlashState {
  /** 斜杠本身的位置（插入时从这里替换整段 query） */
  from: number
  to: number
  query: string
  /** 屏幕坐标：菜单左下角贴这里 */
  rect: { left: number; top: number; bottom: number } | null
}

export interface SelectionState {
  from: number
  to: number
  empty: boolean
  /** 编辑器是否持有焦点：失焦时气泡必须收起，否则点工具栏按钮前它先消失 */
  focused: boolean
  /** 选中区顶部的屏幕坐标：气泡工具栏贴这里 */
  rect: { left: number; top: number; bottom: number } | null
}

export interface ContextCallbacks {
  onSlash: (state: SlashState | null) => void
  onSelection: (state: SelectionState) => void
}

/** 斜杠命令只认「行首空白 + / + 词」：正文中间的 `/` 是路径或分数，不该弹菜单 */
const SLASH_RE = /^[ \t]*\/([\w\u4e00-\u9fa5-]*)$/

function coordsAt(view: EditorView, pos: number): SlashState['rect'] {
  const coords = view.coordsAtPos(pos)
  if (!coords) return null
  return { left: coords.left, top: coords.top, bottom: coords.bottom }
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
    if (range.empty) {
      callbacks.onSelection({ from: range.from, to: range.to, empty: true, focused, rect: null })
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
        callbacks.onSelection({ from: 0, to: 0, empty: true, focused: false, rect: null })
      }
    },
  )
}
