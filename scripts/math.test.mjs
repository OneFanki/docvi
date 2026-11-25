/**
 * 数学公式（TeX → MathML）的渲染契约。
 *
 * 这条特性一旦错了，代价分三种，每条都钉用例：
 *  - **误伤**：把「$5 到 $10」这类货币当成公式吞掉——正文直接读不懂；
 *  - **吞内容**：`$$a$$ 说明` 里的后半句凭空消失；
 *  - **不安全**：`\href{javascript:...}` 产出可点击链接——分享页会给读者跑；
 *
 * 正向契约只有一条但要稳：`$…$` 与行首 `$$…$$` 必须变成带 MathML 的节点，
 * 且**不依赖任何脚本或字体文件**（分享页 CSP 是 `script-src 'self'`）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMarkdown } from '../packages/renderer-core/src/markdown.ts'

function render(src, options = {}) {
  return renderMarkdown(src, 'test.md', options).html
}

/** MathML 的根标签：出现它就说明公式真的被浏览器原生排版了 */
const MATHML = /<math[^>]*xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/i

test('行内公式：$…$ 变成 MathML，源码里的 TeX 不再裸露', () => {
  const html = render('前向预读维持在 $W/4$ 左右。\n')
  assert.match(html, MATHML)
  assert.match(html, /<mi>W<\/mi>/)
  assert.doesNotMatch(html, /\$W\/4\$/, '定界符与源码不该留在正文里')
  assert.match(html, /前向预读维持在 /, '公式两侧的正文必须完整')
  assert.match(html, / 左右。/, '公式后面的正文不能被吃掉')
})

test('行内公式：\\pm / \\text 这类命令真的被解释，而不是原样出字', () => {
  const html = render(String.raw`退化为热点 $\pm 60\text{s}$ 的窗口。` + '\n')
  assert.match(html, /<mo>±<\/mo>/, '\\pm 应变成 ± 运算符')
  assert.match(html, /<mtext>s<\/mtext>/, '\\text{s} 应变成正体文本，不是逐字母变量')
})

test('块级公式：行首 $$…$$ 独占一块，且带 display="block"', () => {
  const html = render('$$E = mc^2$$\n')
  assert.match(html, /<div class="at-math at-math--block"/)
  assert.match(html, /display="block"/)
  assert.match(html, /<msup>/)
})

test('块级公式：跨多行写法（含 aligned 环境）能解析', () => {
  const src = ['$$', '\\begin{aligned}', 'a &= b \\\\', 'c &= d', '\\end{aligned}', '$$'].join('\n')
  const html = render(src + '\n')
  assert.match(html, /at-math--block/)
  assert.match(html, /<mtable/, 'aligned 应排版成 MathML 表格')
  assert.doesNotMatch(html, /katex-error/, '合法公式不该降级成错误')
})

test('块级公式：列表内缩进写法同样成立', () => {
  const src = ['- 第一步', '', '  $$', '  x^2', '  $$'].join('\n')
  const html = render(src + '\n')
  assert.match(html, /at-math--block/)
  assert.match(html, /<msup>/)
})

test('货币不误伤：$5 到 $10 保持纯文本', () => {
  const html = render('价格是 $5 and $10 这样。\n')
  assert.doesNotMatch(html, MATHML, '货币金额绝不能被当成公式')
  assert.match(html, /\$5 and \$10/)
})

test('行首 $$ 后面还有内容：整行保持文本，后半句不能被吞', () => {
  const html = render('$$a$$ 说明文字\n')
  assert.doesNotMatch(html, MATHML, '闭合后还有内容就不是块级公式')
  assert.match(html, /说明文字/, '后半句必须保留')
})

test('\\$ 是字面美元：不会被当成定界符', () => {
  const html = render(String.raw`价格 \$5 不是公式。` + '\n')
  assert.doesNotMatch(html, MATHML)
  assert.match(html, /\$5/)
})

test('行内代码里的 $x$ 保持代码，不被公式规则抢走', () => {
  const html = render('代码 `$x$` 不该被解析。\n')
  assert.doesNotMatch(html, MATHML)
  assert.match(html, /<code>\$x\$<\/code>/)
})

test('坏公式降级成红字源码，不炸整篇', () => {
  const html = render(String.raw`坏的：$\frac{1}{$ 结束，后面照常。` + '\n')
  assert.match(html, /katex-error/, '解析失败要留下可见标记')
  assert.match(html, /后面照常/, '坏公式不能影响后续正文')
})

test('安全：\\href{javascript:…} 不产出可点击链接', () => {
  const html = render(String.raw`$\href{javascript:alert(1)}{x}$` + '\n')
  assert.doesNotMatch(html, /<a\s[^>]*href/i, 'trust:false 下不该生成 <a>')
  /*
   * 只断言「可导航属性」里没有危险协议。TeX 源码本身会被 KaTeX 存进
   * `<annotation encoding="application/x-tex">` 的**文本内容**（供复制与读屏），
   * 那是数据不是行为——连它一起禁掉等于要求公式不能包含这个字符串。
   */
  assert.doesNotMatch(html, /\s(?:href|src|xlink:href)\s*=\s*["'][^"']*javascript:/i)
})

test('中文 \text{} 不触发警告级输出（strict: ignore）', () => {
  const html = render(String.raw`$V_{\text{最大}}$` + '\n')
  assert.match(html, /<mtext>最大<\/mtext>/)
})

test('公式不引入脚本与字体：产出里只有标签，没有 <script> / @font-face', () => {
  const html = render('文字 $a^2+b^2=c^2$ 与\n\n$$\\int_0^1 x\\,dx$$\n')
  assert.match(html, MATHML)
  assert.doesNotMatch(html, /<script/i, '公式必须是纯标签：分享页 CSP 不允许内联脚本')
  assert.doesNotMatch(html, /@font-face/i, '不依赖 katex 字体：否则分享页与导出要各自找字体')
})

test('分屏模式：块级公式带 data-source-line，能参与源行对齐', () => {
  const html = render('前文\n\n$$\nx^2\n$$\n', { sourceLines: true })
  assert.match(html, /<div class="at-math at-math--block" data-source-line="2">/)
})
