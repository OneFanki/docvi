/**
 * 正文里原生 iframe 的 src 归一。
 *
 * 这是「通用 Markdown」的关键一环：图片能被渲染管线补资产前缀，但原生 HTML
 * 是原样透传的——`<iframe src="./demo.html">` 会相对应用入口解析成
 * `docvi://app/demo.html`，那目录里没有这篇文档的 html，iframe 永远空白。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { rewriteIframeSrc, toRootRelative } from '../../packages/renderer-core/src/iframe-assets.ts'

const PREFIX = 'docvi://asset/ws1'

test('相对路径按文档所在目录解析，并补上资产前缀', () => {
  const html = '<iframe src="./demo.html" sandbox="allow-scripts"></iframe>'
  const out = rewriteIframeSrc(html, 'guide/intro.md', PREFIX)
  assert.equal(
    out,
    '<iframe src="docvi://asset/ws1/guide/demo.html" sandbox="allow-scripts"></iframe>',
  )
})

test('不带 ./ 的相对路径等价', () => {
  const out = rewriteIframeSrc('<iframe src="demo.html"></iframe>', 'a/b.md', PREFIX)
  assert.match(out, /docvi:\/\/asset\/ws1\/a\/demo\.html/)
})

test('上溯 ../ 在内容根内的正常引用', () => {
  const out = rewriteIframeSrc('<iframe src="../shared/x.html"></iframe>', 'a/b/c.md', PREFIX)
  assert.match(out, /docvi:\/\/asset\/ws1\/a\/shared\/x\.html/)
})

test('外链与绝对路径不动', () => {
  for (const src of ['https://x.com/a.html', '//cdn/x.html', '/abs/x.html', 'data:text/html,hi']) {
    const out = rewriteIframeSrc(`<iframe src="${src}"></iframe>`, 'a.md', PREFIX)
    assert.equal(out, `<iframe src="${src}"></iframe>`, `${src} 不该被改写`)
  }
})

test('单引号写法同样处理', () => {
  const out = rewriteIframeSrc("<iframe src='demo.html'></iframe>", 'a.md', PREFIX)
  assert.match(out, /docvi:\/\/asset\/ws1\/demo\.html/)
})

test('不碰 sandbox / allow / 其他属性（安全边界由作者声明）', () => {
  const html =
    '<iframe sandbox="allow-scripts allow-same-origin" allow="fullscreen" src="d.html" height="400"></iframe>'
  const out = rewriteIframeSrc(html, 'a.md', PREFIX)
  assert.match(out, /sandbox="allow-scripts allow-same-origin"/)
  assert.match(out, /allow="fullscreen"/)
  assert.match(out, /height="400"/)
})

test('多个 iframe 每个都改写', () => {
  const html = '<iframe src="a.html"></iframe><iframe src="b.html"></iframe>'
  const out = rewriteIframeSrc(html, 'sec/x.md', PREFIX)
  assert.match(out, /sec\/a\.html/)
  assert.match(out, /sec\/b\.html/)
})

test('没有资产前缀（容器或未登记工作区）时原样返回', () => {
  const html = '<iframe src="demo.html"></iframe>'
  assert.equal(rewriteIframeSrc(html, 'a.md', ''), html)
})

test('toRootRelative：空 baseDir 直接落到根', () => {
  assert.equal(toRootRelative('demo.html', ''), '/demo.html')
  assert.equal(toRootRelative('./demo.html', ''), '/demo.html')
})

test('toRootRelative：多余的上溯被裁掉，不产生越界路径', () => {
  assert.equal(toRootRelative('../../../x.html', 'a'), '/x.html')
})
