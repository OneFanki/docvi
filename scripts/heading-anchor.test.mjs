/**
 * 标题锚点位置回归（2026-10-22 用户实测：长标题折行时 # 落到第二行）。
 *
 * 生成端用 placement:'before' 把 `<a>` 放在标题文字之前；样式端用绝对定位
 * 钉在标题盒左上。两者缺一都会让 `#` 漂到别处。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown } = await import('../packages/renderer-core/src/markdown.ts')

test('标题锚点在文字之前（长标题折行时不会掉到第二行）', () => {
  const out = renderMarkdown('# Product Knowledge Agent Guide\n\n正文\n', 'x.md', {})
  const anchorAt = out.html.indexOf('class="header-anchor"')
  const textAt = out.html.indexOf('Product Knowledge Agent Guide')
  assert.ok(anchorAt >= 0, '没有生成 header-anchor')
  assert.ok(textAt >= 0, '没有标题文字')
  assert.ok(anchorAt < textAt, '锚点必须在标题文字之前，否则 float / 绝对定位会落到末行')
})

test('多级标题都会生成锚点，大纲层级正确', () => {
  const out = renderMarkdown('## 一级\n\n### 二级\n', 'x.md', {})
  assert.equal((out.html.match(/class="header-anchor"/g) ?? []).length, 2)
  assert.deepEqual(
    out.outline.map(item => item.level),
    [2, 3],
  )
})
