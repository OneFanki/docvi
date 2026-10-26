/**
 * 源行标注（分屏同步的坐标系）。
 *
 * 分屏同步改成按**源行**对齐之后，「两边对不上」的唯一可能来源就是这里的
 * 映射错了：插件块替换会改变行数、frontmatter 会整体偏移行号。两个坑都用
 * 断言钉住，否则表现是「滚动不同步」这种很难归因的现象。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown } = await import('../packages/renderer-core/src/markdown.ts')

/** 取所有 `data-source-line="N"` 的 N（文档顺序） */
function sourceLines(html) {
  return [...html.matchAll(/data-source-line="(\d+)"/g)].map(match => Number(match[1]))
}

test('默认不标注源行（导出 / 分享页不该出现内部标记）', () => {
  const { html } = renderMarkdown('# 标题\n\n正文\n', 'a.md')
  assert.ok(!html.includes('data-source-line'), '默认不应输出源行属性')
})

test('开 sourceLines 后：块级元素带 0-based 原文件行号', () => {
  const src = '# 标题\n\n段落一\n\n段落二\n'
  const { html } = renderMarkdown(src, 'a.md', { sourceLines: true })
  // h1 在第 0 行，段落一第 2 行，段落二第 4 行
  assert.deepEqual(sourceLines(html), [0, 2, 4])
})

test('frontmatter 占掉的行要计入行号（否则整篇偏移）', () => {
  const src = '---\ntitle: t\n---\n\n# 标题\n\n正文\n'
  const { html } = renderMarkdown(src, 'a.md', { sourceLines: true })
  const lines = sourceLines(html)
  assert.equal(lines[0], 4, `H1 在原文件第 4 行（0-based），实际 ${lines[0]}`)
  assert.equal(lines[1], 6, `正文在原文件第 6 行，实际 ${lines[1]}`)
})

test('插件块替换后行号不漂移（后续块仍对齐原文件）', () => {
  const syntax = [{ name: 'merged', form: 'container', component: 'merged-table' }]
  const src = [
    '# 标题', // 0
    '', // 1
    '::: merged', // 2
    'title: 表', // 3
    'rows: []', // 4
    ':::', // 5
    '', // 6
    '插件块之后的正文', // 7
    '', // 8
  ].join('\n')
  const { html } = renderMarkdown(src, 'a.md', { sourceLines: true, containerSyntax: syntax })
  const lines = sourceLines(html)
  // H1 = 0；插件块占位 = 2；其后的段落必须是 7——插件块 4 行被压成 1 个 div，
  // 若不补空行占位，这里会变成 3。
  assert.deepEqual(lines, [0, 2, 7])
})

test('未开 sourceLines 时插件块替换不补空行（避免多余的空白影响导出）', () => {
  const syntax = [{ name: 'merged', form: 'container', component: 'merged-table' }]
  const src = '::: merged\ntitle: 表\nrows: []\n:::\n\n正文\n'
  const { html } = renderMarkdown(src, 'a.md', { containerSyntax: syntax })
  assert.ok(!html.includes('data-source-line'))
  // 正文仍然渲染出来了（补空行只是排版层面的空白，不该吞掉内容）
  assert.ok(html.includes('正文'))
})
