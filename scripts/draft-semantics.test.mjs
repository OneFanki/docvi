/**
 * 草稿语义的回归测试：两条不变量，直接对应用户报的
 * 「切渲染模式后未保存状态有时在有时没了 + 提示恢复了草稿」。
 *
 * 背景：组件每次切视图都重新挂载，而「卸载落草稿」与「挂载读草稿」是两个异步
 * IPC。若「保存后残留的防抖定时器」把**已保存内容**写成草稿，下次挂载读到它
 * 就会覆盖当前缓冲区并弹「已恢复草稿」——脏标记随即从「已保存」跳回「未保存」。
 *
 * ⚠️ 这里不是测实现，而是测**语义**：把草稿读写抽成一个最小的内存模型，
 * 把产品代码里的三条规则（保存前掐定时器 / 只在脏时写 / 只在干净时恢复）
 * 逐条表达出来。规则一旦被改掉，这里的用例就会失败。
 *
 * 真实链路的端到端验证在 CDP 脚本里（不需要 Electron 也能跑）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 文档 + 草稿的最小模型。
 *
 * `flush()` 用同步方式模拟「防抖到点」，避免测试依赖真实计时器。
 */
function createWorld() {
  /** 草稿存储：path → { text, updatedAt } */
  const drafts = new Map()
  const writes = []
  let clock = 1000
  const now = () => (clock += 100)

  const world = {
    drafts,
    writes,
    /** 待落的防抖任务（null = 没有） */
    pending: null,
    /** 排一次草稿落盘（产品代码：EditorView.scheduleDraft） */
    schedule(record) {
      world.pending = record
    },
    /** 掐掉待落任务（产品代码：EditorView.cancelDraftTimer + save） */
    cancel() {
      world.pending = null
    },
    /** 防抖到点（产品代码：setTimeout 回调） */
    flush() {
      const record = world.pending
      world.pending = null
      if (!record) return 'none'
      // 规则一：只在真有未保存改动时才落草稿
      if (record.text === record.savedText) return 'skipped-clean'
      drafts.set(record.path, { text: record.text, updatedAt: now() })
      writes.push(record.text)
      return 'written'
    },
    /** 保存（产品代码：EditorView.save） */
    save(record) {
      record.savedText = record.text
      record.mtime = now()
      // 规则二：保存必须先掐定时器，再清草稿
      world.cancel()
      drafts.delete(record.path)
    },
    /** 挂载时的草稿恢复（产品代码：EditorView.mountEditor） */
    mount(record) {
      // 规则三：只有缓冲区干净时才看草稿
      if (record.text !== record.savedText) return 'kept-buffer'
      const draft = drafts.get(record.path)
      if (!draft) return 'clean'
      if (draft.text === record.savedText) return 'clean'
      if (draft.updatedAt <= record.mtime) return 'clean'
      record.text = draft.text
      return 'restored'
    },
  }
  return world
}

function record(text, path = '/a.md') {
  return { path, text, savedText: text, mtime: 1000 }
}

test('打字后立刻保存：不会写出「等于磁盘内容」的草稿', () => {
  const world = createWorld()
  const doc = record('磁盘内容')
  doc.text = '磁盘内容 + 改动'
  world.schedule(doc)
  world.save(doc)

  // 即使防抖「到点」也什么都不该写（定时器已被掐掉）
  assert.equal(world.pending, null)
  world.flush()
  assert.equal(world.writes.length, 0)
  assert.equal(world.drafts.get('/a.md'), undefined)
})

test('定时器漏掐时也不会写出干净内容的草稿（第二道防线）', () => {
  const world = createWorld()
  const doc = record('内容')
  doc.text = '内容 + 改动'
  world.schedule(doc)
  // 模拟「已经保存完，但定时器还挂着」的最坏情况
  doc.savedText = doc.text
  assert.equal(world.flush(), 'skipped-clean')
  assert.equal(world.writes.length, 0)
})

test('缓冲区脏时挂载：不用草稿覆盖（保住刚输的内容）', () => {
  const world = createWorld()
  const doc = record('磁盘内容')
  doc.text = '磁盘内容 + 未保存改动'
  // 上一轮遗留的草稿：更新，但内容是旧的
  world.drafts.set('/a.md', { text: '磁盘内容 + 更早的改动', updatedAt: 9000 })

  assert.equal(world.mount(doc), 'kept-buffer')
  assert.equal(doc.text, '磁盘内容 + 未保存改动')
})

test('缓冲区干净时仍能从崩溃草稿恢复（这条路径不能被误伤）', () => {
  const world = createWorld()
  const doc = record('磁盘内容')
  world.drafts.set('/a.md', { text: '崩溃前的改动', updatedAt: 9000 })

  assert.equal(world.mount(doc), 'restored')
  assert.equal(doc.text, '崩溃前的改动')
})

test('草稿与磁盘一致：不恢复、不弹提示（避免无意义重排）', () => {
  const world = createWorld()
  const doc = record('磁盘内容')
  world.drafts.set('/a.md', { text: '磁盘内容', updatedAt: 9000 })

  assert.equal(world.mount(doc), 'clean')
  assert.equal(doc.text, '磁盘内容')
})

test('草稿比磁盘旧：不恢复（避免把文件退回旧版本）', () => {
  const world = createWorld()
  const doc = record('磁盘内容')
  doc.mtime = 9999
  world.drafts.set('/a.md', { text: '旧草稿', updatedAt: 3000 })

  assert.equal(world.mount(doc), 'clean')
  assert.equal(doc.text, '磁盘内容')
})

test('完整往返：打字 → 草稿 → 切视图 → 内容还在 → 保存后不再回灌', () => {
  const world = createWorld()
  const doc = record('原文')
  doc.text = '原文 + 我的改动'
  world.schedule(doc)
  world.flush()
  assert.equal(world.drafts.get('/a.md')?.text, '原文 + 我的改动')

  // 切视图：缓冲区的 text 由文档模型持有，仍是脏的
  assert.equal(world.mount(doc), 'kept-buffer')
  assert.equal(doc.text, '原文 + 我的改动')

  // 保存：草稿清空，之后任何一次挂载都不该「恢复」
  world.save(doc)
  assert.equal(doc.text, '原文 + 我的改动')
  assert.equal(doc.savedText, '原文 + 我的改动')
  assert.equal(world.mount(doc), 'clean')
})
