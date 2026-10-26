import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { Extension, Range } from '@codemirror/state'

/**
 * 行首空白可见化（只用于源码模式）。
 *
 * 为什么需要它：Markdown 里「行首有没有空格」是语法的一部分（列表嵌套、代码块、
 * 引用续行），但正文用的是比例字体，行首空白的宽度与行号到正文的间隙无从区分——
 * 用户看到一段空白，无法判断那是缩进还是排版留白。分界线只能标出「正文从这里
 * 开始」，数不出缩进几级；这里给行首的每个空格画一个淡点，缩进就变成可数的。
 *
 * 三条取舍：
 *  1. **只标行首，不标行内**：行内空格是正常的词间距，标出来会把正文变成点阵噪点。
 *  2. **只在源码模式挂载**：实时预览承诺「所见即文档效果」，点阵会破坏它。
 *  3. **只处理可见范围**：长文档整篇扫一遍会让每次输入都付全量代价。
 */

/** 空白点：单个空格一个 span，按需绘制，不依赖字体是否等宽 */
const spaceMark = Decoration.mark({ class: 'cm-leadingSpace' })
const tabMark = Decoration.mark({ class: 'cm-leadingTab' })

function build(view: EditorView): DecorationSet {
  const { doc } = view.state
  const ranges: Range<Decoration>[] = []

  for (const visible of view.visibleRanges) {
    let line = doc.lineAt(visible.from)
    while (line.from <= visible.to) {
      const leading = /^[ \t]+/.exec(line.text)
      if (leading) {
        for (let index = 0; index < leading[0].length; index += 1) {
          const from = line.from + index
          const deco = leading[0][index] === '\t' ? tabMark : spaceMark
          ranges.push(deco.range(from, from + 1))
        }
      }
      if (line.to >= doc.length) break
      line = doc.lineAt(line.to + 1)
    }
  }

  return Decoration.set(ranges, true)
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = build(view)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
    }
  },
  { decorations: value => value.decorations },
)

export function leadingWhitespace(): Extension {
  return plugin
}
