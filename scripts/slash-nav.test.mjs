/**
 * 斜杠菜单二维导航的回归测试。
 *
 * 用户实测反馈：「按斜杠出现的菜单，只能按左右切换不能上下切换，我想选特殊组件
 * 得向右跳过所有常规 md 语法」。根因是上下键与左右键都被映射成一维 `move(±1)`，
 * 而下拉面板在视觉上是「第一行一排图标 + 之后每行一个组件」。这里把布局与移动
 * 规则锁住，避免以后改布局时又把两个维度揉回一个。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { buildRows, rowOffsets, locate, moveVertical, moveHorizontal, moveToEdge } =
  await import('../apps/desktop/src/renderer/src/lib/slash-nav.ts')

const md = n => Array.from({ length: n }, (_, i) => ({ id: `md-${i}`, group: 'markdown' }))
const cp = n => Array.from({ length: n }, (_, i) => ({ id: `cp-${i}`, group: 'component' }))

/** 造一份布局并算好 offsets，模拟组件的 computed 组合 */
function layout(items) {
  const rows = buildRows(items)
  return { rows, offsets: rowOffsets(rows) }
}

test('布局：标准 Markdown 共用首行，组件各占一行', () => {
  const { rows } = layout([...md(3), ...cp(2)])
  assert.equal(rows.length, 3, '1 行 markdown + 2 行组件')
  assert.equal(rows[0].length, 3)
  assert.equal(rows[1].length, 1)
  assert.equal(rows[2].length, 1)
})

test('布局：过滤后某一组为空时不留空行', () => {
  const onlyComponents = layout(cp(2))
  assert.equal(onlyComponents.rows.length, 2)
  assert.equal(onlyComponents.rows[0][0].id, 'cp-0')

  const onlyMarkdown = layout(md(2))
  assert.equal(onlyMarkdown.rows.length, 1)
})

test('下键：从首行直接落到第一个增强组件（不再横向挪一格）', () => {
  const { rows, offsets } = layout([...md(4), ...cp(2)])
  // 用户报的就是这个：光标停在首行第 3 个图标，按下键应当进组件区
  assert.equal(moveVertical(rows, offsets, 2, 1), 4, '应落到第一个组件的扁平下标')
})

test('下键：组件区每行一个，逐条向下', () => {
  const { rows, offsets } = layout([...md(2), ...cp(3)])
  assert.equal(moveVertical(rows, offsets, 2, 1), 3)
  assert.equal(moveVertical(rows, offsets, 3, 1), 4)
})

test('上键：从组件区回到首行，列号贴到首行末尾而不是越界', () => {
  const { rows, offsets } = layout([...md(2), ...cp(2)])
  // 组件区列号恒为 0，回到 2 个图标的首行 → 第 0 列
  assert.equal(moveVertical(rows, offsets, 2, -1), 0)
})

test('上下键在边界处不动', () => {
  const { rows, offsets } = layout([...md(2), ...cp(1)])
  assert.equal(moveVertical(rows, offsets, 0, -1), 0, '首行再按上键保持不动')
  const last = 2
  assert.equal(moveVertical(rows, offsets, last, 1), last, '末行再按下键保持不动')
})

test('左右键：行内移动，到头不跨行', () => {
  const { rows, offsets } = layout([...md(3), ...cp(2)])
  assert.equal(moveHorizontal(rows, offsets, 0, 1), 1)
  assert.equal(moveHorizontal(rows, offsets, 2, 1), 2, '首行最后一个再按右键不跨到组件区')
  assert.equal(moveHorizontal(rows, offsets, 3, 1), 3, '单条组件行按右键不动')
})

test('Home / End：只在当前行内跳', () => {
  const { rows, offsets } = layout([...md(3), ...cp(1)])
  assert.equal(moveToEdge(rows, offsets, 2, 'start'), 0, '首行 End→Start 回到第 0 个')
  assert.equal(moveToEdge(rows, offsets, 0, 'end'), 2, '首行 End 到最后一个图标')
  assert.equal(moveToEdge(rows, offsets, 3, 'end'), 3, '组件行只有一个，End 仍是它')
})

test('locate：下标越界时贴边，不产生负数或超宽列', () => {
  const { rows, offsets } = layout([...md(2), ...cp(1)])
  assert.deepEqual(locate(rows, offsets, 0), { row: 0, col: 0 })
  assert.deepEqual(locate(rows, offsets, 2), { row: 1, col: 0 })
  // 负下标与超大下标都要被夹住
  assert.deepEqual(locate(rows, offsets, -5), { row: 0, col: 0 })
  const clamped = locate(rows, offsets, 99)
  assert.equal(clamped.row, 1)
  assert.equal(clamped.col, 0)
})

test('空列表：所有移动都返回原下标，不抛异常', () => {
  const rows = []
  const offsets = []
  for (const fn of [moveVertical, moveHorizontal]) {
    assert.equal(fn(rows, offsets, 0, 1), 0)
  }
  assert.equal(moveToEdge(rows, offsets, 0, 'end'), 0)
})
