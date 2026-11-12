/**
 * ASCII 图对齐与代码块语言标签回归。
 *
 * 两条独立契约：
 *  1. **语言标签只在真的说明信息时显示**——`text` 是「未标注」的落地值，
 *     全库 42 处用它标终端输出 / 目录树，把 `text` 印在右上角是纯噪音。
 *  2. **ASCII 图要锁宽字符宽度**——等宽字体里汉字只有 1.707 个 ASCII 宽度
 *     （实测 2026-11-12），每行几十个汉字就累积成十几个格偏移，框线必然断。
 *
 * 第 2 条还有一条隐性契约必须一起守：高亮 pass 会把 `<code>` 的 textContent
 * 重建成新 HTML，跑一遍就会丢掉锁宽 span。所以 `data-ascii` 是跳过标记。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown } = await import('../packages/renderer-core/src/markdown.ts')
const { alignAsciiBlock, needsAsciiAlignment } =
  await import('../packages/renderer-core/src/ascii-align.ts')

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\`\n`

/* ---------- 语言标签 ---------- */

test('text 围栏不渲染语言标签', () => {
  const { html } = renderMarkdown(fence('text', 'some output'), 'a.md')
  assert.doesNotMatch(html, /<span class="lang">text<\/span>/)
  // 语言类名仍要保留：样式与 data-ascii 判定都依赖它
  assert.match(html, /class="language-text"/)
})

test('未标注围栏不渲染语言标签', () => {
  const { html } = renderMarkdown(fence('', 'plain'), 'a.md')
  assert.doesNotMatch(html, /<span class="lang">/)
})

test('真实语言照常显示标签', () => {
  for (const lang of ['sql', 'yaml', 'js', 'bash']) {
    const { html } = renderMarkdown(fence(lang, 'x'), 'a.md')
    assert.match(html, new RegExp(`<span class="lang">${lang}</span>`), `${lang} 应有标签`)
  }
})

/* ---------- 宽字符判定 ---------- */

test('框线 + 汉字 = 需要对齐', () => {
  assert.equal(needsAsciiAlignment('┌ 应用包 ┐\n│ console │\n└────────┘'), true)
})

test('纯 ASCII 框线不需要对齐（本来就都是 1ch）', () => {
  assert.equal(needsAsciiAlignment('┌─────┐\n│ abc │\n└─────┘'), false)
})

test('普通中文代码块不需要对齐（没有框线）', () => {
  assert.equal(needsAsciiAlignment('// 这是中文注释\nconst a = 1'), false)
})

/* ---------- 锁宽 ---------- */

test('alignAsciiBlock 把汉字包成定宽 span，制表符保持裸文本', () => {
  const out = alignAsciiBlock('│ 中 │')
  assert.match(out, /<span class="at-ascii-w2">中<\/span>/)
  // 制表符不能被包：包起来会引入行内盒边界，破坏框线连续性
  assert.doesNotMatch(out, /<span[^>]*>│<\/span>/)
})

test('alignAsciiBlock 转义 HTML 字符（防注入）', () => {
  const out = alignAsciiBlock('│ <script> 中 │')
  assert.doesNotMatch(out, /<script>/)
  assert.match(out, /&lt;script&gt;/)
})

test('对齐后的块带 data-ascii，且 span 真的出现在输出里', () => {
  const { html } = renderMarkdown(fence('text', '┌ 标题 ┐\n│ 中文 │\n└──────┘'), 'a.md')
  assert.match(html, /data-ascii="1"/)
  assert.match(html, /class="at-ascii-w2"/)
})

test('不对齐的块不带 data-ascii（避免误跳过高亮）', () => {
  const { html } = renderMarkdown(fence('sql', 'SELECT 1'), 'a.md')
  assert.doesNotMatch(html, /data-ascii/)
})

/* ---------- 高亮跳过契约 ---------- */

test('highlightPass 以 data-ascii 为跳过标记（否则锁宽 span 会被重建掉）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(
    new URL('../packages/renderer-core/src/highlight.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    source,
    /if \(wrapper\.dataset\.ascii\) continue/,
    'ASCII 块必须跳过高亮，否则 textContent 重建会丢掉锁宽 span',
  )
})
