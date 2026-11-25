/**
 * 视图切换「交接」逻辑的回归测试。
 *
 * 四条契约直接对应用户报过的故障：
 *  1. 切视图不该把正在看的内容甩走 —— 锚点只用**源行**，不用像素；
 *  2. 切视图不该丢撤销栈 —— 编辑器状态要留、要能取回；
 *  3. 锚点用一次即清 —— 否则「渲染完毕」多次触发时页面会被反复拽回原处；
 *  4. 锚点**属于某一篇文档** —— 全局单槽会让 A 的行号滚到 B 上（2026-11-24 审查）。
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

const A = 'C:/ws/a.md'
const B = 'C:/ws/b.md'

test('新交接状态是空的', () => {
  const handoff = createHandoff()
  assert.equal(handoff.anchor, null)
  assert.equal(stateOf(handoff, '/a.md'), null)
})

test('离开视图记下源行（不看像素）', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 137, scrollTop: 9999 })
  assert.equal(peekAnchor(handoff, A), 137)
})

test('没有位置读数时锚点为空，不是 0（0 会把页面钉到顶部）', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, null)
  assert.equal(peekAnchor(handoff, A), null)
})

test('源行取整，负数（未知）记为无锚点', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 12.7, scrollTop: 0 })
  assert.equal(peekAnchor(handoff, A), 13)

  /*
   * 负数是 ReaderView.getTopLine 的哨兵，表示「这一篇读不到源行」。
   *
   * 曾经这里写的是 `Math.max(0, …)`，把 -1 压成 0——0 是**合法坐标**
   * （用户就在最顶部），保存它等于谎称「他当时看着开头」，恢复时
   * `scrollToSourceLine(0)` 会把文档拽回顶部。这是「切标签回顶」的最后一层
   * 成因：文件监视回调在阅读视图刚重挂载、还没排版完时读位置，拿到 -1。
   */
  leaveView(handoff, A, { topLine: -5, scrollTop: 0 })
  assert.equal(peekAnchor(handoff, A), null, '未知位置不能记成 0（0 是「在最顶部」）')

  /* 0 必须能存下来：用户真的在最顶部时，恢复就该回到顶部 */
  leaveView(handoff, A, { topLine: 0, scrollTop: 0 })
  assert.equal(peekAnchor(handoff, A), 0, '合法的 0 要保留')
})

test('取锚点后必须清空（否则渲染多次会把页面反复拽回原处）', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 42, scrollTop: 0 })
  assert.equal(takeAnchor(handoff, A), 42)
  assert.equal(takeAnchor(handoff, A), null)
  assert.equal(peekAnchor(handoff, A), null)
})

test('peek 不消费锚点（编辑器挂载时可多次读）', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 7, scrollTop: 0 })
  assert.equal(peekAnchor(handoff, A), 7)
  assert.equal(peekAnchor(handoff, A), 7)
  assert.equal(takeAnchor(handoff, A), 7)
})

/*
 * 以下三条锁的是锚点归属。曾经的实现是全局单槽 `anchor: number | null`：
 *  - 连点两篇时，A 的视口行被拿去滚 B（串档）；
 *  - B 在顶部时记下的 0 又在切回 A 时把 A 拉回开头。
 * E2E 实测：长文滚到 900px，切走再切回，落点 0。
 */
test('锚点只能被同一篇文档取到，别的文档视为无锚点', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 32, scrollTop: 900 })

  assert.equal(peekAnchor(handoff, B), null, 'B 不该认领 A 的锚点')
  assert.equal(takeAnchor(handoff, B), null, '取别人的锚点取不到')
  assert.equal(peekAnchor(handoff, A), 32, 'A 的锚点没被别人取走')
  assert.equal(takeAnchor(handoff, A), 32)
})

test('连点两篇时后记的锚点覆盖前一条，不会串给第三篇', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 32, scrollTop: 900 })
  leaveView(handoff, B, { topLine: 7, scrollTop: 200 })

  assert.equal(peekAnchor(handoff, A), null, 'A 的旧锚点已被 B 覆盖')
  assert.equal(peekAnchor(handoff, B), 7)
})

test('路径分隔符与大小写不影响归属判定（Windows 口径）', () => {
  const handoff = createHandoff()
  leaveView(handoff, 'C:\\WS\\A.md', { topLine: 12, scrollTop: 0 })

  assert.equal(peekAnchor(handoff, 'c:/ws/a.md'), 12, '同一篇的不同写法必须互认')
})

test('没有路径就没有归属：锚点作废', () => {
  const handoff = createHandoff()
  leaveView(handoff, A, { topLine: 5, scrollTop: 0 })
  leaveView(handoff, '', { topLine: 5, scrollTop: 0 })
  assert.equal(peekAnchor(handoff, A), null)
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
  leaveView(handoff, A, { topLine: 10, scrollTop: 0 })
  forgetDocument(handoff, '/a.md')
  assert.equal(stateOf(handoff, '/a.md'), null)
  // 别的文档不受影响
  assert.deepEqual(stateOf(handoff, '/b.md'), { undo: 2 })
  assert.equal(handoff.anchor, null)
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
