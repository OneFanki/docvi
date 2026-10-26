import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { checkLinks, collectMarkdownFiles, extractLinks } from './check-links.mjs'
import { createExcludeMatcher } from './scan-docs.mjs'

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'docvi-links-'))
}

function write(root, relative, content) {
  const file = join(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

test('extractLinks 跳过外链、锚点与围栏代码块', () => {
  const links = extractLinks(
    [
      '正文 [目标](目标.md) 与 [外链](https://example.com) 与 [锚点](#标题)',
      '```md',
      '[代码里的](不该算.md)',
      '```',
      '再次 [相对](子目录/文件.md#小节)',
    ].join('\n'),
  )
  assert.deepEqual(
    links.map(item => item.target),
    ['目标.md', '子目录/文件.md#小节'],
  )
})

test('checkLinks 区分存在、缺失与指向排除内容', () => {
  const root = makeRoot()
  try {
    write(
      root,
      'a.md',
      ['[存在](b.md)', '[缺失](c.md)', '[排除](技能/m/SKILL.md)', '[目录索引](子/)'].join('\n'),
    )
    write(root, 'b.md', '# b\n')
    write(root, '子/index.md', '# 子\n')
    write(root, '技能/m/SKILL.md', '# 技能\n')
    const isExcluded = createExcludeMatcher(['技能'])

    const files = collectMarkdownFiles(root, isExcluded)
    // 收集顺序按目录深度优先，与断言无关；这里统一排序后比较（默认排序不依赖中文 collation）
    assert.deepEqual([...files].sort(), ['a.md', 'b.md', '子/index.md'].sort())

    const { missing, excludedRefs } = checkLinks(root, ['a.md'], isExcluded)
    assert.deepEqual(
      missing.map(item => item.target),
      ['c.md'],
    )
    assert.deepEqual(
      excludedRefs.map(item => item.target),
      ['技能/m/SKILL.md'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectMarkdownFiles 跳过排除目录与 node_modules', () => {
  const root = makeRoot()
  try {
    write(root, '长期沉淀/索引.md', '# 索引\n')
    write(root, '技能/x/SKILL.md', '# 技能\n')
    write(root, 'node_modules/pkg/README.md', '# pkg\n')
    const files = collectMarkdownFiles(root, createExcludeMatcher(['技能']))
    assert.deepEqual(files, ['长期沉淀/索引.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
