/**
 * 内建默认工作区播种的契约测试。
 *
 * 关键不变量：
 *  - 首次启动创建 `<文档>/docvi` 并登记为工作区
 *  - **只播种一次**：用户删掉后重启不再重建（那是骚扰，不是便利）
 *  - 目录不可写时不抛错、不阻塞启动，只回报失败
 *  - 已存在同一目录的工作区记录时不产生重复条目
 *
 * 一律用临时目录当「文档」目录：AGENTS 硬约束禁止测试触碰真实用户数据目录。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ensureDefaultWorkspace,
  defaultWorkspaceRoot,
} from '../../apps/desktop/src/main/default-workspace.ts'
import { createWorkspaceStore } from '../../apps/desktop/src/main/store.ts'

/** 造一套干净的临时环境：documents 目录 + workspaces.json + settings 桩 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docvi-default-ws-'))
  const documents = join(root, 'Documents')
  mkdirSync(documents, { recursive: true })
  const store = createWorkspaceStore(join(root, 'workspaces.json'))
  const state = { seeded: false }
  return {
    root,
    documents,
    store,
    state,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    options(overrides = {}) {
      return {
        store,
        documentsDir: documents,
        isSeeded: () => state.seeded,
        markSeeded: () => {
          state.seeded = true
        },
        ...overrides,
      }
    },
  }
}

test('首次播种：创建 <文档>/docvi 并登记为工作区，标记已播种', () => {
  const f = fixture()
  try {
    const result = ensureDefaultWorkspace(f.options())
    assert.equal(result.created, true)
    assert.equal(result.root, defaultWorkspaceRoot(f.documents))
    assert.ok(existsSync(result.root), '目录必须真的建出来')
    assert.ok(statSync(result.root).isDirectory())
    assert.equal(f.store.list().length, 1)
    assert.equal(f.store.list()[0].root, result.root)
    assert.equal(f.state.seeded, true)
  } finally {
    f.cleanup()
  }
})

test('幂等：已播种后再次调用不做任何事（不重建目录、不加记录）', () => {
  const f = fixture()
  try {
    ensureDefaultWorkspace(f.options())
    const entryId = f.store.list()[0].id

    // 模拟用户把它删了
    rmSync(defaultWorkspaceRoot(f.documents), { recursive: true, force: true })
    f.store.remove(entryId)

    const again = ensureDefaultWorkspace(f.options())
    assert.equal(again.created, false)
    assert.equal(again.reason, 'seeded')
    assert.equal(
      existsSync(defaultWorkspaceRoot(f.documents)),
      false,
      '用户删掉就是不想要，重启不能再建出来',
    )
    assert.equal(f.store.list().length, 0)
  } finally {
    f.cleanup()
  }
})

test('目录已存在但未播种：仍标记已播种，不重复建目录', () => {
  const f = fixture()
  try {
    const target = defaultWorkspaceRoot(f.documents)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, '已有.md'), '# 已有\n', 'utf8')

    const result = ensureDefaultWorkspace(f.options())
    assert.equal(result.created, true)
    assert.ok(existsSync(join(target, '已有.md')), '既有内容不能被清掉')
    assert.equal(f.state.seeded, true)
  } finally {
    f.cleanup()
  }
})

test('同目录已在工作区表里时不产生重复记录', () => {
  const f = fixture()
  try {
    const target = defaultWorkspaceRoot(f.documents)
    // 用户此前手动添加过同一个目录
    f.store.add({
      id: 'manually-added',
      name: 'docvi',
      root: target,
      addedAt: 1,
      lastOpenedAt: 1,
    })
    ensureDefaultWorkspace(f.options())
    assert.equal(f.store.list().length, 1, '同 root 只能有一条记录')
    assert.equal(f.store.list()[0].id, 'manually-added', '保留用户原有记录')
  } finally {
    f.cleanup()
  }
})

test('目录不可写：不抛错、不标记已播种，返回 failed', () => {
  const f = fixture()
  try {
    /*
     * 用「文档目录位置被一个普通文件占住」模拟不可写：mkdir 会 ENOTDIR。
     * 比 chmod 可靠——Windows 上 chmod 对目录基本无效。
     */
    const blocked = join(f.root, 'blocked-documents')
    writeFileSync(blocked, 'x', 'utf8')

    const messages = []
    const result = ensureDefaultWorkspace(
      f.options({ documentsDir: blocked, log: message => messages.push(message) }),
    )
    assert.equal(result.created, false)
    assert.equal(result.root, null)
    assert.equal(result.reason, 'failed')
    assert.equal(f.state.seeded, false, '失败不能标记，下次启动还应重试')
    assert.ok(messages.some(message => message.includes('默认工作区创建失败')))
  } finally {
    f.cleanup()
  }
})

