/**
 * 文档内查找。
 *
 * 用 CSS Custom Highlight API 而不是改 DOM：命中高亮是纯渲染层，不碰节点树，
 * 因此不会与 Vue 组件挂载、Shiki 高亮、mermaid 替换互相打架（改 DOM 的老做法
 * 在切换文档或主题重渲染后高亮会残留在错误位置）。
 *
 * Chromium 专属 API，正好匹配 Electron 单载体——不需要为其他浏览器降级。
 */

const ALL = 'docvi-find'
const CURRENT = 'docvi-find-current'

/** 只在正文容器里找：目录、状态栏的文本不该被命中 */
function textNodesIn(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue
      if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
      // 代码块里的 <span> 碎片很多，但文字仍是正文，保留
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const out: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text)
  return out
}

/**
 * 收集命中区间。
 *
 * 按「整篇文本的偏移」搜索而不是逐节点搜：一个词可能跨节点（比如 **粗**体
 * 拆成多个内联元素），逐节点搜会漏掉。这里把节点边界映射成全局偏移，
 * 命中后再把偏移还原成 Range。
 */
export function collectMatches(root: HTMLElement, query: string): Range[] {
  const needle = query.trim()
  if (!needle) return []

  const nodes = textNodesIn(root)
  const spans: Array<{ node: Text; start: number; end: number }> = []
  let offset = 0
  for (const node of nodes) {
    const length = node.nodeValue?.length ?? 0
    spans.push({ node, start: offset, end: offset + length })
    offset += length
  }

  const flat = nodes.map(node => node.nodeValue ?? '').join('')
  const lower = flat.toLowerCase()
  const target = needle.toLowerCase()

  const pointAt = (absolute: number): { node: Text; offset: number } | null => {
    for (const span of spans) {
      if (absolute >= span.start && absolute < span.end) {
        return { node: span.node, offset: absolute - span.start }
      }
    }
    return null
  }

  const ranges: Range[] = []
  let from = 0
  while (ranges.length < 2000) {
    const index = lower.indexOf(target, from)
    if (index < 0) break
    const start = pointAt(index)
    const end = pointAt(index + target.length - 1)
    if (start && end) {
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      ranges.push(range)
    }
    from = index + Math.max(1, target.length)
  }
  return ranges
}

function supportsHighlights(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

/** 应用高亮；activeIndex 那一条用更强的颜色 */
export function paintMatches(ranges: Range[], activeIndex: number): void {
  if (!supportsHighlights()) return
  CSS.highlights.set(ALL, new Highlight(...ranges))
  const active = ranges[activeIndex]
  if (active) {
    CSS.highlights.set(CURRENT, new Highlight(active))
  } else {
    CSS.highlights.delete(CURRENT)
  }
}

export function clearMatches(): void {
  if (!supportsHighlights()) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/** 滚动到某个命中：居中显示，且不改变用户当前的阅读上下文以外的状态 */
export function scrollToRange(range: Range): void {
  const rect = range.getBoundingClientRect()
  const scroller = document.querySelector<HTMLElement>('.reader')
  if (!scroller) return
  const scrollerRect = scroller.getBoundingClientRect()
  const target = scroller.scrollTop + (rect.top - scrollerRect.top) - scrollerRect.height / 2
  scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
}
