/**
 * 斜杠插入规划的回归测试。
 *
 * 只覆盖标准 Markdown 的纯文本插入：位置算错会把块插到错误的地方，
 * 而这类偏差肉眼很难发现（尤其分割线贴上一行会变成 setext 标题）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { planInsert, insertedBlockRange } =
  await import('../apps/desktop/src/renderer/src/lib/insert-plan.ts')

const plainItem = {
  id: 'table',
  label: '表格',
  hint: '',
  group: 'markdown',
  keywords: '',
  render: () => ({ text: 'TABLE', cursorOffset: 2 }),
}

test('标准项：原地替换斜杠区间，光标落在 block 内偏移', () => {
  const doc = '# t\n\n/表'
  const plan = planInsert(doc, plainItem, 4, 6)
  assert.equal(plan.changes.length, 1)
  assert.deepEqual(plan.changes[0], { from: 4, to: 6, insert: 'TABLE' })
  assert.equal(plan.caretAfter, 4 + 2)
})

/* ---------- 斜杠菜单的结构与标记 ---------- */

const menu = await import('../apps/desktop/src/renderer/src/lib/insert-menu.ts')

test('菜单只收标准 Markdown，且有足够的常用项', () => {
  const markdown = menu.INSERT_ITEMS.filter(item => item.group === 'markdown')
  assert.ok(markdown.length >= 5, '标准 Markdown 项不应过少')
  assert.equal(markdown.length, menu.INSERT_ITEMS.length, '不应混入非 Markdown 插入项')
})

test('表格声明支持表单编辑', () => {
  const table = menu.INSERT_ITEMS.find(item => item.id === 'table')
  assert.ok(table, '缺少表格插入项')
  assert.equal(table.form, true, '表格有网格编辑器，必须标记 form: true')
})

test('纯 Markdown 项不写悬停说明（图标与名称已足够）', () => {
  for (const item of menu.INSERT_ITEMS) {
    assert.ok(!item.hint, `${item.label} 不该带 hint：标准项靠名称就能看懂`)
  }
})

test('insertedBlockRange：区间不含结尾换行，回写不会把表格与下一段粘连', () => {
  /*
   * 实测缺陷：斜杠插入表格后直接打开网格编辑器，保存时用 `to: from + 插入长度`
   * 整段替换。插入文本以换行结尾，而 serializeTable 的产物不带换行——回写后
   * 表格最后一行会和后面那段文字并成一行，Markdown 结构当场坏掉。
   */
  const doc = '正文\n\n/table\n'
  const tableItem = {
    id: 'table',
    label: '表格',
    group: 'markdown',
    keywords: '',
    render: () => ({ text: '| a | b |\n| --- | --- |\n|  |  |\n', cursorOffset: 2 }),
  }
  const plan = planInsert(doc, tableItem, 4, 10)
  const range = insertedBlockRange(plan)
  assert.ok(range, '标准项也要能算出行内块区间')
  assert.equal(range.text, '| a | b |\n| --- | --- |\n|  |  |', '区间文本必须是去掉结尾换行的原文')
  assert.equal(range.to - range.from, range.text.length)
  // 区间落在新文档里，且右边界正好是插入块最后一行的行尾
  const applied = '正文\n\n' + plan.changes.at(-1).insert
  assert.equal(applied.slice(range.from, range.to), range.text)
  assert.equal(applied[range.to], '\n', '右边界之后应当还是换行，而不是下一段的正文')
})

/* ---------- 块独立性（分割线不能贴上一行） ---------- */

const hrItem = {
  id: 'hr',
  label: '分割线',
  group: 'markdown',
  keywords: '',
  needsBlankBefore: true,
  render: () => ({ text: '---\n' }),
}

test('分割线紧贴上一行文字时自动补空行', () => {
  const doc = '# 标题\n正文\n/hr'
  const plan = planInsert(doc, hrItem, 7, 10)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0]?.insert, '\n---\n')
})

test('前面已经是空行时不重复补', () => {
  const doc = '# 标题\n\n/hr'
  const plan = planInsert(doc, hrItem, 6, 9)
  assert.equal(plan.changes[0]?.insert, '---\n')
})

test('文档开头插入分割线不补空行', () => {
  const doc = '/hr'
  const plan = planInsert(doc, hrItem, 0, 3)
  assert.equal(plan.changes[0]?.insert, '---\n')
})

test('补的空行不计入块区间（否则回写会粘连上一行）', () => {
  const doc = '正文\n/hr'
  const plan = planInsert(doc, hrItem, 3, 6)
  const range = insertedBlockRange(plan)
  assert.ok(range)
  assert.equal(range.text, '---')
  // 区间起点必须在补出来的空行之后
  assert.equal(range.from, 3 + 1)
})

test('CRLF 文档补空行时用 CRLF', () => {
  const doc = '正文\r\n/hr'
  const plan = planInsert(doc, hrItem, 4, 7)
  assert.equal(plan.changes[0]?.insert, '\r\n---\n')
})

test('不需要独立成块的项不加空行', () => {
  const doc = '正文\n/表'
  const plan = planInsert(doc, plainItem, 3, 5)
  assert.equal(plan.changes[0]?.insert, 'TABLE')
})
