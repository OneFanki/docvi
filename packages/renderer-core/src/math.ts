/**
 * 数学公式（TeX）→ MathML。
 *
 * ## 为什么输出 MathML 而不是 KaTeX 的 HTML
 *
 * KaTeX 有两条输出路径：`html`（自己排版，必须配 katex.css + 二十来个 woff2 字体，
 * 约 1.2MB）与 `mathml`（交给浏览器原生渲染，零字体零样式）。这里选后者，三个原因：
 *
 *  1. **分享页与导出产物能白捡**：公式在 `renderMarkdown` 阶段就变成标签，分享页
 *     不需要额外运行时脚本（CSP 的 `script-src 'self'` 一个字都不用改），导出 HTML
 *     与 PDF 也不需要内嵌字体；
 *  2. **没有字体文件就没有字体缺失**：`html` 路径下漏一个字体，公式就是方块，
 *     而环境（打包态 / 分享页 / 打印）有三套资源查找逻辑；
 *  3. **排版正确性交给浏览器**：Chromium 的 MathML Core 实现已经很完整，
 *     分数、矩阵、根号、上下标都按数学排版规则走。
 *
 * 代价是字形风格与 KaTeX 依赖的 Computer Modern 不同（跟随系统数学字体），
 * 且极少数 KaTeX 私有扩展（`\htmlClass` 之类）不参与排版——它们本来也被 `trust: false`
 * 挡掉了。
 *
 * ## 安全边界
 *
 * `html: true` 已放开原生 HTML，公式这里必须守住两条：
 *  - `trust: false`：`\href{javascript:...}` / `\url` / `\includegraphics` 全部拒绝，
 *    实测退化成红色源码文本，不会产出可点击的危险链接；
 *  - `throwOnError: false`：解析失败渲染成 `<span class="katex-error">` 并保留源码，
 *    单条坏公式不能把整篇文档打成白屏。
 *
 * ## 语法
 *
 *  - 行内：`$E = mc^2$`；
 *  - 独占一块：行首 `$$ … $$`（单行或跨多行）。
 *
 * 只认 `$`，不认 `\(...\)`：后者在 Markdown 里先是转义序列（`\(` → `(`），
 * 要支持得抢在 escape 规则之前，与「`\$` 应输出字面美元」冲突。`$` 一种写法足够，
 * 也让规则可预测。
 */
import katex from 'katex'
import type { MarkdownIt as MarkdownItInstance, StateBlock, StateInline, Token } from 'markdown-it'

const DOLLAR = 0x24
const SPACE = 0x20
const TAB = 0x09
const TAB_DIGIT_LO = 0x30
const TAB_DIGIT_HI = 0x39

/**
 * 把一个 `$` 当作定界符是否合法。
 *
 * 这套判据来自 markdown-it-katex（VSCode Markdown 预览用的同一套），三种情况必须挡住：
 *  - `$ 5`：开定界符后面紧跟空白 → 不是公式；
 *  - `$x $`：闭定界符前面是空白 → 不是公式（内容不该以空白结尾）；
 *  - `$5 and $10`：第二个 `$` 后面紧跟数字 → 不是公式。
 *    这一条是为了不让货币金额被吞成公式，代价是 `$a$1` 这种写法也不成立。
 *
 * 另外两侧都排除相邻的另一个 `$`：`$$` 是块级定界符，不该被行内规则拆着用。
 * 不排除的话 `$$a$$` 会被切成「`$` + 公式 + `$`」，源码里的双美元凭空变成单美元。
 */
function delimAt(src: string, pos: number, posMax: number): { open: boolean; close: boolean } {
  const prev = pos > 0 ? src.charCodeAt(pos - 1) : -1
  const next = pos + 1 <= posMax ? src.charCodeAt(pos + 1) : -1
  const nextIsDigit = next >= TAB_DIGIT_LO && next <= TAB_DIGIT_HI
  return {
    open: prev !== DOLLAR && next !== SPACE && next !== TAB && next !== DOLLAR,
    close: prev !== SPACE && prev !== TAB && prev !== DOLLAR && next !== DOLLAR && !nextIsDigit,
  }
}

/**
 * 行内公式 `$…$`。
 *
 * 插在 `escape` 之后、`backticks` 之前：
 *  - 在 escape 之后 → `\$` 已被吃成字面美元，这里看不到它，天然不用处理转义；
 *  - 在 backticks 之前 → 行内代码里的 `$x$` 由代码规则整段吃掉，不会被误认成公式。
 */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const { src } = state
  if (src.charCodeAt(state.pos) !== DOLLAR) return false
  if (!delimAt(src, state.pos, state.posMax).open) return false

  let end = -1
  for (let pos = state.pos + 1; pos < state.posMax; pos += 1) {
    if (src.charCodeAt(pos) !== DOLLAR) continue
    if (!delimAt(src, pos, state.posMax).close) continue
    end = pos
    break
  }
  if (end < 0) return false

  const tex = src.slice(state.pos + 1, end)
  // "$ $" 与 "$$" 落在这里：内容为空就不当公式，原样输出
  if (!tex.trim()) return false

  if (!silent) {
    const token = state.push('math_inline', 'math', 0)
    token.content = tex
    token.markup = '$'
  }
  state.pos = end + 1
  return true
}

