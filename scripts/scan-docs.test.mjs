import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { buildDocsSidebar, createExcludeMatcher } from './scan-docs.mjs'

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'docvi-scan-'))
}

function write(root, relative, content = '# 标题\n') {
  const file = join(root, relative)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

test('buildDocsSidebar 按声明顺序生成嵌套目录树，并标注节点类型', () => {
  const root = makeRoot()
  try {
    write(root, '长期沉淀/索引.md', '# 长期沉淀 · 索引\n')
    write(root, '长期沉淀/规划与决策/多机环境映射.md', '# 多机环境映射\n')
    write(root, '长期沉淀/规划与决策/软件收藏.md', '# 软件收藏\n')
    write(root, '过程记录/2026-09-01-记录.md', '# 一条记录\n')
    write(root, '技能/某技能/SKILL.md', '# 技能\n')

    const sidebar = buildDocsSidebar(root, {
      sidebar: [
        { text: '长期沉淀', path: '长期沉淀', order: 10 },
        { text: '过程记录', path: '过程记录', order: 20 },
      ],
      exclude: ['技能'],
    })

    assert.equal(sidebar.length, 2)
    const [longterm, process] = sidebar

    // 工具：从节点文本里取出图标类型与标题（文本形如 <marker><span title>标题</span>）
    const kindOf = item => item.text.match(/data-kind="(\w+)"/)?.[1]
    const labelOf = item => item.text.replace(/<[^>]+>/g, '')

    // 有落地页（索引.md）的目录 → doc 图标 + 可点击，顶层默认展开
    assert.equal(kindOf(longterm), 'doc')
    assert.equal(labelOf(longterm), '长期沉淀')
    assert.equal(longterm.link, '/长期沉淀/索引')
    assert.equal(longterm.collapsed, false)
    assert.equal(kindOf(longterm.items[0]), 'group')
    assert.equal(labelOf(longterm.items[0]), '规划与决策')
    assert.equal(longterm.items[0].link, undefined)
    assert.equal(longterm.items[0].collapsed, true)
    assert.deepEqual(
      longterm.items[0].items.map(item => [kindOf(item), labelOf(item), item.link]),
      [
        ['leaf', '多机环境映射', '/长期沉淀/规划与决策/多机环境映射'],
        ['leaf', '软件收藏', '/长期沉淀/规划与决策/软件收藏'],
      ],
    )

    // 标题单行省略所需的结构：外层 .at-tree-title 带 title 提示
    assert.ok(longterm.text.includes('class="at-tree-title" title="长期沉淀"'))

    // 无落地页的顶层目录 → group 图标 + 不可点击
    assert.equal(kindOf(process), 'group')
    assert.equal(labelOf(process), '过程记录')
    assert.equal(process.link, undefined)

    // 排除目录不出现
    assert.ok(!JSON.stringify(sidebar).includes('技能'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildDocsSidebar 支持 frontmatter order 自定义排序', () => {
  const root = makeRoot()
  try {
    write(root, '指南/z-last.md', '---\norder: 1\n---\n\n# 排在前面\n')
    write(root, '指南/a-first.md', '---\norder: 2\n---\n\n# 排在后面\n')

    const sidebar = buildDocsSidebar(root, { sidebar: [{ text: '指南', path: '指南' }] })
    const titles = sidebar[0].items.map(item => item.text.replace(/<[^>]+>/g, ''))
    assert.deepEqual(titles, ['排在前面', '排在后面'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildDocsSidebar 未声明 sidebar 时自动扫描顶层', () => {
  const root = makeRoot()
  try {
    write(root, 'index.md', '# 首页\n')
    write(root, '指南/01-开始.md', '# 开始\n')
    write(root, 'README.md', '# 说明\n')

    const sidebar = buildDocsSidebar(root, { exclude: ['README.md'] })
    const texts = sidebar.map(item => item.text.replace(/<[^>]+>/g, ''))
    assert.ok(texts.includes('指南'))
    assert.ok(texts.includes('首页'))
    assert.ok(!texts.includes('说明'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('createExcludeMatcher 支持目录前缀与文件精确匹配', () => {
  const isExcluded = createExcludeMatcher(['技能', 'README.md'])
  assert.equal(isExcluded('技能'), true)
  assert.equal(isExcluded('技能/memory/m-env/SKILL.md'), true)
  assert.equal(isExcluded('README.md'), true)
  assert.equal(isExcluded('长期沉淀/README.md'), false)
  assert.equal(isExcluded('过程记录/2026-09-01-记录.md'), false)
})

test('容器目录合并：课程目录的 chapters/ 不再多占一级', () => {
  const root = makeRoot()
  try {
    write(root, '课程/index.md', '# 课程主页\n')
    write(root, '课程/chapters/01-入门.md', '# 01 · 入门\n')
    write(root, '课程/chapters/02-进阶.md', '# 02 · 进阶\n')

    const sidebar = buildDocsSidebar(root, { sidebar: [{ text: '课程', path: '课程' }] })
    const course = sidebar[0]
    assert.equal(course.link, '/课程/index')
    // chapters/ 被合并：直接就是章节，层级不再多一层
    assert.deepEqual(
      course.items.map(item => item.text.replace(/<[^>]+>/g, '')),
      ['01 · 入门', '02 · 进阶'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('非容器名的唯一子目录不合并（保留真分组）', () => {
  const root = makeRoot()
  try {
    write(root, '长期沉淀/索引.md', '# 长期沉淀索引\n')
    write(root, '长期沉淀/规划与决策/某文档.md', '# 某文档\n')

    const sidebar = buildDocsSidebar(root, { sidebar: [{ text: '长期沉淀', path: '长期沉淀' }] })
    // 唯一子目录叫「规划与决策」而非容器名 → 保留这一级分组
    assert.equal(sidebar[0].items.length, 1)
    assert.equal(sidebar[0].items[0].text.replace(/<[^>]+>/g, ''), '规划与决策')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('子目录自带落地页时不合并（保留为真章节）', () => {
  const root = makeRoot()
  try {
    write(root, '课程/index.md', '# 课程主页\n')
    write(root, '课程/进阶/index.md', '# 进阶篇\n')
    write(root, '课程/进阶/01-细节.md', '# 细节\n')

    const sidebar = buildDocsSidebar(root, { sidebar: [{ text: '课程', path: '课程' }] })
    const course = sidebar[0]
    assert.equal(course.items.length, 1)
    assert.equal(course.items[0].link, '/课程/进阶/index')
    assert.equal(course.items[0].items.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('素材目录（snippets/assets）不进树', () => {
  const root = makeRoot()
  try {
    write(root, '课程/index.md', '# 课程主页\n')
    write(root, '课程/chapters/01-入门.md', '# 01 · 入门\n')
    write(root, '课程/snippets/note.md', '# 片段笔记\n')
    write(root, '课程/assets/README.md', '# 资源说明\n')

    const sidebar = buildDocsSidebar(root, { sidebar: [{ text: '课程', path: '课程' }] })
    const names = JSON.stringify(sidebar)
    assert.ok(!names.includes('片段笔记'), 'snippets 不应进树')
    assert.ok(!names.includes('资源说明'), 'assets 不应进树')
    assert.deepEqual(
      sidebar[0].items.map(item => item.text.replace(/<[^>]+>/g, '')),
      ['01 · 入门'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
