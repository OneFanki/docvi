/**
 * 自定义协议路径逃逸的回归测试（2026-11-24 审查发现）。
 *
 * 三个协议（asset / local / plugin）都把「登记的根 + URL 里的相对路径」解析成
 * 可伺服的绝对文件。曾经的缺陷：asset 只做字符串前缀判定，而 local 做了
 * realpath 二次判定——同一个软链接逃逸手法在两个入口下表现不同：
 *
 *   工作区里放一个 `leak.png` → 符号链接指向 `~/.ssh/id_rsa`，
 *   正文 `![](leak.png)` 就能把根外文件读进渲染进程。
 *
 * 现在三处统一走同一套判定，这里钉住「软链接不得逃出根」这条不变量。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { resolvePluginAsset } = await import('../../apps/desktop/src/main/plugin-store.ts')

function withTempTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'docvi-escape-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('插件资产：正常文件可解析，且返回真实路径', () =>
  withTempTree(root => {
    const pkg = join(root, 'plugin')
    mkdirSync(join(pkg, 'dist'), { recursive: true })
    writeFileSync(join(pkg, 'dist', 'index.js'), 'export {}\n', 'utf8')

    const resolved = resolvePluginAsset(pkg, 'dist/index.js')
    assert.ok(resolved, '包内正常文件应当可以解析')
    assert.ok(resolved.endsWith(join('dist', 'index.js')))
  }))

test('插件资产：`..` 不能逃出包目录', () =>
  withTempTree(root => {
    const pkg = join(root, 'plugin')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(root, 'secret.txt'), 'TOPSECRET', 'utf8')

    assert.equal(resolvePluginAsset(pkg, '../secret.txt'), null, '`..` 必须被拦住')
    assert.equal(resolvePluginAsset(pkg, 'a/../../secret.txt'), null, '多层 `..` 同样拦住')
  }))

test('插件资产：包内软链接指向包外时拒绝（字符串前缀判定拦不住这个）', () =>
  withTempTree(root => {
    const pkg = join(root, 'plugin')
    mkdirSync(pkg, { recursive: true })
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'TOPSECRET', 'utf8')

    const link = join(pkg, 'leak.txt')
    symlinkSync(secret, link)

    assert.equal(
      resolvePluginAsset(pkg, 'leak.txt'),
      null,
      '包内软链接指向包外必须被 realpath 判定拦住',
    )
  }))

test('插件资产：目录不伺服（只返回普通文件）', () =>
  withTempTree(root => {
    const pkg = join(root, 'plugin')
    mkdirSync(join(pkg, 'dist'), { recursive: true })

    assert.equal(resolvePluginAsset(pkg, 'dist'), null, '目录不是可伺服的资产')
    assert.equal(resolvePluginAsset(pkg, ''), null, '空路径直接拒绝')
  }))

test('插件资产：不存在的文件返回 null（不泄露存在性）', () =>
  withTempTree(root => {
    const pkg = join(root, 'plugin')
    mkdirSync(pkg, { recursive: true })
    assert.equal(resolvePluginAsset(pkg, 'missing.js'), null)
  }))
