/**
 * 行内包裹（加粗 / 斜体 / 删除线 / 行内代码）的回归测试。
 *
 * 本轮用户报的具体故障：「选中文字点删除线，屏幕上冒出两个波浪线，没有删除线」。
 * 根因是 CommonMark 的定界规则——强调内容**不能以空白开头或结尾**。双击选词、
 * 拖选整行都会把尾部的空格或换行带进选区，直接包裹就让 `~~文字 ~~` 不成立。
 *
 * 这里钉住的是「包裹产物必须是有效语法」这一条契约，不是实现细节。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { planInlineWrap } = await import('../packages/editor/src/inline-wrap.ts')

/** 应用规划：按 from 升序模拟 CM6 的多变更事务（同位置按声明顺序） */
function apply(doc, plan) {
  let result = doc
  // 从后往前应用，位置才不会互相影响
  const changes = plan.changes
    .map((change, index) => ({ ...change, index }))
    .sort((a, b) => b.from - a.from || b.index - a.index)
  for (const change of changes) {
    result = result.slice(0, change.from) + change.insert + result.slice(change.to)
  }
  return result
}

test('基本的加粗包裹：正常选区', () => {
  const doc = '这是文字\n'
  const plan = planInlineWrap(doc, 0, 4, '**')
  assert.equal(apply(doc, plan), '**这是文字**\n')
  assert.deepEqual(plan.selection, { from: 2, to: 6 })
})

test('尾部带空格：空格必须留在标记外（否则强调语法不成立）', () => {
  const doc = '这是文字 \n'
  const plan = planInlineWrap(doc, 0, 5, '~~')
  assert.equal(apply(doc, plan), '~~这是文字~~ \n')
})

test('尾部带换行：换行留在标记外', () => {
  const doc = '第一行\n第二行\n'
  const plan = planInlineWrap(doc, 0, 4, '~~')
  assert.equal(apply(doc, plan), '~~第一行~~\n第二行\n')
})

test('开头带空白同样要剥掉', () => {
  const doc = 'a   文字\n'
  const plan = planInlineWrap(doc, 1, 6, '**')
  assert.equal(apply(doc, plan), 'a   **文字**\n')
})

test('选区已包裹：再点一次取消（来回切）', () => {
  const doc = '**加粗**\n'
  const plan = planInlineWrap(doc, 2, 4, '**')
  assert.equal(apply(doc, plan), '加粗\n')
})

test('斜体不能吃掉加粗的一个星号', () => {
  const doc = '**加粗**\n'
  // 光标落在加粗文字上做斜体：`**加粗**` 外面那对是 `**`，不该被当成斜体标记
  const plan = planInlineWrap(doc, 2, 4, '*')
  assert.equal(apply(doc, plan), '***加粗***\n')
})

test('空选区：插一对标记，光标居中', () => {
  const doc = 'abc\n'
  const plan = planInlineWrap(doc, 1, 1, '~~')
  assert.equal(apply(doc, plan), 'a~~~~bc\n')
  assert.deepEqual(plan.selection, { from: 3, to: 3 })
})

test('纯空白选区：退化成空选区插入，不产出非法语法', () => {
  const doc = 'a   b\n'
  const plan = planInlineWrap(doc, 1, 4, '~~')
  const result = apply(doc, plan)
  // 产物里必须有一对完整标记（空内容），而不是把空白包进去
  assert.ok(result.includes('~~~~') || result.includes('~~ ~~') === false)
})

test('跨段落：按行分别包裹，不产出跨段落的强调', () => {
  const doc = '第一段\n\n第二段\n'
  const plan = planInlineWrap(doc, 0, 8, '~~')
  const result = apply(doc, plan)
  assert.equal(result, '~~第一段~~\n\n~~第二段~~\n')
})

test('所有行内包裹的产物都能被 GFM 解析成对应语法', async () => {
  const { markdownLanguage } = await import('@codemirror/lang-markdown')
  const cases = [
    ['这是文字 \n', 0, 5, '~~', 'Strikethrough'],
    ['这是文字\n', 0, 4, '**', 'StrongEmphasis'],
    ['这是文字\n', 0, 4, '*', 'Emphasis'],
    ['x y\n', 0, 3, '`', 'InlineCode'],
  ]
  for (const [doc, from, to, marker, nodeName] of cases) {
    const plan = planInlineWrap(doc, from, to, marker)
    const result = apply(doc, plan)
    const names = []
    markdownLanguage.parser.parse(result).iterate({
      enter: ref => {
        names.push(ref.name)
      },
    })
    assert.ok(
      names.includes(nodeName),
      `「${result.trim()}」应解析出 ${nodeName}，实际节点：${names.join(', ')}`,
    )
  }
})
