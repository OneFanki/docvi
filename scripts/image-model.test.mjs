/**
 * 图片模型的回归测试。
 *
 * 契约：编辑器的产物必须是**标准 Markdown 图片语法**，且「解析 → 序列化」
 * 不能改变语义。这两点一旦破了，用户就会在别的编辑器里看到 `![](...)` 原文。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { parseImage, serializeImage } = await import('../packages/editor/src/image-model.ts')

test('解析基础图片语法', () => {
  assert.deepEqual(parseImage('![描述](assets/a.png)'), {
    alt: '描述',
    src: 'assets/a.png',
    title: '',
  })
})

test('带标题的图片（双引号 / 单引号 / 括号三种写法）', () => {
  for (const source of ['![a](x.png "标题")', "![a](x.png '标题')", '![a](x.png (标题))']) {
    assert.equal(parseImage(source)?.title, '标题', source)
  }
})

test('尖括号包裹的含空格路径', () => {
  const model = parseImage('![a](<my images/a b.png>)')
  assert.equal(model?.src, 'my images/a b.png')
})

test('alt 里的转义方括号能还原', () => {
  const model = parseImage('![a \\[b\\]](x.png)')
  assert.equal(model?.alt, 'a [b]')
})

test('不是图片语法时返回 null（调用方要明确拒绝，而不是打开空弹窗）', () => {
  assert.equal(parseImage('普通文字'), null)
  assert.equal(parseImage('[链接](a.md)'), null)
  assert.equal(parseImage('<img src="a.png">'), null)
  assert.equal(parseImage(''), null)
})

test('序列化：含空格的路径自动加尖括号', () => {
  assert.equal(serializeImage({ alt: 'a', src: 'my img/a.png', title: '' }), '![a](<my img/a.png>)')
})

test('序列化：空 src 返回空串（调用方据此拒绝保存）', () => {
  assert.equal(serializeImage({ alt: 'a', src: '   ', title: '' }), '')
})

test('往返稳定：解析 → 序列化 → 再解析，语义不丢', () => {
  const sources = [
    '![描述](assets/a.png)',
    '![a](x.png "标题")',
    '![a](<my images/a b.png>)',
    '![](https://example.com/a.png)',
  ]
  for (const source of sources) {
    const first = parseImage(source)
    assert.ok(first, source)
    const round = parseImage(serializeImage(first))
    assert.deepEqual(round, first, source)
  }
})

test('alt 里的方括号会被转义，序列化后仍是合法图片语法', () => {
  const text = serializeImage({ alt: 'a [b]', src: 'x.png', title: '' })
  assert.equal(text, '![a \\[b\\]](x.png)')
  assert.equal(parseImage(text)?.alt, 'a [b]')
})

test('data URL 原样保留（容器读者面无可写工作区时的降级方案）', () => {
  const src = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(parseImage(`![a](${src})`)?.src, src)
  assert.equal(serializeImage({ alt: 'a', src, title: '' }), `![a](${src})`)
})