test('markSeeded 失败不影响目录与记录已经建好', () => {
  const f = fixture()
  try {
    const messages = []
    const result = ensureDefaultWorkspace(
      f.options({
        markSeeded: () => {
          throw new Error('settings 只读')
        },
        log: message => messages.push(message),
      }),
    )
    assert.equal(result.created, true)
    assert.ok(existsSync(defaultWorkspaceRoot(f.documents)))
    assert.equal(f.store.list().length, 1)
    assert.ok(messages.some(message => message.includes('标记写入失败')))
  } finally {
    f.cleanup()
  }
})

test('播种时默认工作区的排序偏好是 mtime（AI 随手写，按最近改的找）', () => {
  const f = fixture()
  try {
    ensureDefaultWorkspace(f.options())
    const entry = f.store.list()[0]
    assert.equal(entry.treeSort, 'mtime', '默认工作区应当按修改时间排序')
  } finally {
    f.cleanup()
  }
})

test('用户早已手动加过同目录：只补排序偏好，不覆盖其它字段', () => {
  const f = fixture()
  try {
    const target = defaultWorkspaceRoot(f.documents)
    f.store.add({
      id: 'manually-added',
      name: '我的 docvi',
      root: target,
      addedAt: 111,
      lastOpenedAt: 222,
    })
    ensureDefaultWorkspace(f.options())
    const entry = f.store.list()[0]
    assert.equal(entry.id, 'manually-added', '保留用户原有记录')
    assert.equal(entry.name, '我的 docvi', '不覆盖用户起的名字')
    assert.equal(entry.addedAt, 111, '不覆盖添加时间')
    assert.equal(entry.treeSort, 'mtime', '补上排序偏好')
  } finally {
    f.cleanup()
  }
})

test('store.setTreeSort：落盘持久化，重新装载仍在', () => {
  const f = fixture()
  try {
    const entry = f.store.add({
      id: 'w1',
      name: 'w1',
      root: join(f.root, 'w1'),
      addedAt: 1,
      lastOpenedAt: 1,
    })
    assert.equal(f.store.setTreeSort(entry.id, 'mtime')?.treeSort, 'mtime')
    // 同一文件重新建 store：模拟重启
    const reloaded = createWorkspaceStore(join(f.root, 'workspaces.json'))
    assert.equal(reloaded.find('w1')?.treeSort, 'mtime', '排序偏好必须落盘')
    // 不存在的工作区返回 undefined，不抛错
    assert.equal(f.store.setTreeSort('ghost', 'manual'), undefined)
  } finally {
    f.cleanup()
  }
})

test('isRemovableWorkspace：默认工作区不可移除，其余都可以', async () => {
  const { isRemovableWorkspace } = await import('../../apps/desktop/src/main/default-workspace.ts')
  const def = defaultWorkspaceRoot('/docs')
  assert.equal(isRemovableWorkspace({ root: def }, def), false, '默认工作区不可移除')
  assert.equal(isRemovableWorkspace({ root: '/work/docs' }, def), true, '普通工作区可移除')
  // 没有默认工作区时（容器 / 播种失败），任何工作区都可移除
  assert.equal(isRemovableWorkspace({ root: def }, null), true)
  assert.equal(isRemovableWorkspace({ root: def }, undefined), true)
})