/**
 * 块级公式 `$$ … $$`，必须从行首开始（可缩进 3 空格，与其他块规则一致）。
 *
 * 单行 `$$x$$` 与跨多行都收；闭合 `$$` 之后本行不能再有内容——
 * 否则 `$$a$$ 说明` 这种半截写法会被静默吞掉后半句，宁可当普通文本。
 */
function mathBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  // 行号一定落在 bMarks 范围内（markdown-it 保证），但 noUncheckedIndexedAccess 不知道
  const startChar = state.bMarks[startLine]
  const startShift = state.tShift[startLine]
  const max = state.eMarks[startLine]
  if (startChar === undefined || startShift === undefined || max === undefined) return false
  const start = startChar + startShift
  if (start + 2 > max) return false
  if (state.src.slice(start, start + 2) !== '$$') return false

  const firstRest = state.src.slice(start + 2, max)

  // 单行形式：闭合之后只能剩空白
  const singleClose = firstRest.indexOf('$$')
  if (singleClose >= 0 && firstRest.slice(singleClose + 2).trim() === '') {
    const tex = firstRest.slice(0, singleClose).trim()
    if (!tex) return false
    if (silent) return true
    pushBlockMath(state, tex, startLine, startLine + 1)
    state.line = startLine + 1
    return true
  }

  // 跨行形式：逐行找「本行以 $$ 收尾」
  const parts: string[] = [firstRest]
  let nextLine = startLine + 1
  let closed = false
  for (; nextLine < endLine; nextLine += 1) {
    const lineStart = (state.bMarks[nextLine] ?? 0) + (state.tShift[nextLine] ?? 0)
    const lineEnd = state.eMarks[nextLine]
    if (lineEnd === undefined) break
    const raw = state.src.slice(lineStart, lineEnd)
    const close = raw.indexOf('$$')
    if (close >= 0 && raw.slice(close + 2).trim() === '') {
      parts.push(raw.slice(0, close))
      closed = true
      break
    }
    parts.push(raw)
  }
  if (!closed) return false
  if (silent) return true

  // TeX 不感知行首空白，所以逐行剥缩进是安全的（nested 列表里还能正确对齐）
  const tex = parts.join('\n').trim()
  if (!tex) return false
  pushBlockMath(state, tex, startLine, nextLine + 1)
  state.line = nextLine + 1
  return true
}

function pushBlockMath(state: StateBlock, tex: string, lineFrom: number, lineTo: number): void {
  const token = state.push('math_block', 'math', 0)
  token.block = true
  token.content = tex
  token.markup = '$$'
  token.map = [lineFrom, lineTo]
}

/**
 * TeX → MathML。
 *
 * 三条选项都不是可选的：
 *  - `output: 'mathml'`：见文件头；
 *  - `throwOnError: false`：坏公式降级成红字源码，不炸整篇；
 *  - `strict: 'ignore'`：中文/全角字符在数学模式里会被 strict 报警告，而警告走
 *    `console.warn`——端到端回归断言「运行期零控制台错误」，开着它每次打开带中文的
 *    公式就红。`trust: false` 是默认值，显式写出来是为了让安全边界一眼可见。
 */
export function renderTex(tex: string, display: boolean): string {
  return katex.renderToString(tex, {
    output: 'mathml',
    displayMode: display,
    throwOnError: false,
    strict: 'ignore',
    trust: false,
  })
}

/** 与 markdown.ts 同口径：块级元素上的 `data-source-line`（分屏同步用） */
function lineAttr(token: Token | undefined): string {
  const value = token?.attrGet('data-source-line')
  return value === null || value === undefined ? '' : ` data-source-line="${value}"`
}

/**
 * 注册数学公式：两条分词规则 + 两个渲染产物。
 *
 * 渲染产物在 markdown.ts 之外，是为了让「公式」这一个特性自包含在一个文件里；
 * 唯一的耦合点是 `lineAttr`——它只读 `data-source-line` 属性，属性由
 * markdown.ts 的 `annotateSourceLines` 写入，没有第二套逻辑。
 */
export function registerMath(md: MarkdownItInstance): void {
  /*
   * alt 必须给：markdown-it 的段落规则靠它判断「这一行要不要终止上一段」。
   * 不给的话 `文字\n$$x$$` 会把 $$ 并进上一段，公式变成行内纯文本。
   */
  md.block.ruler.before('fence', 'math_block', mathBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  })
  md.inline.ruler.before('backticks', 'math_inline', mathInlineRule)

  md.renderer.rules.math_inline = (tokens, idx) => renderTex(tokens[idx]?.content ?? '', false)
  md.renderer.rules.math_block = (tokens, idx) => {
    const token = tokens[idx]
    if (!token) return ''
    return `<div class="at-math at-math--block"${lineAttr(token)}>${renderTex(token.content, true)}</div>\n`
  }
}
