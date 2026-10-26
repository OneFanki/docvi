/**
 * 插件结构化块的行扫描（`findPluginBlocks` 与渲染管线的接入）。
 *
 * 为什么必须测：这套扫描是**阅读态、编辑态、导出、分享四条路径共用**的。
 * 曾经这里各写一份正则，结果缩进两格的收尾 `:::` 在编辑态被识别、阅读态不认，
 * 同一篇文档两处长得不一样——这类漂移在界面上极难发现，只能靠单测钉住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMarkdown } from '../packages/renderer-core/src/markdown.ts'
import { findPluginBlocks } from '../packages/renderer-core/src/plugin-blocks.ts'

const SYNTAX = [
  { name: 'merged', component: 'merged-table', form: 'container' },
  { name: 'chart', component: 'flow-diagram', form: 'fence' },
]

const render = body =>
  renderMarkdown(`# 标题\n\n${body}\n\n结尾正文。`, 't.md', {
    containerSyntax: SYNTAX,
  })

/**
 * 从占位 div 里抽出形态与组件。
 *
 * 不写一条「字段顺序固定」的大正则：属性书写顺序是实现细节，换个顺序
 * 就全红，测的就不是行为了。按单个 div 切开再各自取字段。
 */
const blocksOf = html =>
  html
    .split('<div class="at-plugin-block"')
    .slice(1)
    .map(chunk => ({
      form: /data-plugin-form="([^"]+)"/.exec(chunk)?.[1] ?? null,
      syntax: /data-plugin-syntax="([^"]+)"/.exec(chunk)?.[1] ?? null,
      component: /data-plugin-component="([^"]+)"/.exec(chunk)?.[1] ?? null,
    }))

test('容器形态：顶格收尾能识别', () => {
  const { html } = render(
    ['::: merged', 'title: T', 'columns: [A]', 'rows:', '  - [1]', ':::'].join('\n'),
  )
  assert.deepEqual(blocksOf(html), [
    { form: 'container', syntax: 'merged', component: 'merged-table' },
  ])
})

test('容器形态：收尾标记缩进两格也能识别（官方示例就是这种写法）', () => {
  const { html } = render(
    ['::: merged', 'title: T', 'columns: [A]', 'rows:', '  - [1]', '  :::'].join('\n'),
  )
  assert.deepEqual(blocksOf(html), [
    { form: 'container', syntax: 'merged', component: 'merged-table' },
  ])
})

test('围栏形态：``` 与 ~~~ 都识别，且块体是 YAML 原文', () => {
  for (const marker of ['```', '~~~']) {
    const { html } = render(
      [`${marker}chart`, 'title: F', 'nodes: []', 'edges: []', marker].join('\n'),
    )
    const blocks = blocksOf(html)
    assert.equal(blocks.length, 1, `${marker} 应有 1 个块`)
    assert.equal(blocks[0]?.form, 'fence')
    assert.equal(blocks[0]?.component, 'flow-diagram')
  }
})

test('围栏块体里的 URL 编码可以还原成 YAML', () => {
  const { html } = render(['```chart', 'title: 流程图', 'nodes: []', 'edges: []', '```'].join('\n'))
  const payload = /data-plugin-payload="([^"]+)"/.exec(html)?.[1] ?? ''
  assert.match(decodeURIComponent(payload), /title: 流程图/)
})

test('代码块里举例写的 ::: 不被当成真块', () => {
  const { html } = render(['````markdown', '::: merged', 'title: 示例', ':::', '````'].join('\n'))
  assert.equal(blocksOf(html).length, 0)
})

test('未声明的名字留在源码里，不强行渲染', () => {
  const { html } = render(['::: 随便写的', 'title: X', ':::'].join('\n'))
  assert.equal(blocksOf(html).length, 0)
})

test('未闭合的容器不会被当成块（宁可见源码，也不静默吃掉后续内容）', () => {
  const { html } = render(['::: merged', 'title: T', '没有收尾标记'].join('\n'))
  assert.equal(blocksOf(html).length, 0)
  assert.match(html, /结尾正文/)
})

test('frontmatter 声明 + 容器 + 围栏三者在同一文档共存', () => {
  const src = [
    '---',
    'components:',
    '  flow:',
    '    kind: flow-diagram',
    '    title: A',
    '    nodes: [{ id: a, label: A }]',
    '    edges: []',
    '---',
    '',
    '<at-flow-diagram data-key="flow"></at-flow-diagram>',
    '',
    '::: merged',
    'title: M',
    'columns: [A]',
    'rows:',
    '  - [1]',
    ':::',
    '',
    '```chart',
    'title: C',
    'nodes: [{ id: b, label: B }]',
    'edges: []',
    '```',
    '',
    '正文结尾。',
  ].join('\n')

  const { html, frontmatter } = renderMarkdown(src, 't.md', { containerSyntax: SYNTAX })
  assert.match(html, /data-key="flow"/, '声明式标签应保留')
  assert.deepEqual(
    blocksOf(html).map(b => b.form),
    ['container', 'fence'],
    '容器与围栏都应渲染',
  )
  assert.deepEqual(Object.keys(frontmatter.components ?? {}), ['flow'])
  assert.match(html, /正文结尾/)
})

test('findPluginBlocks 返回的行号能精确切回块体', () => {
  const lines = ['前文', '::: merged', 'title: T', ':::', '后文']
  const spans = findPluginBlocks(lines, SYNTAX)
  assert.equal(spans.length, 1)
  const span = spans[0]
  assert.equal(span.startLine, 1)
  assert.equal(span.endLine, 3)
  assert.equal(span.body, 'title: T')
})

test('CRLF 文档的块体里不带 \\r 残留', () => {
  const src = ['# T', '', '```chart', 'title: F', '```', ''].join('\r\n')
  const { html } = renderMarkdown(src, 't.md', { containerSyntax: SYNTAX })
  const payload = /data-plugin-payload="([^"]+)"/.exec(html)?.[1] ?? ''
  assert.equal(decodeURIComponent(payload), 'title: F')
})
