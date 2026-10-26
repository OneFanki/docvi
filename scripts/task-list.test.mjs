/**
 * GFM 任务清单渲染回归。
 *
 * 背景：`- [ ] 待办` 在实时预览里是勾选框、阅读态却是字面量「[ ] 待办」，
 * 同一份文档两处不一致，看起来像渲染坏了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown } = await import('../packages/renderer-core/src/markdown.ts')

test('未勾选 / 已勾选都渲染成禁用复选框', () => {
  const { html } = renderMarkdown('- [ ] 待办\n- [x] 完成\n- [X] 大写\n', 'a.md')
  assert.match(html, /<li class="at-task">/)
  assert.equal((html.match(/type="checkbox" disabled>/g) ?? []).length, 1)
  assert.equal((html.match(/type="checkbox" disabled checked>/g) ?? []).length, 2)
  assert.doesNotMatch(html, /\[[ xX]\]/)
})

test('复选框不可交互（阅读态不该改文档）', () => {
  const { html } = renderMarkdown('- [ ] 待办\n', 'a.md')
  assert.match(html, /disabled/)
  assert.doesNotMatch(html, /<input[^>]*onclick/)
})

test('普通列表不受影响', () => {
  const { html } = renderMarkdown('- 普通项\n- [链接](b.md)\n', 'a.md')
  assert.doesNotMatch(html, /at-task/)
  // 站内链接会被换成规范路径（.md → 无扩展名的根路径），这里只确认链接还在
  assert.match(html, /<a href="\/b"/)
})

test('任务项里有行内格式时前缀仍被正确剥离', () => {
  const { html } = renderMarkdown('- [x] **加粗**与 `代码`\n', 'a.md')
  assert.match(html, /checked/)
  assert.match(html, /<strong>加粗<\/strong>/)
  assert.match(html, /<code>代码<\/code>/)
})

test('嵌套列表里的任务项也识别', () => {
  const { html } = renderMarkdown('- 外层\n  - [ ] 内层\n', 'a.md')
  assert.equal((html.match(/class="at-task"/g) ?? []).length, 1)
})

test('代码块里的 [ ] 不当任务处理', () => {
  const { html } = renderMarkdown('```\n- [ ] 不是任务\n```\n', 'a.md')
  assert.doesNotMatch(html, /at-task/)
})
