/**
 * 工作区内文件操作：真实文件系统单测。
 *
 * 全部操作都在临时目录里跑，用完删掉。这里测的是**边界与命名规则**——
 * 路径越界、重名、目录自包含这些错误一旦漏掉，代价是用户磁盘上的文档被覆盖
 * 或被移丢，所以每条规则都得有断言。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  copyEntry,
  createEntry,
  moveEntry,
  renameEntry,
  resolveForTrash,
} from '../../apps/desktop/src/main/fs-ops.ts'

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'docvi-fsops-'))
  return {
    root,
    ctx: { root },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('新建文档带 H1 骨架，扩展名自动补 .md', () => {
  const box = sandbox()
  try {
    const rel = createEntry(box.ctx, '', '新想法', 'file')
    assert.equal(rel, '新想法.md')
    assert.equal(readFileSync(join(box.root, rel), 'utf8'), '# 新想法\n\n')
  } finally {
    box.cleanup()
  }
})

test('新建文档不会重复追加 .md', () => {
  const box = sandbox()
  try {
    assert.equal(createEntry(box.ctx, '', '已知.md', 'file'), '已知.md')
  } finally {
    box.cleanup()
  }
})

test('同名新建报 E_EXISTS，而不是覆盖已有文件', () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.root, 'a.md'), '原文')
    assert.throws(
      () => createEntry(box.ctx, '', 'a.md', 'file'),
      error => error.code === 'E_EXISTS',
    )
    assert.equal(readFileSync(join(box.root, 'a.md'), 'utf8'), '原文')
  } finally {
    box.cleanup()
  }
})

test('新建目录到指定子目录', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.root, 'docs'))
    assert.equal(createEntry(box.ctx, 'docs', '素材', 'dir'), 'docs/素材')
  } finally {
    box.cleanup()
  }
})

test('名字里的路径分隔符被拒绝（防止借名字跨目录）', () => {
  const box = sandbox()
  try {
    assert.throws(
      () => createEntry(box.ctx, '', '../逃逸.md', 'file'),
      error => error.code === 'E_INVALID',
    )
    assert.throws(
      () => createEntry(box.ctx, '', 'a/b.md', 'file'),
      error => error.code === 'E_INVALID',
    )
  } finally {
    box.cleanup()
  }
})

test('改名保留内容并返回新相对路径', () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.root, 'old.md'), '内容')
    assert.equal(renameEntry(box.ctx, 'old.md', 'new.md'), 'new.md')
    assert.equal(readFileSync(join(box.root, 'new.md'), 'utf8'), '内容')
  } finally {
    box.cleanup()
  }
})

test('改名撞上已有文件时报 E_EXISTS', () => {
  const box = sandbox()
  try {
    writeFileSync(join(box.root, 'a.md'), 'A')
    writeFileSync(join(box.root, 'b.md'), 'B')
    assert.throws(
      () => renameEntry(box.ctx, 'a.md', 'b.md'),
      error => error.code === 'E_EXISTS',
    )
  } finally {
    box.cleanup()
  }
})

test('移动文件到子目录', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.root, 'docs'))
    writeFileSync(join(box.root, 'a.md'), 'A')
    assert.equal(moveEntry(box.ctx, 'a.md', 'docs'), 'docs/a.md')
  } finally {
    box.cleanup()
  }
})

test('目录不能移到它自己的子孙里（否则整棵树丢失）', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.root, 'outer'))
    mkdirSync(join(box.root, 'outer', 'inner'))
    assert.throws(
      () => moveEntry(box.ctx, 'outer', 'outer/inner'),
      error => error.code === 'E_INVALID',
    )
  } finally {
    box.cleanup()
  }
})

test('复制重名自动加序号，不覆盖已有文件', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.root, 'docs'))
    writeFileSync(join(box.root, 'a.md'), 'A')
    writeFileSync(join(box.root, 'docs', 'a.md'), '原有')

    assert.equal(copyEntry(box.ctx, 'a.md', 'docs'), 'docs/a 2.md')
    assert.equal(readFileSync(join(box.root, 'docs', 'a.md'), 'utf8'), '原有')
    assert.equal(readFileSync(join(box.root, 'docs', 'a 2.md'), 'utf8'), 'A')
  } finally {
    box.cleanup()
  }
})

test('复制目录递归拷贝内容，跳过点开头目录', () => {
  const box = sandbox()
  try {
    mkdirSync(join(box.root, 'src', 'sub'), { recursive: true })
    writeFileSync(join(box.root, 'src', 'a.md'), 'A')
    writeFileSync(join(box.root, 'src', 'sub', 'b.md'), 'B')
    mkdirSync(join(box.root, 'src', '.git'))
    writeFileSync(join(box.root, 'src', '.git', 'config'), 'x')

    const rel = copyEntry(box.ctx, 'src', '')
    assert.equal(rel, 'src 2')
    assert.equal(readFileSync(join(box.root, 'src 2', 'sub', 'b.md'), 'utf8'), 'B')
    assert.equal(
      (() => {
        try {
          readFileSync(join(box.root, 'src 2', '.git', 'config'))
          return true
        } catch {
          return false
        }
      })(),
      false,
    )
  } finally {
    box.cleanup()
  }
})

test('删除校验：工作区根不可删，越界路径被拒', () => {
  const box = sandbox()
  try {
    assert.throws(
      () => resolveForTrash(box.ctx, ''),
      error => error.code === 'E_INVALID',
    )
    assert.throws(
      () => resolveForTrash(box.ctx, '../outside.md'),
      error => error.code === 'E_INVALID',
    )
  } finally {
    box.cleanup()
  }
})
