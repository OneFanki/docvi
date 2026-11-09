/**
 * 搜索 worker 的分片替换契约。
 *
 * 这一个模块决定索引是「增量」还是「全量」——本轮 CPU 问题的根因就是它原来
 * 只有 `index`（整库重建）。现在按工作区分片，必须保证：
 *
 *  1. 替换某工作区只动它自己那一片，别的工作区一条不少；
 *  2. 同一工作区重复替换是幂等的（文档改名 / 删掉的后不能再搜到）；
 *  3. 正文与索引一起换（否则摘要会摘到旧文本）；
 *  4. `drop` 之后那一片彻底消失，`documentCount` 同步减少。
 *
 * worker 是 webworker 形状（`self.onmessage` / `self.postMessage`），测试里用
 * 最小桩把它们接出来：不桩的话 import 阶段就 ReferenceError。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 装一个最小 self 桩，返回「发一条消息进去、拿回响应」的驱动器。
 *
 * **整个测试文件共用一个实例**：ESM 模块只求值一次，`self.onmessage = …` 也只
 * 挂一次，第二次 import 拿到的是缓存、不会再绑新桩。所以每个用例开头先 `clear`
 * 把模块级状态复位，而不是给每个用例重新造实例。
 */
let harness = null

async function sharedHarness() {
  if (harness) return harness
  const outbox = []
  let handler = null
  globalThis.self = {
    set onmessage(fn) {
      handler = fn
    },
    get onmessage() {
      return handler
    },
    postMessage(message) {
      outbox.push(message)
    },
  }
  await import('../../apps/desktop/src/renderer/src/workers/search.worker.ts')
  assert.equal(typeof handler, 'function', 'worker 必须在 import 时挂上 onmessage')

  harness = {
    send(request) {
      const before = outbox.length
      handler({ data: request })
      assert.equal(outbox.length, before + 1, '每条请求必须回一条响应')
      return outbox[outbox.length - 1]
    },
    /** 复位模块级索引，让每个用例从空状态开始 */
    reset() {
      return this.send({ type: 'clear' })
    },
  }
  return harness
}

test('替换某工作区不影响其他工作区', async () => {
  const h = await sharedHarness()
  h.reset()
  {
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'a.md', text: 'alpha 文档' }] })
    const afterFirst = h.send({
      type: 'replace',
      workspaceId: 'w2',
      docs: [{ path: 'b.md', text: 'beta 文档' }],
    })
    assert.equal(afterFirst.count, 2, '两个工作区各一篇')

    // 重放 w1（模拟外部改动触发重读）：w2 必须还在
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'a.md', text: 'alpha 改过' }] })
    const beta = h.send({ type: 'query', id: 1, text: 'beta' })
    assert.equal(beta.hits.length, 1, '替换 w1 不该把 w2 的命中删掉')
    assert.equal(beta.hits[0].workspaceId, 'w2')
  }
})

test('重复替换同一工作区是幂等的：删掉/改名的文档不再命中', async () => {
  const h = await sharedHarness()
  h.reset()
  {
    h.send({
      type: 'replace',
      workspaceId: 'w1',
      docs: [
        { path: 'old.md', text: '唯一的旧关键词 zebra' },
        { path: 'keep.md', text: '保留的关键词 yonder' },
      ],
    })
    assert.equal(h.send({ type: 'query', id: 1, text: 'zebra' }).hits.length, 1)

    // 改名 old.md → new.md，内容也变了
    const after = h.send({
      type: 'replace',
      workspaceId: 'w1',
      docs: [
        { path: 'new.md', text: '改名后的关键词 quasar' },
        { path: 'keep.md', text: '保留的关键词 yonder' },
      ],
    })
    assert.equal(after.count, 2, '文档数仍是 2（不是 4）')

    assert.equal(
      h.send({ type: 'query', id: 2, text: 'zebra' }).hits.length,
      0,
      '旧路径与旧内容都必须消失，否则就是「搜得到但打不开」的脏命中',
    )
    assert.equal(h.send({ type: 'query', id: 3, text: 'quasar' }).hits.length, 1)
    assert.equal(h.send({ type: 'query', id: 4, text: 'yonder' }).hits.length, 1)
  }
})

test('正文跟着分片一起换：摘要不能摘到旧文本', async () => {
  const h = await sharedHarness()
  h.reset()
  {
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'a.md', text: '旧内容 apple' }] })
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'a.md', text: '新内容 apple' }] })
    const result = h.send({ type: 'query', id: 1, text: 'apple' })
    assert.equal(result.hits.length, 1)
    assert.ok(
      result.hits[0].snippet.includes('新内容'),
      `摘要应来自新正文，实际是：${result.hits[0].snippet}`,
    )
  }
})

test('drop 后该工作区彻底可搜不到，计数同步', async () => {
  const h = await sharedHarness()
  h.reset()
  {
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'a.md', text: 'alpha' }] })
    h.send({ type: 'replace', workspaceId: 'w2', docs: [{ path: 'b.md', text: 'alpha' }] })
    const dropped = h.send({ type: 'drop', workspaceId: 'w1' })
    assert.equal(dropped.count, 1)
    const hits = h.send({ type: 'query', id: 1, text: 'alpha' }).hits
    assert.equal(hits.length, 1)
    assert.equal(hits[0].workspaceId, 'w2')
  }
})

test('同一相对路径在两个工作区里互不覆盖', async () => {
  const h = await sharedHarness()
  h.reset()
  {
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'README.md', text: '第一仓' }] })
    h.send({ type: 'replace', workspaceId: 'w2', docs: [{ path: 'README.md', text: '第二仓' }] })
    const hits = h.send({ type: 'query', id: 1, text: 'README' }).hits
    // 标题相同、命中两条：主键必须带 workspaceId，否则后写入的会顶掉前一个
    assert.equal(hits.length, 2)
    assert.deepEqual(new Set(hits.map(hit => hit.workspaceId)), new Set(['w1', 'w2']))
  }
})

test('clear 之后回到空索引', async () => {
  const h = await sharedHarness()
  h.reset()
  {
    h.send({ type: 'replace', workspaceId: 'w1', docs: [{ path: 'a.md', text: 'alpha' }] })
    const cleared = h.send({ type: 'clear' })
    assert.equal(cleared.count, 0)
    assert.equal(h.send({ type: 'query', id: 1, text: 'alpha' }).hits.length, 0)
  }
})
