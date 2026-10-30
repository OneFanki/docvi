/**
 * 目录树选区/拖拽纯逻辑 + 扫描器空目录口径的回归测试。
 *
 * 钉住两类「组件里看不出对错、只在路径算术里」的契约：
 *  1. 树的批量选区与拖拽过滤（lib/tree-selection.ts）——Shift 范围、
 *     「拖回原地/拖进自己」剔除、同批祖先项吸收、「展开所选」要铺开的目录；
 *  2. scanTree 保留空目录——2026-10-28 用户实测：新建文件夹落盘成功、
 *     树也重扫了，但空目录被扫描器剔除，界面毫无变化，看起来像创建失败。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const {
  ancestorDirs,
  baseNameOf,
  collectExpandPaths,
  filterMoveTargets,
  parentDirOf,
  rangeSelection,
} = await import('../apps/desktop/src/renderer/src/lib/tree-selection.ts')
const { scanTree } = await import('../apps/desktop/src/main/content.ts')

/* ---------- 路径算术 ---------- */

test('parentDirOf / baseNameOf / ancestorDirs：顶层与嵌套', () => {
  assert.equal(parentDirOf('a/b/c.md'), 'a/b')
  assert.equal(parentDirOf('top.md'), '')
  assert.equal(baseNameOf('a/b/c.md'), 'c.md')
  assert.equal(baseNameOf('top.md'), 'top.md')
  assert.deepEqual(ancestorDirs('a/b/c.md'), ['', 'a', 'a/b'])
  // 顶层路径：祖先链只有根
  assert.deepEqual(ancestorDirs('top.md'), [''])
})

/* ---------- Shift 范围选择 ---------- */

test('rangeSelection：正向、反向、越界锚点退化', () => {
  const visible = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(rangeSelection(visible, 'a', 'c'), ['a', 'b', 'c'])
  // 反向拖（从下往上选）也要含两端
  assert.deepEqual(rangeSelection(visible, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeSelection(visible, 'c', 'c'), ['c'])
  // 锚点不在可见序列（树刷新后失效 / 从未点过）：退化为只选当前行
  assert.deepEqual(rangeSelection(visible, 'gone', 'c'), ['c'])
  assert.deepEqual(rangeSelection(visible, null, 'c'), ['c'])
})

/* ---------- 拖拽落点过滤 ---------- */

test('filterMoveTargets：拖回原地与拖进自己是无操作', () => {
  // 拖回当前所在目录
  assert.deepEqual(filterMoveTargets(['a/b.md'], 'a'), { move: [], skipped: 1 })
  // 目录拖到它自己身上（落点=目录行本身）
  assert.deepEqual(filterMoveTargets(['a'], 'a'), { move: [], skipped: 1 })
})

test('filterMoveTargets：目录拖进自己的子孙被剔除', () => {
  // 主进程 moveEntry 会拒绝，但多项拖拽不该让一项毒化整批——干脆不发出去
  assert.deepEqual(filterMoveTargets(['a', 'b'], 'a/x'), { move: ['b'], skipped: 1 })
})

test('filterMoveTargets：被同批祖先包含的项随父目录一起走', () => {
  // 选了 a/ 和 a/b/c.md：只移 a/，c.md 按 a/b/c.md 再移一次必然 ENOENT
  const { move, skipped } = filterMoveTargets(['a', 'a/b/c.md', 'other.md'], 'z')
  assert.deepEqual(move, ['a', 'other.md'])
  assert.equal(skipped, 0)
})

test('filterMoveTargets：正常移动原样通过', () => {
  assert.deepEqual(filterMoveTargets(['a/one.md', 'b/two.md'], 'c'), {
    move: ['a/one.md', 'b/two.md'],
    skipped: 0,
  })
})

/* ---------- 展开所选 ---------- */

function node(path, type, children) {
  return {
    path,
    name: path.split('/').pop(),
    type,
    ...(children ? { children } : { children: [] }),
  }
}

test('collectExpandPaths：祖先链 + 选中目录的整棵子树', () => {
  const tree = [
    node('docs', 'dir', [
      node('docs/guide', 'dir', [node('docs/guide/intro', 'doc')]),
      node('docs/api', 'dir', []),
    ]),
    node('rules', 'dir', []),
  ]
  const result = collectExpandPaths(tree, ['docs/guide'])
  // 祖先链（docs）+ 自身 + 子树里所有目录；文档不算目录
  assert.deepEqual(result.sort(), ['docs', 'docs/guide'])
})

test('collectExpandPaths：文档节点只展开祖先，落地页路径靠祖先链覆盖', () => {
  const tree = [
    node('docs', 'dir', [
      // 落地页 index 在渲染树里被目录行代表，不作为子节点出现
      node('docs/guide', 'dir', []),
    ]),
  ]
  // landing 是文档路径，节点表里查不到 → 祖先链仍要铺开
  assert.deepEqual(collectExpandPaths(tree, ['docs/guide/index']), ['docs', 'docs/guide'])
})

test('collectExpandPaths：多项选择合并去重', () => {
  const tree = [node('a', 'dir', [node('a/x', 'dir', [])]), node('b', 'dir', [])]
  const result = collectExpandPaths(tree, ['a', 'b'])
  assert.deepEqual(result.sort(), ['a', 'a/x', 'b'])
})

/* ---------- scanTree 空目录口径 ---------- */

test('scanTree：空目录保留为 children:[]，点开头目录与非 md 文件仍排除', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-tree-empty-'))
  try {
    mkdirSync(join(root, 'fresh-empty-dir'))
    mkdirSync(join(root, 'has-doc'))
    writeFileSync(join(root, 'has-doc', 'note.md'), '# 笔记\n')
    mkdirSync(join(root, '.hidden-dir'))
    writeFileSync(join(root, 'scratch.txt'), 'not markdown')

    const tree = scanTree(root)
    const names = tree.map(item => item.name)
    assert.ok(names.includes('fresh-empty-dir'), '新建的空目录必须出现在树里')
    assert.ok(!names.includes('.hidden-dir'), '点开头目录仍然排除')
    assert.ok(!names.includes('scratch.txt'), '非 md 文件不进树')

    const empty = tree.find(item => item.name === 'fresh-empty-dir')
    assert.equal(empty.type, 'dir')
    assert.deepEqual(empty.children, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scanTree：深层空目录与含文档目录并存，结构完整', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-tree-nested-'))
  try {
    mkdirSync(join(root, 'a/b/c'), { recursive: true })
    writeFileSync(join(root, 'a/b/c/leaf.md'), '# 叶子\n')
    mkdirSync(join(root, 'a/empty-branch'))

    const tree = scanTree(root)
    const a = tree.find(item => item.name === 'a')
    assert.ok(a, '顶层目录在')
    const names = (a.children ?? []).map(item => item.name)
    assert.ok(names.includes('b'), '二级目录在')
    assert.ok(names.includes('empty-branch'), '空的分支也在')
    const b = (a.children ?? []).find(item => item.name === 'b')
    assert.deepEqual(
      ((b?.children ?? []).find(item => item.name === 'c') ?? {}).children?.map(item => item.name),
      ['leaf'],
      '深层文档在',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
