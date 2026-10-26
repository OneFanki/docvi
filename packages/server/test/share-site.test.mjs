import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { buildTreePayload, naturalCompare, titleFromText } from '../src/share-site.mjs'

const dirs = []
function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `ds-site-${tag}-`))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function writeFile(root, rel, text) {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

test('自然序：数字段按数值比较', () => {
  const names = ['10-乙', '2-甲', '1-丙']
  assert.deepEqual([...names].sort(naturalCompare), ['1-丙', '2-甲', '10-乙'])
})

test('标题提取三条路径：frontmatter / H1 / 无', () => {
  assert.equal(titleFromText('---\ntitle: 配置说明\n---\n# 其它\n'), '配置说明')
  assert.equal(titleFromText('---\nother: 1\n---\n# 一级标题\n'), '一级标题')
  assert.equal(titleFromText('只有正文\n'), null)
})

test('扫描：目录树形状、落地页挂节点、排除项与深度限制', () => {
  const root = tempDir('scan')
  writeFile(root, 'index.md', '# 首页')
  writeFile(root, '01-指南/index.md', '# 指南')
  writeFile(root, '01-指南/第一篇.md', '# 第一篇')
  writeFile(root, '02-笔记/散记.md', '# 散记')
  writeFile(root, 'node_modules/ignored.md', '# 不该出现')
  writeFile(root, '.hidden/secret.md', '# 不该出现')
  writeFile(root, 'README.md', '# 根说明')

  const payload = buildTreePayload(root)
  assert.equal(payload.configSource, 'autoscan')
  const texts = JSON.stringify(payload)
  assert.ok(!texts.includes('不该出现'), '排除目录不应进入树')

  // 顶层：01-指南（有落地页 → 可点）在前，02-笔记 在后，README 作为散装文件
  assert.equal(payload.roots[0].link, '/01-指南/index', '目录落地页链接指向 index')
  assert.equal(payload.roots[0].collapsed, false, '顶层目录默认展开')
  assert.ok(
    payload.roots.some(node => node.link === '/README'),
    '顶层散装 Markdown 单独成节点',
  )
  // 顶层顺序：目录（自然序）在前，散装 Markdown 在后；根目录的 index.md 也是普通节点。
  // 无落地页的目录（02-笔记）是纯分组：没有 link，只有 items。
  assert.deepEqual(
    payload.roots.map(node => node.link),
    ['/01-指南/index', undefined, '/index', '/README'],
  )
  assert.equal(payload.roots[1].items[0].link, '/02-笔记/散记')
  const guide = payload.roots[0]
  assert.equal(guide.items.length, 1, '落地页不重复出现在子项里')
  assert.equal(guide.items[0].link, '/01-指南/第一篇')
})

test('扫描：空目录不产生节点（无落地页且无内容）', () => {
  const root = tempDir('empty')
  mkdirSync(join(root, '空目录'))
  const payload = buildTreePayload(root)
  assert.equal(payload.roots.length, 0)
})

test('扫描：版本指纹随文件数变化', () => {
  const root = tempDir('version')
  writeFile(root, 'a.md', '# a')
  const first = buildTreePayload(root).version
  writeFile(root, 'b.md', '# b')
  const second = buildTreePayload(root).version
  assert.notEqual(first, second)
})

test('扫描：目录不存在时抛出可读错误', () => {
  assert.throws(() => buildTreePayload(join(tempDir('missing'), 'nope')), /读取目录失败/)
})
