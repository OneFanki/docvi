/**
 * 临时分享服务单测（deployer 侧，代理语义）：
 * - 创建：共享根内文件/目录（kind 自动判定）；根外/不存在拒绝；
 * - 生命周期：toggle / remove；resolveShare 的三种失效因（not-found/disabled/missing）；
 * - 代理语义：目标移动/删除 → missing（不复制内容，路径即真相）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ShareError, SHARE_ID_RE, createSharesService } from '../src/shares.mjs'

function makeService() {
  const root = mkdtempSync(join(tmpdir(), 'deployer-shares-'))
  const dataDir = join(root, 'data')
  const shareRoot = join(root, 'share')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(shareRoot, 'docs'), { recursive: true })
  writeFileSync(join(shareRoot, 'design.md'), '# 设计文档\n')
  writeFileSync(join(shareRoot, 'docs', 'a.md'), '# A\n')
  const events = []
  const service = createSharesService({
    dataDir,
    shareRoots: [shareRoot],
    // 真实签名对齐 store.audit(dataDir, entry)——少传 dataDir 曾把 entry 当路径用（实测 500）
    audit: (_dataDir, entry) => events.push(entry),
  })
  return { root, dataDir, shareRoot, service, events }
}

test('创建：文件与目录（kind 自动判定），id 为 16 位 hex', () => {
  const { root, shareRoot, service, events } = makeService()
  const fileShare = service.create({ path: join(shareRoot, 'design.md') })
  assert.equal(fileShare.kind, 'file')
  assert.equal(fileShare.enabled, true)
  assert.ok(SHARE_ID_RE.test(fileShare.id), `id 应为 16 位 hex：${fileShare.id}`)
  const dirShare = service.create({ path: join(shareRoot, 'docs'), name: '设计目录' })
  assert.equal(dirShare.kind, 'dir')
  assert.equal(dirShare.name, '设计目录')
  assert.equal(service.list().length, 2)
  assert.ok(events.some(e => e.type === 'share.create'))
  rmSync(root, { recursive: true, force: true })
})

test('创建：共享根外 / 不存在都拒绝（附明确错误码）', () => {
  const { root, shareRoot, service } = makeService()
  assert.throws(
    () => service.create({ path: join(root, 'outside.md') }),
    error => error instanceof ShareError && error.code === 'OUTSIDE_ROOTS',
  )
  assert.throws(
    () => service.create({ path: join(shareRoot, 'nope.md') }),
    error => error instanceof ShareError && error.code === 'TARGET_MISSING',
  )
  assert.throws(
    () => service.create({ path: '' }),
    error => error instanceof ShareError && error.code === 'PATH_REQUIRED',
  )
  rmSync(root, { recursive: true, force: true })
})

test('生命周期：toggle 停用/恢复、remove 删除；resolveShare 三种失效因', () => {
  const { root, shareRoot, service } = makeService()
  const share = service.create({ path: join(shareRoot, 'design.md') })

  assert.ok(service.resolveShare(share.id).entry, '正常解析')
  assert.equal(service.resolveShare('f'.repeat(16)).error, 'not-found')
  assert.equal(service.resolveShare('bad-id').error, 'not-found')

  service.toggle(share.id, false)
  assert.equal(service.resolveShare(share.id).error, 'disabled')
  service.toggle(share.id, true)
  assert.ok(service.resolveShare(share.id).entry)

  service.remove(share.id)
  assert.equal(service.resolveShare(share.id).error, 'not-found')
  rmSync(root, { recursive: true, force: true })
})

test('代理语义：目标移动/删除后 resolveShare → missing（不复制内容）', () => {
  const { root, shareRoot, service } = makeService()
  const share = service.create({ path: join(shareRoot, 'design.md') })
  renameSync(join(shareRoot, 'design.md'), join(shareRoot, 'design-moved.md'))
  assert.equal(service.resolveShare(share.id).error, 'missing', '文件移动即失效（路径即真相）')
  assert.equal(service.list()[0].exists, false, '列表标注目标已消失')

  writeFileSync(join(shareRoot, 'design-moved.md'), '# 改')
  assert.equal(
    service.resolveShare(share.id).error,
    'missing',
    '内容变化不影响（仍是失效——路径已不在）',
  )
  rmSync(root, { recursive: true, force: true })
})

test('持久化：重启（新 service 实例）后分享仍在', () => {
  const { root, dataDir, shareRoot, service } = makeService()
  const share = service.create({ path: join(shareRoot, 'docs') })
  const revived = createSharesService({ dataDir, shareRoots: [shareRoot], audit: () => {} })
  const found = revived.list().find(s => s.id === share.id)
  assert.ok(found, 'shares.yaml 持久化后重读可见')
  assert.equal(found.kind, 'dir')
  rmSync(root, { recursive: true, force: true })
})
