/**
 * 组件「引用文件」的地址归一契约（2026-11-06）。
 *
 * 背景：`<at-html-embed>` 的 `src` 此前完全没被处理——浏览把它当相对当前页解析，
 * 桌面端落到 `docvi://app/assets/x.html`（渲染产物目录）必然 404，用户只能把
 * 整份 HTML 粘进 frontmatter。同一篇文档在容器端又"看起来正常"，因为
 * 相对路径恰好对上了内容根，缺陷因此长期没被发现。
 *
 * 这里钉住的是**地址换算**这一条契约（输入 href + 文档路径 + 前缀 → 输出地址），
 * 不是实现细节：两条宿主地址空间不同，但换算规则必须只有一份。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { renderMarkdown, resolveLink } = await import('../packages/renderer-core/src/markdown.ts')

/** 取渲染结果里某个组件条目的 src（组件数据经 renderMarkdown 归一后的最终值） */
function componentSrc(frontmatter, key, docPath, assetPrefix) {
  const md = `---\ncomponents:\n  ${key}:\n    kind: html-embed\n    src: ${frontmatter}\n---\n\n<at-html-embed data-key="${key}"></at-html-embed>\n`
  const out = renderMarkdown(md, docPath, { assetPrefix })
  return out.frontmatter.components?.[key]?.src
}

test('组件 src：相对路径按文档所在目录解析，再补资产前缀', () => {
  // 真实场景：文档在 04-业务功能设计/ 下，资产在同级的父目录 assets/
  const src = componentSrc(
    '../assets/demo.html',
    'demo',
    '长期沉淀/产品文档/04-业务设计/方案.md',
    'docvi://asset/ws1',
  )
  assert.equal(src, 'docvi://asset/ws1/长期沉淀/产品文档/assets/demo.html')
})

test('组件 src：同目录的相对路径不会多带一层', () => {
  const src = componentSrc('demo.html', 'demo', '指南/入门.md', 'docvi://asset/ws1')
  assert.equal(src, 'docvi://asset/ws1/指南/demo.html')
})

test('组件 src：以 / 开头按内容根解析', () => {
  const src = componentSrc('/assets/demo.html', 'demo', '任意/深/路径.md', 'docvi://asset/ws1')
  assert.equal(src, 'docvi://asset/ws1/assets/demo.html')
})

test('组件 src：外链与 data: 原样保留（不该被拼上资产前缀）', () => {
  assert.equal(
    componentSrc('https://example.com/d.html', 'demo', 'a.md', 'docvi://asset/ws1'),
    'https://example.com/d.html',
  )
  assert.equal(
    componentSrc('data:text/html,<p>x</p>', 'demo', 'a.md', 'docvi://asset/ws1'),
    'data:text/html,<p>x</p>',
  )
})

test('组件 src：容器前缀下幂等（二次渲染不会叠成 /repo/repo）', () => {
  const md = `---\ncomponents:\n  demo:\n    kind: html-embed\n    src: /repo/assets/demo.html\n---\n\n<at-html-embed data-key="demo"></at-html-embed>\n`
  const out = renderMarkdown(md, 'a.md', { assetPrefix: '/repo' })
  assert.equal(out.frontmatter.components?.demo?.src, '/repo/assets/demo.html')
})

test('组件 src：未给前缀时退化为内容根相对路径（分享页 / 单文件）', () => {
  const src = componentSrc('../assets/demo.html', 'demo', 'x/y.md', '')
  assert.equal(src, '/assets/demo.html')
})

test('链接：.html 归一为根相对且保留扩展名', () => {
  assert.equal(resolveLink('../assets/demo.html', '指南/入门.md'), '/assets/demo.html')
  assert.equal(resolveLink('/assets/demo.html', '任意.md'), '/assets/demo.html')
  assert.equal(resolveLink('demo.htm', '指南/入门.md'), '/指南/demo.htm')
})

test('链接：.html 带锚点时锚点保留（用于分节定位）', () => {
  assert.equal(resolveLink('../assets/demo.html#chart', '指南/入门.md'), '/assets/demo.html#chart')
})

test('链接：其余带扩展名的资产维持原样（不误改图片与下载文件）', () => {
  assert.equal(resolveLink('../img/a.png', '指南/入门.md'), '../img/a.png')
  assert.equal(resolveLink('files/report.pdf', '指南/入门.md'), 'files/report.pdf')
})

test('链接：.md 仍按文档路由归一（剥扩展名）', () => {
  assert.equal(resolveLink('../其他/篇目.md', '指南/入门.md'), '/其他/篇目')
})
