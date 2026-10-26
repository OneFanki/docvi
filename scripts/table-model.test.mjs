/**
 * 原生表格模型的回归测试。
 *
 * 守卫的是「产物必须是标准 Markdown」：表格解析/序列化必须往返稳定——
 * 可视化编辑器改一次、另存一次，再打开不能因为对齐空格或转义差异
 * 产生无意义 diff（那会让每次编辑都在版本历史里留下噪声）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const {
  parseTable,
  serializeTable,
  createTable,
  addRow,
  removeRow,
  addColumn,
  removeColumn,
  setCell,
  cycleAlign,
} = await import('../packages/editor/src/table-model.ts')

/* ---------- 解析 ---------- */

test('解析基础表格：表头、对齐、数据行', () => {
  const model = parseTable('| 名称 | 数量 | 备注 |\n| :-- | :-: | --: |\n| 甲 | 1 | 无 |\n')
  assert.ok(model)
  assert.deepEqual(model.header, ['名称', '数量', '备注'])
  assert.deepEqual(model.align, ['left', 'center', 'right'])
  assert.deepEqual(model.rows, [['甲', '1', '无']])
})

test('对齐行缺冒号时视为默认对齐', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.deepEqual(model.align, [null, null])
})

test('单元格内的转义竖线不切开列', () => {
  const model = parseTable('| a | b |\n| --- | --- |\n| x \\| y | z |')
  assert.deepEqual(model.rows, [['x \\| y', 'z']])
})

test('列数不齐按最宽列补齐，缺格当空串', () => {
  const model = parseTable('| a | b | c |\n| --- | --- | --- |\n| 1 |')
  assert.deepEqual(model.rows, [['1', '', '']])
})

test('没有分隔行就不是表格', () => {
  assert.equal(parseTable('| a | b |\n| 1 | 2 |'), null)
  assert.equal(parseTable('只有一行'), null)
  assert.equal(parseTable(''), null)
})

test('没有首尾竖线也能解析（GFM 允许）', () => {
  const model = parseTable('a | b\n--- | ---\n1 | 2')
  assert.ok(model)
  assert.deepEqual(model.header, ['a', 'b'])
  assert.deepEqual(model.rows, [['1', '2']])
})

/* ---------- 序列化 ---------- */

test('序列化产出标准 Markdown 表格（首尾竖线 + 分隔行）', () => {
  const text = serializeTable({
    header: ['a', 'b'],
    align: [null, 'center'],
    rows: [['1', '2']],
  })
  const lines = text.split('\n')
  // 源文本一律左对齐补空格：对齐只在渲染时体现，源码里再按列居中会制造无意义 diff
  assert.deepEqual(lines, ['| a   | b     |', '| --- | :---: |', '| 1   | 2     |'])
})

test('序列化转义单元格里的裸竖线，但不重复转义', () => {
  const text = serializeTable({ header: ['a|b'], align: [null], rows: [['c\\|d']] })
  assert.ok(text.includes('a\\|b'))
  assert.ok(text.includes('c\\|d'))
  assert.ok(!text.includes('c\\\\|d'))
})

test('往返稳定：解析 → 序列化 → 再解析结果一致', () => {
  const source = '| 名称 | 数量 | 备注 |\n| :-- | :-: | --: |\n| 甲 | 1 | 无 |\n| 乙 | 22 | 有 |\n'
  const first = parseTable(source)
  assert.ok(first)
  const text = serializeTable(first)
  const second = parseTable(text)
  assert.deepEqual(second, first)
  // 再序列化一次必须逐字节相同：否则「打开再保存」会产生假 diff
  assert.equal(serializeTable(second), text)
})

test('空表格仍能序列化（只有表头）', () => {
  const text = serializeTable({ header: ['a'], align: [null], rows: [] })
  assert.equal(text.split('\n').length, 2)
})

/* ---------- 结构操作 ---------- */

test('新表格带可辨认的表头', () => {
  const model = createTable(2, 3)
  assert.deepEqual(model.header, ['列 1', '列 2', '列 3'])
  assert.equal(model.rows.length, 2)
})

test('加删行列保持矩形', () => {
  let model = createTable(1, 2)
  model = addRow(model)
  model = addColumn(model)
  assert.equal(model.rows.length, 2)
  assert.equal(model.header.length, 3)
  assert.ok(model.rows.every(row => row.length === 3))

  model = removeRow(model, 0)
  model = removeColumn(model, 0)
  assert.equal(model.rows.length, 1)
  assert.equal(model.header.length, 2)
})

test('最后一列不允许删除（表格至少一列）', () => {
  const model = createTable(0, 1)
  assert.deepEqual(removeColumn(model, 0), model)
})

test('setCell 只改目标格', () => {
  const model = createTable(1, 2)
  const next = setCell(model, 0, 1, 'x')
  assert.equal(next.rows[0]?.[1], 'x')
  assert.equal(next.rows[0]?.[0], model.rows[0]?.[0])
  const head = setCell(model, 'header', 0, '名称')
  assert.equal(head.header[0], '名称')
})

test('对齐循环：默认 → 左 → 中 → 右 → 默认', () => {
  assert.equal(cycleAlign(null), 'left')
  assert.equal(cycleAlign('left'), 'center')
  assert.equal(cycleAlign('center'), 'right')
  assert.equal(cycleAlign('right'), null)
})
