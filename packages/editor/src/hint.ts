import { syntaxTree } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/**
 * 空行提示。
 *
 * 解决的问题：光标停在文档中间的空行时，用户（尤其是不熟 Markdown 的人）
 * 不知道此刻能做什么。这里给一句轻提示「输入 / 插入内容」。
 *
 * 三条边界：
 *  1. 只在编辑器**有焦点**时显示：失焦后提示没有意义，还会在切标签时闪。
 *  2. 只对**不在代码块内**的空行提示：围栏代码块里的空行是在写代码，
 *     提示「插入内容」会误导（那里插入的是代码，不是块级元素）。
 *  3. 提示不接收指针事件：点它应该把光标放进编辑器，而不是被 widget 吃掉。
 */
class HintWidget extends WidgetType {
  readonly text: string

  constructor(text: string) {
    super()
    this.text = text
  }

  override eq(other: HintWidget): boolean {
    return other.text === this.text
  }

  override toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-lp-empty-hint'
    span.textContent = this.text
    span.setAttribute('aria-hidden', 'true')
    return span
  }

  /** 提示只是视觉引导，事件交回编辑器 */
  override ignoreEvent(): boolean {
    return true
  }
}

/** 位置是否落在代码块内（含围栏与缩进代码） */
function insideCode(view: EditorView, pos: number): boolean {
  let node = syntaxTree(view.state).resolveInner(pos, -1) as {
    name: string
    parent: unknown
  } | null
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'CodeText') {
      return true
    }
    node = node.parent as typeof node
  }
  return false
}

function buildHint(view: EditorView, text: string): DecorationSet {
  if (!view.hasFocus) return Decoration.none
  const range = view.state.selection.main
  // 有选区的场合不适合提示：用户正在选内容，浮字会干扰
  if (!range.empty) return Decoration.none
  const line = view.state.doc.lineAt(range.head)
  if (line.text.trim() !== '') return Decoration.none
  if (insideCode(view, range.head)) return Decoration.none
  return Decoration.set([
    Decoration.widget({ widget: new HintWidget(text), side: 1 }).range(line.from),
  ])
}

export function emptyLineHint(text: string): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      readonly view: EditorView

      constructor(view: EditorView) {
        this.view = view
        this.decorations = buildHint(view, text)
      }

      update(update: ViewUpdate): void {
        // 滚动不改变「光标在哪一行」，不必重建；文档/选区/焦点变化才要
        if (!update.docChanged && !update.selectionSet && !update.focusChanged) return
        this.decorations = buildHint(update.view, text)
      }
    },
    { decorations: plugin => plugin.decorations },
  )
}
