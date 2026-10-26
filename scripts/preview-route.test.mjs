/**
 * 组件预览路由的解析（容器读者面）。
 *
 * 真实踩过的坑：运维页的「预览」按钮指向 `/_/preview/<包名>/<kind>`，但渲染层
 * 只认 `/<仓库>/<文档>` 这一种路由，于是 `_` 被当成仓库 slug，查不到就静默回落
 * 到文档库首页——用户看到「点预览打开了一个 docvi 页面，但什么都没渲染」。
 *
 * 这里断言纯函数对各类路径的判定。宿主判断（isWebHost）在 web-router.ts 里，
 * 不参与单测：那个模块顶层读 window，Node 加载不了。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { parsePreviewRoute, PREVIEW_PREFIX } =
  await import('../apps/desktop/src/renderer/src/lib/preview-route.ts')

test('预览路径被识别', () => {
  assert.deepEqual(parsePreviewRoute('/_/preview/docs-plugin-base/flow-diagram'), {
    plugin: 'docs-plugin-base',
    kind: 'flow-diagram',
  })
})

test('尾斜杠也识别', () => {
  assert.deepEqual(parsePreviewRoute('/_/preview/base/flow-diagram/'), {
    plugin: 'base',
    kind: 'flow-diagram',
  })
})

test('百分号编码的包名能解开', () => {
  assert.deepEqual(parsePreviewRoute('/_/preview/a%2Fb/kind'), { plugin: 'a/b', kind: 'kind' })
})

test('非法百分号编码不抛异常（用原串兜底）', () => {
  assert.deepEqual(parsePreviewRoute('/_/preview/%E0%A4%A/kind'), {
    plugin: '%E0%A4%A',
    kind: 'kind',
  })
})

test('普通文档路径不是预览路径', () => {
  assert.equal(parsePreviewRoute('/showcase/component-showcase/index'), null)
  assert.equal(parsePreviewRoute('/'), null)
})

test('缺 kind 时返回 null（不猜一个必然 404 的 kind）', () => {
  assert.equal(parsePreviewRoute('/_/preview/base'), null)
  assert.equal(parsePreviewRoute('/_/preview/base/'), null)
})

test('前缀常量与部署器的保留段一致', () => {
  assert.equal(PREVIEW_PREFIX, '/_/preview/')
})
