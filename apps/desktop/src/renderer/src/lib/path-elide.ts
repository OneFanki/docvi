/**
 * 路径的尾部优先截断（纯函数，可单测）。
 *
 * 状态栏里的文档路径通常很长，而真正能区分「这是哪一篇」的信息在**末尾**：
 * 目录名可以省略，文件名不能。所以窄窗口下的截断必须从前面切，结果形如
 * `…/前端功能文档-数据货架/数据货架-前端功能文档.md`。
 *
 * 为什么不用 CSS 的 `direction: rtl` 取巧：那会把中性的标点（斜杠、括号）
 * 按 RTL 规则重排，`docs/` 会渲染成 `/docs`。这里直接算字符串，行为可预期、
 * 可测试。
 */

/** 省略号：单字符 U+2026，比三个点窄且不会被断行 */
const ELLIPSIS = '…'

/**
 * 把路径压进给定宽度。
 *
 * @param text       原始路径
 * @param available  可用像素宽度
 * @param measure    文字宽度测量（真实渲染用 canvas，测试用固定字宽）
 * @param minTail    至少保留的尾部字符数（宽度再小也别只剩一个省略号）
 *
 * 规则：
 *  1. 整串放得下 → 原样返回；
 *  2. 否则从**后**往前累积，遇到分隔符时可以整段跳过，保证不会把 `…` 后面的
 *     第一个字符变成半截名字；
 *  3. 连最小尾部都放不下时，退化为「…」+ 最后 minTail 个字符（宁可超出一点，
 *     也要让人看出这是哪篇文档的下半截）。
 */
export function fitPathTail(
  text: string,
  available: number,
  measure: (value: string) => number,
  minTail = 8,
): string {
  if (!text) return ''
  if (available <= 0) return ELLIPSIS
  if (measure(text) <= available) return text

  const budget = available - measure(ELLIPSIS)
  if (budget <= 0) return ELLIPSIS

  // 从末尾逐字符往前加，直到放不下
  let best = ''
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const candidate = text.slice(i)
    if (measure(candidate) > budget) break
    best = candidate
  }

  if (!best) {
    // 一个字符都放不下：保留最小尾部，截断仍比空白有信息量
    return ELLIPSIS + text.slice(-Math.min(minTail, text.length))
  }

  /*
   * 切口必须落在**段边界**上，否则会露出半个目录名（`…b/ccc/ddd.md`）——
   * 那种字符串既不是路径也读不出是哪一层。规则：
   *   1. 前一个字符是 `/` → 直接补斜杠；
   *   2. 否则退到最近一个 `/` 之后；退完还放得下就用它；
   *   3. 连最短的一整段都放不下 → 只保留文件名（最后一个 `/` 之后），
   *      并在它与省略号之间补斜杠；文件名本身超宽时才会退化成裸尾。
   */
  const lastSlash = text.lastIndexOf('/')
  if (lastSlash >= 0) {
    const basename = text.slice(lastSlash + 1)
    const tail = best.startsWith('/') ? best.slice(1) : best
    // 已经包含完整文件名：只要切口前面是分隔符就合规
    if (tail === basename || basename.endsWith(tail)) {
      return measure(ELLIPSIS + '/' + tail) <= available ? `${ELLIPSIS}/${tail}` : ELLIPSIS + tail
    }
    // 否则直接退到文件名（省掉半截目录名）
    if (measure(ELLIPSIS + '/' + basename) <= available) return `${ELLIPSIS}/${basename}`
  }
  return ELLIPSIS + best
}
