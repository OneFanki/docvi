/**
 * 搜索语料的规模降级契约。
 *
 * 不变量：
 *  - 小仓库读全文，`fullText: true`；
 *  - 超过 `MAX_FULLTEXT_DOCS` 的仓库**一篇正文都不读**，只回路径，`fullText: false`；
 *  - 两种情况下返回的 path 集合一致（否则小仓能搜到、大仓连文件名都搜不到）；
 *  - 排除目录（node_modules / .git / dist / assets …）在两边同样生效。
 *
 * 为什么要钉这一组：降级规则错了两头都会疼——阈值判断偏了会把大仓重新拖进
 * 18MB 读盘 + 10 秒建索引（就是这轮要修的 CPU 问题）；而路径集合漂移会让
 * 「按文件名还能搜到」这个承诺悄悄失效，没有任何报错。
 *
 * 一律在临时目录里造数据：AGENTS 禁止测试触碰真实用户数据目录。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'

import { MAX_FULLTEXT_DOCS, collectSearchCorpus } from '../../apps/desktop/src/main/content.ts'

/** 在临时根下写 count 篇文档，返回 { root, cleanup } */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docvi-corpus-'))
  return {
    root,
    add(relPath, text) {
      const abs = join(root, relPath.split('/').join(sep))
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, text, 'utf8')
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('小仓库读全文', () => {
  const f = fixture()
  try {
    f.add('a.md', '正文一')
    f.add('docs/b.md', '正文二')
    const corpus = collectSearchCorpus(f.root)
    assert.equal(corpus.fullText, true)
    const byPath = new Map(corpus.docs.map(doc => [doc.path, doc.text]))
    assert.equal(byPath.get('a.md'), '正文一')
    assert.equal(byPath.get('docs/b.md'), '正文二')
  } finally {
    f.cleanup()
  }
})

test('刚好等于上限仍是全文（边界取「超过才降级」）', () => {
  const f = fixture()
  try {
    for (let index = 0; index < MAX_FULLTEXT_DOCS; index += 1) f.add(`d${index}.md`, 'x')
    const corpus = collectSearchCorpus(f.root)
    assert.equal(corpus.fullText, true, '等于上限不该降级')
    assert.equal(corpus.docs.length, MAX_FULLTEXT_DOCS)
  } finally {
    f.cleanup()
  }
})

test('超过上限只回路径：正文不入语料，fullText 为 false', () => {
  const f = fixture()
  try {
    for (let index = 0; index < MAX_FULLTEXT_DOCS + 1; index += 1) {
      f.add(`d${index}.md`, `正文 ${index}`)
    }
    const corpus = collectSearchCorpus(f.root)
    assert.equal(corpus.fullText, false)
    assert.equal(corpus.docs.length, MAX_FULLTEXT_DOCS + 1, '文件名一条都不能少')
    for (const doc of corpus.docs) {
      assert.equal(doc.text, '', `${doc.path} 不该带正文（大仓降级的意义就是不读盘）`)
    }
  } finally {
    f.cleanup()
  }
})

test('降级与否不改变 path 集合：排除目录两边同样生效', () => {
  const f = fixture()
  try {
    // 小仓
    f.add('keep.md', 'x')
    f.add('node_modules/dep/README.md', 'x')
    f.add('.git/x.md', 'x')
    f.add('dist/build.md', 'x')
    f.add('assets/pic.md', 'x')
    const small = collectSearchCorpus(f.root)
    const smallPaths = small.docs.map(doc => doc.path).sort()
    assert.deepEqual(smallPaths, ['keep.md'], '排除目录不能进语料')

    // 把同一棵树撑成「大仓」：只加合法文档，排除目录的命中不能参与计数
    for (let index = 0; index < MAX_FULLTEXT_DOCS; index += 1) {
      f.add(`bulk/d${index}.md`, 'x')
    }
    const large = collectSearchCorpus(f.root)
    assert.equal(large.fullText, false)
    const largePaths = new Set(large.docs.map(doc => doc.path))
    assert.ok(largePaths.has('keep.md'), '小仓能搜到的文件，大仓按文件名也必须能搜到')
    assert.ok(!largePaths.has('node_modules/dep/README.md'))
    assert.ok(!largePaths.has('dist/build.md'))
    assert.ok(!largePaths.has('assets/pic.md'))
  } finally {
    f.cleanup()
  }
})

test('单篇超长在全文模式下按上限截断', () => {
  const f = fixture()
  try {
    const huge = 'a'.repeat(600 * 1024)
    f.add('huge.md', huge)
    const corpus = collectSearchCorpus(f.root)
    assert.equal(corpus.fullText, true)
    const doc = corpus.docs.find(item => item.path === 'huge.md')
    assert.ok(doc)
    assert.ok(doc.text.length < huge.length, '超长正文必须截断')
    assert.ok(doc.text.length <= 512 * 1024)
  } finally {
    f.cleanup()
  }
})
