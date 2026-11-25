/**
 * 标签预览 / 固定语义（VSCode 模型）。
 *
 * 契约：
 *  - 单击同一工作区里的另一篇文档 → **替换**当前预览标签，标签条不增长；
 *  - 双击 → 固定标签，之后单击不会再动它；
 *  - 同一篇文档已在某标签里 → 只激活，不新建第二个；
 *  - 预览标签不跨会话恢复。
 *
 * 这些规则全部落在纯 store 逻辑里（不依赖 DOM），所以可以直接建 store 单测。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createPinia, setActivePinia } from 'pinia'

/*
 * store 里有 600ms 防抖的会话写盘（`window.docvi.sessionWrite`）。
 * 在 node 环境里它会在测试结束后才触发，报 `window is not defined`。
 * 给一个空实现即可——本文件测的是标签语义，不测持久化通道。
 */
globalThis.window ??= { docvi: { sessionWrite: async () => {} } }

const { docKeyOf, useTabsStore } =
  await import('../../apps/desktop/src/renderer/src/stores/tabs.ts')

/** 每个用例独立 pinia，store 之间的标签不串 */
function freshStore() {
  setActivePinia(createPinia())
  return useTabsStore()
}

function docRef(workspaceId, relPath, title = relPath) {
  return {
    key: docKeyOf(workspaceId, '', relPath),
    workspaceId,
    relPath,
    absolutePath: `/ws/${workspaceId}/${relPath}`,
    title,
    scrollY: 0,
    topLine: -1,
    layoutKey: '',
  }
}

const WS = { id: 'ws1', name: '知识库' }

test('单击换另一篇文档 → 替换预览标签，标签条不增长', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'))
  const afterFirst = tabs.tabs.length

  tabs.openDoc(WS, docRef('ws1', 'b.md'))
  assert.equal(tabs.tabs.length, afterFirst, '连点十篇应该有同样多的标签，而不是十个')
  assert.equal(tabs.activeTab.preview, true)
  assert.equal(tabs.activeDoc.relPath, 'b.md', '预览标签的内容应换成新文档')
})

test('双击 → 新建固定标签，之后单击不再替换它', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  const pinnedId = tabs.activeId
  assert.equal(tabs.activeTab.preview, false)

  // 再单击另一篇：必须新建预览标签，不能复用那个固定的
  tabs.openDoc(WS, docRef('ws1', 'b.md'))
  assert.notEqual(tabs.activeId, pinnedId, '固定标签不能被单击顶掉')
  assert.equal(tabs.activeTab.preview, true)
  assert.equal(tabs.tabs.length, 2)
})

test('同一篇文档已在标签里 → 只激活，不新建', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  tabs.openDoc(WS, docRef('ws1', 'b.md'))
  const countBefore = tabs.tabs.length

  tabs.openDoc(WS, docRef('ws1', 'a.md'))
  assert.equal(tabs.tabs.length, countBefore, '已打开的文档不该占第二个标签')
  assert.equal(tabs.activeDoc.relPath, 'a.md')
})

test('对预览标签再次双击 → 原地升格为固定，而不是新建', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'))
  const previewId = tabs.activeId
  const countBefore = tabs.tabs.length

  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  assert.equal(tabs.tabs.length, countBefore, '升格不该多出一个标签')
  assert.equal(tabs.activeId, previewId)
  assert.equal(tabs.activeTab.preview, false, '双击后应变成固定标签')
})

test('预览标签不跨不同工作区复用：切到别的工作区单击 → 新建', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'))
  assert.equal(tabs.activeTab.workspaceId, 'ws1')

  tabs.openDoc({ id: 'ws2', name: '笔记' }, docRef('ws2', 'c.md'))
  assert.equal(tabs.activeTab.workspaceId, 'ws2')
  assert.equal(tabs.tabs.length, 2, '不同工作区不该共用一个预览标签：树会跟着串')
})

test('pin() 只对预览标签生效，固定标签返回 false', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  assert.equal(tabs.pin(tabs.activeId), false, '固定标签再 pin 应无操作')

  tabs.openDoc(WS, docRef('ws1', 'b.md'))
  assert.equal(tabs.pin(tabs.activeId), true)
  assert.equal(tabs.activeTab.preview, false)
})

test('previewTab 反映当前预览标签（标签条据此画斜体）', () => {
  const tabs = freshStore()
  assert.equal(tabs.previewTab, null, '没有预览标签时为空')

  tabs.openDoc(WS, docRef('ws1', 'a.md'))
  assert.equal(tabs.previewTab?.id, tabs.activeId)

  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  assert.equal(tabs.previewTab, null, '升格后不再有预览标签')
})

test('预览标签不跨会话恢复：hydrate 后一律是固定标签', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'))
  assert.equal(tabs.activeTab.preview, true)

  const session = tabs.serialize()
  // 模拟重启：新 store 用上一份快照恢复
  const next = freshStore()
  next.hydrate(session)
  const restored = next.tabs.find(tab => tab.kind === 'workspace')
  assert.ok(restored, '应该有恢复出来的工作区标签')
  assert.equal(restored.preview, false, '临时页不该在重启后仍是临时页')
})

/* ---------- 阅读位置：像素 + 源行两条坐标 ---------- */

/*
 * 只记像素就会在「排版变了」之后落错位置：字体、正文宽度一改整篇高度就变，
 * 同一像素指向别的内容。源行是内容坐标，怎么重排都指向同一段文字。
 * 这两条以前是靠扫 App.vue / tabs.ts 源码字符串「守护」的，改成直接调 store。
 */
test('setScroll 同时写像素与源行（后者是排版无关的坐标）', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })

  tabs.setScroll(tabs.activeId, 1733, 137, 'sans|mono|full')

  assert.equal(tabs.activeDoc.scrollY, 1733)
  assert.equal(tabs.activeDoc.topLine, 137)
  assert.equal(tabs.activeDoc.layoutKey, 'sans|mono|full')
})

test('setScroll 接受 topLine = 0（用户在最顶部是合法状态）', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  tabs.setScroll(tabs.activeId, 500, 20, 'k')

  tabs.setScroll(tabs.activeId, 0, 0, 'k')
  assert.equal(tabs.activeDoc.topLine, 0, '0 不能被当成「没给」而保留旧值')
  assert.equal(tabs.activeDoc.scrollY, 0)
})

test('setScroll 拒绝负数源行（-1 是「读不到」的哨兵，不是坐标）', () => {
  const tabs = freshStore()
  tabs.openDoc(WS, docRef('ws1', 'a.md'), { pin: true })
  tabs.setScroll(tabs.activeId, 800, 64, 'k')

  // 阅读视图刚重挂载、还没排版完时读位置会拿到 -1；不能让它覆盖已有坐标
  tabs.setScroll(tabs.activeId, 800, -1, '')
  assert.equal(tabs.activeDoc.topLine, 64, '未知源行不能覆盖已知值')
  assert.equal(tabs.activeDoc.layoutKey, 'k', '空签名同样不能覆盖')
})
