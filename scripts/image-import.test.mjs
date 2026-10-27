/**
 * 图片入库的回归测试。
 *
 * 用户需求：图片要能粘贴 / 拖拽进去，而不是手写 Markdown 路径。
 * 字节由渲染进程读出来、主进程落盘——这条路必须守住三件事：
 *  1. 素材落在**文档同级**的 assets/（写错位置图片必然破图）；
 *  2. 文件名里的路径分隔符被剥掉（否则能借文件名写到内容根外面）；
 *  3. 重名不覆盖（同一张图 paste 两次不该弄丢前一张）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { importImage } = await import('../apps/desktop/src/main/image-import.ts')

/** 1×1 PNG（67 字节） */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'docvi-img-'))
  mkdirSync(join(root, 'docs'), { recursive: true })
  return root
}

test('图片落在文档同级的 assets/，返回文档相对路径', () => {
  const root = workspace()
  try {
    const result = importImage(root, {
      workspaceId: 'w',
      docRelPath: 'docs/a.md',
      name: '截图.png',
      data: PNG,
    })
    assert.equal(result.relPath, 'assets/截图.png')
    assert.ok(existsSync(join(root, 'docs/assets/截图.png')))
    assert.deepEqual(readFileSync(join(root, 'docs/assets/截图.png')), Buffer.from(PNG, 'base64'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('根目录文档：素材落在根级 assets/', () => {
  const root = workspace()
  try {
    const result = importImage(root, {
      workspaceId: 'w',
      docRelPath: 'index.md',
      name: 'a.png',
      data: PNG,
    })
    assert.equal(result.relPath, 'assets/a.png')
    assert.ok(existsSync(join(root, 'assets/a.png')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('重名不覆盖：自动加序号', () => {
  const root = workspace()
  try {
    const first = importImage(root, {
      workspaceId: 'w',
      docRelPath: 'index.md',
      name: 'a.png',
      data: PNG,
    })
    const second = importImage(root, {
      workspaceId: 'w',
      docRelPath: 'index.md',
      name: 'a.png',
      data: PNG,
    })
    assert.equal(first.relPath, 'assets/a.png')
    assert.equal(second.relPath, 'assets/a-2.png')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('文件名里的路径分隔符被剥掉（不能借文件名写到内容根外）', () => {
  const root = workspace()
  try {
    const result = importImage(root, {
      workspaceId: 'w',
      docRelPath: 'index.md',
      name: '../../evil.png',
      data: PNG,
    })
    assert.ok(!result.relPath.includes('..'), result.relPath)
    const escaped = join(root, '..', 'evil.png')
    assert.ok(!existsSync(escaped), '图片不该被写到内容根外面')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('非图片扩展名被拒绝', () => {
  const root = workspace()
  try {
    assert.throws(
      () => importImage(root, { workspaceId: 'w', docRelPath: 'a.md', name: 'x.exe', data: PNG }),
      /不支持的图片格式/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('空内容被拒绝', () => {
  const root = workspace()
  try {
    assert.throws(
      () => importImage(root, { workspaceId: 'w', docRelPath: 'a.md', name: 'x.png', data: '' }),
      /为空/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('data URL 前缀会被剥离', () => {
  const root = workspace()
  try {
    const result = importImage(root, {
      workspaceId: 'w',
      docRelPath: 'a.md',
      name: 'x.png',
      data: `data:image/png;base64,${PNG}`,
    })
    assert.equal(result.size, Buffer.from(PNG, 'base64').length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
