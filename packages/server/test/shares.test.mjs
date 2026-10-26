import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createSharesService, SHARE_ID_RE } from '../src/shares.mjs'

const dirs = []
function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `ds-shares-${tag}-`))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function service(options = {}) {
  const dataDir = tempDir('data')
  return { dataDir, shares: createSharesService({ dataDir, ...options }) }
}

test('创建：文件与目录 kind 自动判定，id 为 16 位 hex', () => {
  const workspace = tempDir('ws')
  const file = join(workspace, 'note.md')
  writeFileSync(file, '# 标题', 'utf8')
  const sub = join(workspace, 'guide')
  mkdirSync(sub)

  const { shares } = service()
  const fileShare = shares.create({ path: file })
  const dirShare = shares.create({ path: sub })

  assert.match(fileShare.id, SHARE_ID_RE)
  assert.equal(fileShare.kind, 'file')
  assert.equal(fileShare.enabled, true)
  assert.equal(dirShare.kind, 'dir')
  assert.ok(fileShare.createdAt)
})

test('共享根约束：根外路径拒绝，根内与根本身允许', () => {
  const workspace = tempDir('ws')
  const inner = join(workspace, 'inner')
  mkdirSync(inner)
  const outside = tempDir('outside')

  const { shares } = service({ shareRoots: [workspace] })
  assert.doesNotThrow(() => shares.create({ path: inner }))
  assert.throws(
    () => shares.create({ path: outside }),
    error => error.code === 'OUTSIDE_ROOTS',
  )
})

test('空共享根 = 桌面模式：任意本机路径可分享（不再限制根）', () => {
  const workspace = tempDir('ws')
  const file = join(workspace, 'free.md')
  writeFileSync(file, '内容', 'utf8')
  const { shares } = service({ shareRoots: [] })
  assert.doesNotThrow(() => shares.create({ path: file }))
})

test('不存在的路径拒绝，且不写入登记', () => {
  const { shares } = service()
  assert.throws(
    () => shares.create({ path: join(tempDir('ws'), 'nope.md') }),
    error => error.code === 'TARGET_MISSING' && error.status === 404,
  )
  assert.equal(shares.list().length, 0)
})

test('生命周期：toggle 停用/恢复、remove 删除；resolveShare 区分三因', () => {
  const workspace = tempDir('ws')
  const file = join(workspace, 'doc.md')
  writeFileSync(file, '# x', 'utf8')
  const { shares } = service()
  const entry = shares.create({ path: file })

  assert.deepEqual(shares.resolveShare('deadbeefdeadbeef'), { error: 'not-found' })
  assert.ok(shares.resolveShare(entry.id).entry)

  shares.toggle(entry.id, false)
  assert.equal(shares.resolveShare(entry.id).error, 'disabled')
  shares.toggle(entry.id, true)
  assert.ok(shares.resolveShare(entry.id).entry)

  rmSync(file)
  assert.equal(shares.resolveShare(entry.id).error, 'missing')

  shares.remove(entry.id)
  assert.equal(shares.resolveShare(entry.id).error, 'not-found')
  assert.throws(
    () => shares.remove(entry.id),
    error => error.code === 'NOT_FOUND',
  )
})

test('代理语义：目录内容变化后 list 的 exists/isDir 反映真实状态', () => {
  const workspace = tempDir('ws')
  const sub = join(workspace, 'docs')
  mkdirSync(sub)
  const { shares } = service()
  const entry = shares.create({ path: sub })
  let listed = shares.list().find(item => item.id === entry.id)
  assert.equal(listed.exists, true)
  assert.equal(listed.isDir, true)

  rmSync(sub, { recursive: true })
  listed = shares.list().find(item => item.id === entry.id)
  assert.equal(listed.exists, false)
  assert.equal(listed.isDir, null)
})

test('持久化：新 service 实例读到既有登记', () => {
  const workspace = tempDir('ws')
  const file = join(workspace, 'a.md')
  writeFileSync(file, '# a', 'utf8')
  const dataDir = tempDir('data')
  const first = createSharesService({ dataDir })
  const entry = first.create({ path: file })

  const second = createSharesService({ dataDir })
  assert.equal(second.list().length, 1)
  assert.equal(second.list()[0].id, entry.id)
})

test('损坏的 shares.json 不阻塞启动（按空列表处理）', () => {
  const dataDir = tempDir('data')
  writeFileSync(join(dataDir, 'shares.json'), '{ 不是 JSON', 'utf8')
  const shares = createSharesService({ dataDir })
  assert.deepEqual(shares.list(), [])
})

test('审计回调收到 create/toggle/remove 事件', () => {
  const events = []
  const workspace = tempDir('ws')
  const file = join(workspace, 'b.md')
  writeFileSync(file, '# b', 'utf8')
  const { shares } = service({ audit: (type, payload) => events.push({ type, payload }) })
  const entry = shares.create({ path: file })
  shares.toggle(entry.id, false)
  shares.remove(entry.id)
  assert.deepEqual(
    events.map(event => event.type),
    ['share.create', 'share.toggle', 'share.remove'],
  )
})

test('非法 id 形态不进磁盘查询', () => {
  const { shares } = service()
  assert.deepEqual(shares.resolveShare('../etc/passwd'), { error: 'not-found' })
  assert.equal(existsSync(join(shares.shareRoots[0] ?? '', 'x')), false)
})
