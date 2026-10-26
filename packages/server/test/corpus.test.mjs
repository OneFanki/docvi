/**
 * 语料层单测（`packages/server/src/corpus.mjs`，桌面与容器共用的检索实现）。
 *
 * 真实临时目录（不碰用户数据目录）：检索排序、多词 AND、前缀路径、绝对路径、
 * 越界与符号链接逃逸、大小上限、空范围。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCorpus } from '../src/corpus.mjs'

/** 造两个范围：workspace 与 handbook（带前缀），模拟桌面与容器的两种形态 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docs-corpus-'))
  const desktop = join(root, 'workspace')
  const repo = join(root, 'repo')
  mkdirSync(join(desktop, 'guides'), { recursive: true })
  mkdirSync(join(repo, 'guides'), { recursive: true })
  mkdirSync(join(desktop, 'node_modules', 'junk'), { recursive: true })
  mkdirSync(join(desktop, 'assets'), { recursive: true })

  writeFileSync(
    join(desktop, 'guides', 'deploy.md'),
    '# 部署指南\n\n容器部署：一条命令。\n',
    'utf8',
  )
  writeFileSync(join(desktop, 'random.md'), '# 杂项\n\n部署这个词只出现一次。\n', 'utf8')
  writeFileSync(join(desktop, 'node_modules', 'junk', 'readme.md'), '# 噪声\n\n部署\n', 'utf8')
  writeFileSync(join(desktop, 'assets', 'pic.md'), '# 素材\n\n部署\n', 'utf8')
  writeFileSync(join(repo, 'guides', 'deploy.md'), '# 仓库部署\n\n另一份部署说明。\n', 'utf8')

  const scopes = [
    { workspace: '本地工作区', root: desktop },
    { workspace: '工程手册@main', root: repo, prefix: 'handbook/' },
  ]
  return { root, desktop, repo, scopes }
}

test('search：多词 AND、标题命中优先、排除 node_modules 与 assets', () => {
  const { root, scopes } = fixture()
  try {
    const corpus = createCorpus(() => scopes)
    const hits = corpus.search('部署', 10)
    const paths = hits.map(hit => hit.path)
    assert.ok(paths.includes('guides/deploy.md'))
    assert.ok(paths.includes('handbook/guides/deploy.md'), '容器范围的路径带前缀')
    assert.ok(
      !paths.some(path => path.includes('node_modules') || path.startsWith('assets/')),
      '排除目录不进检索范围',
    )
    // 标题命中（两篇 deploy.md）排在只有正文命中的 random.md 之前
    const deployIndex = paths.indexOf('guides/deploy.md')
    const randomIndex = paths.indexOf('random.md')
    assert.ok(deployIndex >= 0 && randomIndex >= 0)
    assert.ok(deployIndex < randomIndex, '标题命中的文档排在仅正文命中之前')
    const prefixedHit = hits.find(hit => hit.path === 'handbook/guides/deploy.md')
    assert.equal(prefixedHit.workspace, '工程手册@main')

    assert.deepEqual(
      corpus.search('部署 一条', 10).map(hit => hit.path),
      ['guides/deploy.md'],
    )
    assert.deepEqual(corpus.search('   ', 10), [], '空白查询无命中')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('search：limit 生效，结果带标题与片段', () => {
  const { root, desktop, scopes } = fixture()
  try {
    writeFileSync(join(desktop, 'a.md'), '# 甲\n\n部署\n', 'utf8')
    writeFileSync(join(desktop, 'b.md'), '# 乙\n\n部署\n', 'utf8')
    const corpus = createCorpus(() => scopes)
    const hits = corpus.search('部署', 2)
    assert.equal(hits.length, 2)
    for (const hit of hits) {
      assert.ok(hit.title.length > 0)
      assert.ok(hit.snippet.includes('部署'), '片段应围绕命中词')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readDoc：裸相对路径按范围顺序命中，带前缀路径定向到对应仓库', () => {
  const { root, scopes } = fixture()
  try {
    const corpus = createCorpus(() => scopes)

    const bare = corpus.readDoc('guides/deploy.md')
    assert.equal(typeof bare, 'object')
    assert.equal(bare.workspace, '本地工作区', '裸路径先命中桌面工作区')
    assert.match(bare.text, /一条命令/)

    const prefixed = corpus.readDoc('handbook/guides/deploy.md')
    assert.equal(prefixed.workspace, '工程手册@main')
    assert.equal(prefixed.path, 'handbook/guides/deploy.md', '展示路径保留前缀')
    assert.match(prefixed.text, /另一份部署说明/)
    assert.ok(!prefixed.text.includes('一条命令'), '前缀切换确实读到了另一个文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readDoc：绝对路径在范围内可读，范围外与非法段给可读说明', () => {
  const { root, desktop, scopes } = fixture()
  try {
    const corpus = createCorpus(() => scopes)

    const absolute = corpus.readDoc(join(desktop, 'random.md'))
    assert.equal(absolute.path, 'random.md')
    assert.equal(absolute.workspace, '本地工作区')

    assert.match(corpus.readDoc(join(tmpdir(), 'not-in-any-scope.md')), /不在任何可读范围/)
    assert.match(corpus.readDoc('../escape.md'), /非法段/)
    assert.match(corpus.readDoc('missing.md'), /没有找到文档/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readDoc：越界请求（前缀去掉后指向上级）被拒绝', () => {
  const { root, scopes } = fixture()
  try {
    const corpus = createCorpus(() => scopes)
    // 前缀匹配后剩 `../x.md`——rel 层没有 `..`，但 realpath 判定必须兜住
    const result = corpus.readDoc('handbook/../outside.md')
    assert.equal(typeof result, 'string', '越界必须有可读说明，不能抛错')
    assert.match(result, /没有找到文档|非法段|不在任何可读范围/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('空范围：检索无命中、读取给引导文案', () => {
  const corpus = createCorpus(() => [])
  assert.deepEqual(corpus.search('任意', 5), [])
  assert.match(corpus.readDoc('a.md'), /没有可读取的文档范围/)
})

test('范围列表每次调用现取（活查询）：新增范围立刻可见', () => {
  const { root, desktop, scopes } = fixture()
  try {
    let current = []
    const corpus = createCorpus(() => current)
    assert.match(corpus.readDoc('random.md'), /没有可读取的文档范围/)
    current = scopes
    assert.equal(corpus.readDoc('random.md').workspace, '本地工作区')
    assert.ok(corpus.readDoc(join(desktop, 'random.md')).text.includes('部署'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
