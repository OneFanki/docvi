/**
 * 外部改动语义的回归测试。
 *
 * 用户报的问题是「没有刷新按钮，文件被外部改了看不到最新状态」。修法有两半：
 *   1. 主进程的 watcher 事件真正接到渲染层（`onExternalChange` 之前无人订阅，
 *      `applyExternal` 是死代码）；
 *   2. 补一个显式刷新入口，供监视失效时兜底。
 *
 * 这里钉住的是这一半**判断规则**：三种情形（内容没变 / 缓冲区干净 / 有未保存
 * 改动）的处理方式，以及 mtime 基线的对齐时机。规则错了不会报错，只会静默
 * 丢掉用户刚敲的内容——所以必须由测试守着。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { decideExternalChange, sameDocumentPath } =
  await import('../apps/desktop/src/renderer/src/lib/external-change.ts')

function buffer(text, savedText = text, diskText = text) {
  return { text, savedText, diskText }
}

test('内容与已知磁盘一致：判为 ignored（自保存的 watcher 回响）', () => {
  // 用户刚保存完：缓冲区 = 基线 = 磁盘，watcher 因 rename 又推一条
  assert.equal(decideExternalChange(buffer('abc'), { text: 'abc' }), 'ignored')
})

test('只是 mtime 变了但内容一样：仍判为 ignored（touch / 格式化原地写回）', () => {
  assert.equal(decideExternalChange(buffer('abc'), { text: 'abc' }), 'ignored')
})

test('缓冲区干净且磁盘内容变了：判为 adopted（静默采用）', () => {
  assert.equal(decideExternalChange(buffer('abc'), { text: '外部新内容' }), 'adopted')
})

test('缓冲区有未保存改动且磁盘也变了：判为 conflict（绝不静默覆盖）', () => {
  const dirty = buffer('我改的内容', 'abc', 'abc')
  assert.equal(decideExternalChange(dirty, { text: '外部新内容' }), 'conflict')
})

test('未保存改动与磁盘新内容恰好相同：判为 adopted，脏标记消失而不弹冲突', () => {
  // AI 把用户正在写的内容原样写回磁盘：采用不会丢字，报冲突纯属打扰
  const dirty = buffer('同一份内容', 'abc', 'abc')
  assert.equal(decideExternalChange(dirty, { text: '同一份内容' }), 'adopted')
})

test('路径比较忽略大小写与斜杠方向（Windows 同一文件两种写法）', () => {
  assert.equal(sameDocumentPath('C:\\Docs\\a.md', 'c:/docs/A.MD'), true)
  assert.equal(sameDocumentPath('/w/docs/a.md', '/w/docs/b.md'), false)
  // 前缀相同但文件名不同的不能被判成同一篇
  assert.equal(sameDocumentPath('/w/docs/a.md', '/w/docs/a.md.bak'), false)
})
