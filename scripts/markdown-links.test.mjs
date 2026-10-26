/**
 * 壳链接改写（resolveLink）回归：站点/查看器共用的站内链接归一化。
 *
 * 背景（2026-10-13 用户反馈三个跳转问题）：
 * - 演示章节表用无 .md 相对路径 → 此前被原样放过（hash 宿主不跳、站点靠服务端侥幸）；
 * - CJK 链接经浏览器 URL 序列化后是百分号编码，路由再编码会双重编码 404（点击处理器解码修复，
 *   本文件锁定 resolveLink 侧的输出形态：全程原文，编码只发生在导航层一次）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { resolveLink } = await import('../packages/renderer-core/src/markdown.ts')

test('无扩展名相对链接归一为根相对（演示章节表场景）', () => {
  assert.equal(
    resolveLink('chapters/01-主流程与目录', '/component-showcase/index'),
    '/component-showcase/chapters/01-主流程与目录',
  )
})

test('.md 相对链接剥扩展名 + ./ 与 ../ 折叠', () => {
  assert.equal(
    resolveLink('chapters/02-x.md', '/component-showcase/index'),
    '/component-showcase/chapters/02-x',
  )
  assert.equal(resolveLink('../guide/a.md', '/a/b/index'), '/a/guide/a')
  assert.equal(resolveLink('./same.md', '/a/b/index'), '/a/b/same')
  assert.equal(resolveLink('sub/nested.md', '/index'), '/sub/nested')
})

test('根绝对路径与锚点保留（锚点不参与归一）', () => {
  assert.equal(
    resolveLink('/component-showcase/chapters/02-讲解与自检', '/x/index'),
    '/component-showcase/chapters/02-讲解与自检',
  )
  assert.equal(resolveLink('a/b.md#sec-1', '/x/index'), '/x/a/b#sec-1')
  assert.equal(resolveLink('/a/b#sec', '/x'), '/a/b#sec')
})

test('裸锚点、外链、协议相对、带扩展名资产原样放行', () => {
  assert.equal(resolveLink('#sec', '/a/b'), '#sec')
  assert.equal(resolveLink('https://example.com/a.md', '/a'), 'https://example.com/a.md')
  assert.equal(resolveLink('mailto:x@y.com', '/a'), 'mailto:x@y.com')
  assert.equal(resolveLink('//cdn.example.com/a', '/a'), '//cdn.example.com/a')
  assert.equal(resolveLink('assets/pic.png', '/guide/index'), 'assets/pic.png')
  assert.equal(resolveLink('assets/diagram.html', '/guide/index'), 'assets/diagram.html')
})

test('目录链接折叠尾斜杠（章节间链接到课程首页 /course/）', () => {
  assert.equal(resolveLink('/component-showcase/', '/x/y'), '/component-showcase')
  assert.equal(resolveLink('../', '/a/b/index'), '/a')
})
