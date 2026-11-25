/**
 * 分享共享根的软链接逃逸回归（2026-11-24 审查发现并修复）。
 *
 * 缺陷：`insideRoot` 只做字符串前缀比对。共享根内放一个符号链接指向根外，
 * 前缀判定看到的是「根内路径」，于是根外文件被登记成分享目标——读者拿到
 * 链接就能读到它。修复后判定基于 realpath，软链接会在解析后暴露真实位置。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { createSharesService } = await import('../src/shares.mjs')

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'docvi-share-root-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('共享根内的正常文件可以分享', () =>
  withTree(root => {
    const shareRoot = join(root, 'shared')
    const dataDir = join(root, 'data')
    mkdirSync(shareRoot, { recursive: true })
    const doc = join(shareRoot, 'a.md')
    writeFileSync(doc, '# A\n', 'utf8')

    const service = createSharesService({ dataDir, shareRoots: [shareRoot] })
    const entry = service.create({ path: doc })
    assert.equal(entry.kind, 'file')
    assert.equal(entry.path, doc)
  }))

test('根外路径被拒绝', () =>
  withTree(root => {
    const shareRoot = join(root, 'shared')
    const dataDir = join(root, 'data')
    mkdirSync(shareRoot, { recursive: true })
    const outside = join(root, 'secret.md')
    writeFileSync(outside, 'SECRET\n', 'utf8')

    const service = createSharesService({ dataDir, shareRoots: [shareRoot] })
    assert.throws(() => service.create({ path: outside }), /必须在共享根内/, '根外文件不能被登记')
  }))

test('共享根内的软链接指向根外文件时必须拒绝', () =>
  withTree(root => {
    const shareRoot = join(root, 'shared')
    const dataDir = join(root, 'data')
    mkdirSync(shareRoot, { recursive: true })
    const secret = join(root, 'secret.md')
    writeFileSync(secret, 'SECRET\n', 'utf8')

    const link = join(shareRoot, 'leak.md')
    symlinkSync(secret, link)

    const service = createSharesService({ dataDir, shareRoots: [shareRoot] })
    assert.throws(
      () => service.create({ path: link }),
      /必须在共享根内/,
      '软链接必须经 realpath 暴露真实位置后才能判根',
    )
  }))

test('共享根本身是软链接时，其真实内容仍可分享', () =>
  withTree(root => {
    const realDir = join(root, 'real-shared')
    const linkRoot = join(root, 'linked-shared')
    const dataDir = join(root, 'data')
    mkdirSync(realDir, { recursive: true })
    symlinkSync(realDir, linkRoot)

    const doc = join(realDir, 'b.md')
    writeFileSync(doc, '# B\n', 'utf8')

    // 共享根声明成软链接路径：目标真实路径仍在根的真实路径内，应当放行
    const service = createSharesService({ dataDir, shareRoots: [linkRoot] })
    const entry = service.create({ path: join(linkRoot, 'b.md') })
    assert.equal(entry.kind, 'file')
  }))
