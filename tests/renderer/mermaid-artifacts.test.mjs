/**
 * mermaid 渲染失败残留的清理（纯逻辑单测）。
 *
 * 这条防线挡的不是「页面上多一个看不见的元素」：mermaid 11 的 `render()` 解析
 * 失败时会把错误图插到 `<body>` 末尾，那个图有几百像素高，会把 body 撑过视口。
 * 此后任何 `scrollIntoView`（右侧目录跳转、搜索命中定位）都会连带滚动
 * `<html>`/`<body>`，把固定的标题栏与标签栏推出视口——界面看起来彻底坏了。
 *
 * 所以这里的边界必须钉住：**只删我们自己发起的渲染留下的那些**，其余元素一个
 * 都不许碰。删错的代价是用户内容消失，比不删更糟。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanupMermaidFailureArtifacts } from '../../packages/renderer-core/src/mermaid.ts'

/** 最小 Document 替身：只提供清理函数用到的那一个方法，remove 真的从集合里摘掉 */
function fakeDoc(ids) {
  const alive = [...ids]
  const removed = []
  const doc = {
    querySelectorAll: () =>
      alive.map(id => ({
        id,
        remove: () => {
          removed.push(id)
          alive.splice(alive.indexOf(id), 1)
        },
      })),
  }
  return { doc, removed, alive }
}

test('删掉 mermaid 留下的错误图残留', () => {
  const { doc, removed } = fakeDoc(['ddocvi-mermaid-1', 'ddocvi-mermaid-27'])
  cleanupMermaidFailureArtifacts(doc)
  assert.deepEqual(removed, ['ddocvi-mermaid-1', 'ddocvi-mermaid-27'])
})

test('不动页面上的其它元素，形状相近也不行', () => {
  /*
   * `app` / `dother` / `docvi-mermaid-1`（少一个 d）都只是形状相近：清理必须
   * 是前缀完全匹配，否则迟早会在某个真实文档上删错东西。
   */
  const { doc, removed, alive } = fakeDoc(['app', 'dother', 'docvi-mermaid-1', 'ddocvi-mermaid-'])
  cleanupMermaidFailureArtifacts(doc)
  assert.deepEqual(removed, ['ddocvi-mermaid-'])
  assert.deepEqual(alive, ['app', 'dother', 'docvi-mermaid-1'], '其余元素必须原样留在文档里')
})

test('一篇里多张图连续失败时，清理是幂等的', () => {
  /*
   * 调用点在渲染循环的 catch 里，一次渲染几十张图就有几十次调用；第二次进来
   * 时上一批已经删掉，不能再报错、也不能重复计数。
   */
  const { doc, removed } = fakeDoc(['ddocvi-mermaid-3', 'ddocvi-mermaid-4'])
  cleanupMermaidFailureArtifacts(doc)
  cleanupMermaidFailureArtifacts(doc)
  assert.deepEqual(removed, ['ddocvi-mermaid-3', 'ddocvi-mermaid-4'], '每个残留只删一次')
})

test('没有残留时静默通过', () => {
  const { doc, removed } = fakeDoc(['app'])
  assert.doesNotThrow(() => cleanupMermaidFailureArtifacts(doc))
  assert.deepEqual(removed, [])
})
