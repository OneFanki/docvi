/**
 * 宽表格标记回归。
 *
 * 背景：全库 610 行表格在 7 列以上，横向滚动是常态。滚动时表头要吸顶、首列要
 * 冻结，否则滚到右侧既不知道列是什么、也不知道自己看的是哪一行。
 *
 * 这两件事都靠 `<table data-wide>` 开启（样式见 doc.css），所以门槛必须钉住：
 * 列少时不能打标（多付合成层成本），列多时必须打标（否则功能失效）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown } = await import('../packages/renderer-core/src/markdown.ts')

/** 造一张 n 列的表（表头 + 一行数据） */
function table(columns) {
  const head = `| ${Array.from({ length: columns }, (_, i) => `列${i + 1}`).join(' | ')} |`
  const sep = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`
  const row = `| ${Array.from({ length: columns }, (_, i) => `值${i + 1}`).join(' | ')} |`
  return `${head}\n${sep}\n${row}\n`
}

test('列数达到门槛：<table> 带 data-wide', () => {
  const { html } = renderMarkdown(table(7), 'a.md')
  assert.match(html, /<table data-wide/)
})

test('列数超过门槛：同样带 data-wide', () => {
  const { html } = renderMarkdown(table(10), 'a.md')
  assert.match(html, /<table data-wide/)
})

test('列数低于门槛：不打 data-wide（避免窄表格白付 sticky 成本）', () => {
  const { html } = renderMarkdown(table(6), 'a.md')
  assert.match(html, /<table/)
  assert.doesNotMatch(html, /<table data-wide/)
})

test('单列表与常规表格不受影响', () => {
  const { html } = renderMarkdown(table(1) + '\n' + table(3), 'a.md')
  assert.doesNotMatch(html, /data-wide/)
  assert.equal((html.match(/<table/g) ?? []).length, 2)
})

test('宽表格仍包在滚动容器里，且不影响其它属性', () => {
  const { html } = renderMarkdown(table(8), 'a.md')
  assert.match(html, /<div class="at-table-wrap"><table data-wide=""/)
  assert.match(html, /<\/table>\s*<\/div>/)
})
