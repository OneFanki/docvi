/**
 * 视图切换「交接」逻辑的回归测试。
 *
 * 三条契约直接对应用户报过的故障：
 *  1. 切视图不该把正在看的内容甩走 —— 锚点只用**源行**，不用像素；
 *  2. 切视图不该丢撤销栈 —— 编辑器状态要留、要能取回；
 *  3. 锚点用一次即清 —— 否则「渲染完毕」多次触发时页面会被反复拽回原处。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const {
  createHandoff,
  forgetDocument,
  invalidateState,
  leaveView,
  peekAnchor,
  rememberState,
  stateOf,
  takeAnchor,
} = await import('../apps/desktop/src/renderer/src/lib/view-handoff.ts')

test('新交接状态是空的', () => {
  const handoff = createHandoff()
  assert.equal(handoff.anchor, null)
  assert.equal(stateOf(handoff, '/a.md'), null)
})

test('离开视图记下源行（不看像素）', () => {
  const handoff = createHandoff()
  leaveView(handoff, { topLine: 137, scrollTop: 9999 })
  assert.equal(peekAnchor(handoff), 137)
})

test('没有位置读数时锚点为空，不是 0（0 会把页面钉到顶部）', () => {
  const handoff = createHandoff()
  leaveView(handoff, null)
  assert.equal(peekAnchor(handoff), null)
})

test('源行取整且不为负', () => {
  const handoff = createHandoff()
  leaveView(handoff, { topLine: 12.7, scrollTop: 0 })
  assert.equal(peekAnchor(handoff), 13)
  leaveView(handoff, { topLine: -5, scrollTop: 0 })
  assert.equal(peekAnchor(handoff), 0)
})

test('取锚点后必须清空（否则渲染多次会把页面反复拽回原处）', () => {
  const handoff = createHandoff()
  leaveView(handoff, { topLine: 42, scrollTop: 0 })
  assert.equal(takeAnchor(handoff), 42)
  assert.equal(takeAnchor(handoff), null)
  assert.equal(peekAnchor(handoff), null)
})

test('peek 不消费锚点（编辑器挂载时可多次读）', () => {
  const handoff = createHandoff()
  leaveView(handoff, { topLine: 7, scrollTop: 0 })
  assert.equal(peekAnchor(handoff), 7)
  assert.equal(peekAnchor(handoff), 7)
  assert.equal(takeAnchor(handoff), 7)
})

test('编辑器状态按文档路径分开存', () => {
  const handoff = createHandoff()
  rememberState(handoff, '/a.md', { undo: 1 })
  rememberState(handoff, '/b.md', { undo: 2 })
  assert.deepEqual(stateOf(handoff, '/a.md'), { undo: 1 })
  assert.deepEqual(stateOf(handoff, '/b.md'), { undo: 2 })
  assert.equal(stateOf(handoff, '/c.md'), null)
})

test('空状态不入库（null 会被误当成「有快照可复用」）', () => {
  const handoff = createHandoff()
  rememberState(handoff, '/a.md', null)
  rememberState(handoff, '/a.md', undefined)
  rememberState(handoff, '', { undo: 1 })
  assert.equal(stateOf(handoff, '/a.md'), null)
  assert.equal(handoff.editorStates.size, 0)
})

test('关闭文档时释放它的状态与锚点', () => {
  const handoff = createHandoff()
  rememberState(handoff, '/a.md', { undo: 1 })
  rememberState(handoff, '/b.md', { undo: 2 })
  leaveView(handoff, { topLine: 10, scrollTop: 0 })
  forgetDocument(handoff, '/a.md')
  assert.equal(stateOf(handoff, '/a.md'), null)
  // 别的文档不受影响
  assert.deepEqual(stateOf(handoff, '/b.md'), { undo: 2 })
  assert.equal(peekAnchor(handoff), null)
})

test('保存成功后作废快照（否则切回来 Ctrl+Z 会撤回已落盘内容）', () => {
  /*
   * 用户报：「切换渲染模式后会有可能又变回未保存」。
   * 快照里的撤销栈记着保存前的每一步：留着它，用户切走再切回来按 Ctrl+Z，
   * 会一路撤回已经写进磁盘的内容，脏标记又从「已保存」跳回「未保存」。
   */
  const handoff = createHandoff()
  rememberState(handoff, '/a.md', { undo: 1 })
  rememberState(handoff, '/b.md', { undo: 2 })

  invalidateState(handoff, '/a.md')
  assert.equal(stateOf(handoff, '/a.md'), null, '保存的文档必须丢掉旧快照')
  assert.deepEqual(stateOf(handoff, '/b.md'), { undo: 2 }, '别的文档不受影响')
})

test('作废空路径是安全的（无当前文档时不抛错）', () => {
  const handoff = createHandoff()
  rememberState(handoff, '/a.md', { undo: 1 })
  invalidateState(handoff, '')
  assert.deepEqual(stateOf(handoff, '/a.md'), { undo: 1 })
})
