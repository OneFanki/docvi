/**
 * docs-core 的「内存 IO」路径测试（本地宿主共用同一实现的关键保证）：
 * 用纯内存的 dirs/files 映射驱动 buildDocsIndex，覆盖：
 * - 无 docs.config.yaml 时的 autoscan（configSource: 'autoscan'、自动扫描树、标题取目录名）；
 * - 有配置时的 yaml 路径（sidebar 声明 + title）；
 * - 版本指纹随内容变化；
 * - 与 node fs 实现同构（同一内容 → 同一 tree 结构）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDocsIndex,
  buildDocsTree,
  buildSearchIndex,
  contentFingerprint,
  joinPosix,
} from './lib/docs-core.mjs'

/** 内存 IO：模拟 docvi 的目录快照（浏览器侧 fs-snapshot 走同一契约） */
function memoryIO(files) {
  const dirs = new Set([''])
  const fileSet = new Set()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'))
    }
    fileSet.add(path)
  }
  const dirMap = new Map()
  for (const dir of dirs) {
    const prefix = dir ? `${dir}/` : ''
    const children = new Map()
    for (const path of [...dirs, ...fileSet]) {
      if (!path.startsWith(prefix) || path === dir) continue
      const rest = path.slice(prefix.length)
      if (!rest || rest.includes('/')) continue
      children.set(rest, {
        name: rest,
        isDirectory: () => dirs.has(joinPosix(dir, rest)),
        isFile: () => fileSet.has(joinPosix(dir, rest)),
        isSymbolicLink: () => false,
      })
    }
    dirMap.set(dir, [...children.values()])
  }
  return {
    exists: path => dirs.has(path) || fileSet.has(path),
    readdir: path => dirMap.get(path) ?? [],
    readText: path => {
      const text = files[path]
      if (text === undefined) throw new Error(`不存在: ${path}`)
      return text
    },
    statKind: () => null,
  }
}

test('autoscan：无配置目录生成自动扫描树 + configSource 标记', async () => {
  const io = memoryIO({
    '长期沉淀/索引.md': '# 长期沉淀索引\n\n一些内容。',
    '长期沉淀/规划/多机环境.md': '# 多机环境\n\n正文。',
    '过程记录/2026-09-01-记录.md': '# 一条记录\n',
  })
  const built = await buildDocsIndex('', io, { autoscan: true })

  assert.equal(built.tree.configSource, 'autoscan')
  assert.equal(built.tree.title, '文档') // 根路径 basename 为空 → 回退「文档」
  const texts = built.tree.roots.map(node => node.docFooterText)
  assert.deepEqual(texts, ['过程记录', '长期沉淀']) // 自然排序
  assert.equal(built.tree.roots[1].link, '/长期沉淀/索引') // 有落地页 → 可选中
  assert.equal(built.tree.roots[0].link, undefined) // 无落地页 → 纯分组
  assert.equal(built.searchIndex.docs.length, 3)
  assert.equal(built.searchIndex.version, built.tree.version)
})

test('有配置：sidebar 声明生效、configSource 为 yaml', async () => {
  const io = memoryIO({
    'docs.config.yaml': 'title: 我的站\nsidebar:\n  - text: 沉淀\n    path: 长期沉淀\n',
    '长期沉淀/索引.md': '# 长期沉淀索引\n',
    '不在树里/随手记.md': '# 随手记\n',
  })
  const built = await buildDocsIndex('', io)
  assert.equal(built.tree.configSource, 'yaml')
  assert.equal(built.tree.title, '我的站')
  assert.equal(built.tree.roots.length, 1)
  assert.equal(built.tree.roots[0].docFooterText, '沉淀')
})

test('sidebar 声明 path 为 "."（最小模板写法）：归一为内容根本身，本地快照宿主不空树', async () => {
  const io = memoryIO({
    'docs.config.yaml': 'title: 单根站\nsidebar:\n  - text: 文档\n    path: .\n',
    '散装笔记.md': '# 随手记\n',
    '目录/内容.md': '# 内容\n',
  })
  const { tree } = buildDocsTree('', io)
  assert.equal(tree.roots.length, 1)
  assert.equal(tree.roots[0].docFooterText, '文档')
  assert.ok(tree.roots[0].items.length >= 2, `根下条目应 >= 2，实际 ${tree.roots[0].items?.length}`)
})

test('版本指纹：内容改变 → 版本改变；node 与内存实现口径一致', async () => {
  const filesA = { 'a.md': '# A\n\n内容一。' }
  const filesB = { 'a.md': '# A\n\n内容二。' }
  const versionA = contentFingerprint('', memoryIO(filesA))
  const versionB = contentFingerprint('', memoryIO(filesB))
  assert.notEqual(versionA, versionB)
  // 同一内容重复计算稳定
  assert.equal(versionA, contentFingerprint('', memoryIO({ ...filesA })))
  assert.equal(versionA.length, 12)
})

test('exclude 声明的路径不进搜索索引；autoscan 无配置时全部 md 都进', async () => {
  const files = {
    '可见/页.md': '# 可见页\n',
    '技能/SKILL.md': '# 技能内容\n',
  }
  // autoscan（无配置）：无排除规则，全部 md 进索引——壳的明示提示条提示用户补配置
  const auto = await buildDocsIndex('', memoryIO(files), { autoscan: true })
  assert.equal(auto.searchIndex.docs.length, 2)

  // 有配置且声明 exclude：技能目录不进树也不进搜索
  const configured = await buildDocsIndex(
    '',
    memoryIO({
      'docs.config.yaml': 'title: 站点\nexclude:\n  - 技能/\n',
      ...files,
    }),
  )
  assert.equal(configured.searchIndex.docs.length, 1)
  assert.ok(!configured.searchIndex.docs.some(doc => doc.path.includes('技能')))
})

test('拆分构建：buildDocsTree + buildSearchIndex 与整包口径一致（版本/文档数/标题回退）', async () => {
  const io = memoryIO({
    '指南/入门.md': '# 入门指南\n\n学会使用工具。',
    '指南/进阶.md': '---\ntitle: 进阶标题\n---\n\n更高级的内容。',
    '无标题.md': '没有标题的正文。',
  })
  const { version, tree, docs } = buildDocsTree('', io, { autoscan: true })
  assert.equal(tree.version, version)
  assert.equal(docs.length, 3)
  assert.ok(docs.every(doc => typeof doc.raw === 'string'))

  const searchIndex = await buildSearchIndex(version, docs)
  assert.equal(searchIndex.version, version)
  assert.equal(searchIndex.docs.length, 3)
  const titles = Object.fromEntries(searchIndex.docs.map(doc => [doc.path, doc.title]))
  assert.equal(titles['/指南/入门'], '入门指南') // H1
  assert.equal(titles['/指南/进阶'], '进阶标题') // frontmatter title 优先
  assert.equal(titles['/无标题'], '无标题') // 回退文件名
})

test('buildSearchIndex 分片构建与一次建完等价（含让出主线程点计数）', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `目录/文档${index}.md`,
      `# 标题${index}\n\n第 ${index} 篇的内容。`,
    ]),
  )
  const { version, docs } = buildDocsTree('', memoryIO(files), { autoscan: true })
  let yields = 0
  const full = await buildSearchIndex(version, docs)
  const chunked = await buildSearchIndex(version, docs, {
    chunkSize: 3,
    yield: async () => {
      yields += 1
    },
  })
  assert.equal(JSON.stringify(chunked.index), JSON.stringify(full.index))
  assert.deepEqual(chunked.docs, full.docs)
  assert.equal(yields, 4) // 入口一拍 + 10 篇每批 3 的 3 个批间
})
