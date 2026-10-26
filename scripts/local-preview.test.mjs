/**
 * 容器读者面的本地 Markdown 预览：路径规范化与目录树。
 *
 * 这批函数决定「浏览器选进来的文件」如何变成工作区路径，错一处就是整棵树
 * 错位或正文取不到。重点钉住三件事：
 *  1. 目录模式必须剥掉用户选中那层根目录名（否则树里多套一层）；
 *  2. Windows 反斜杠路径要归一成 POSIX（树与路由都用 `/`）；
 *  3. 树序与站点目录树同口径（目录在前、中文 locale、数字前缀自然序）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { normalizeLocalPath, stripCommonRoot, buildLocalTree, firstDocPath } =
  await import('../apps/desktop/src/renderer/src/lib/local-preview.ts')

test('路径规范化：反斜杠、前导 ./ 与重复分隔符都收敛成 POSIX 相对路径', () => {
  assert.equal(normalizeLocalPath('a\\b\\c.md'), 'a/b/c.md')
  assert.equal(normalizeLocalPath('./指南/intro.md'), '指南/intro.md')
  assert.equal(normalizeLocalPath('/x//y/'), 'x/y')
  assert.equal(normalizeLocalPath('a/./b.md'), 'a/b.md')
})

test('目录模式：剥掉共同的第一段（用户选中的文件夹名）', () => {
  const result = stripCommonRoot([
    { path: '我的笔记/指南/intro.md', text: '# a' },
    { path: '我的笔记/指南/deep/b.md', text: '# b' },
  ])
  assert.equal(result.rootName, '我的笔记')
  assert.deepEqual(
    result.files.map(file => file.path),
    ['指南/intro.md', '指南/deep/b.md'],
  )
})

test('目录模式：没有共同根目录时保持原路径', () => {
  const result = stripCommonRoot([
    { path: 'a/x.md', text: '' },
    { path: 'b/y.md', text: '' },
  ])
  assert.equal(result.rootName, null)
  assert.deepEqual(
    result.files.map(file => file.path),
    ['a/x.md', 'b/y.md'],
  )
})

test('散文件模式：内容就是根部的一批文件，不剥任何段', () => {
  const result = stripCommonRoot([{ path: 'x.md', text: '' }])
  assert.equal(result.rootName, null)
  assert.deepEqual(
    result.files.map(file => file.path),
    ['x.md'],
  )
})

test('目录树：目录在前、中文 locale 排序、数字前缀自然序', () => {
  const tree = buildLocalTree([
    { path: 'b.md', text: '' },
    { path: 'a/2.md', text: '' },
    { path: 'a/10.md', text: '' },
    { path: '10-后.md', text: '' },
    { path: '2-前.md', text: '' },
  ])
  assert.deepEqual(
    tree.map(node => node.name),
    ['a', '2-前.md', '10-后.md', 'b.md'],
  )
  const dir = tree[0]
  assert.equal(dir.type, 'dir')
  assert.deepEqual(
    dir.children?.map(node => node.name),
    ['2.md', '10.md'],
  )
})

test('目录树：嵌套目录的 path 是完整内容根相对路径（路由与读文档都用它）', () => {
  const tree = buildLocalTree([{ path: 'a/b/c.md', text: '' }])
  const a = tree[0]
  const b = a?.children?.[0]
  assert.equal(a?.path, 'a')
  assert.equal(b?.path, 'a/b')
  assert.equal(b?.children?.[0]?.path, 'a/b/c.md')
  assert.equal(b?.children?.[0]?.type, 'doc')
})

test('第一篇文档：用于装载后自动落点', () => {
  const tree = buildLocalTree([
    { path: 'dir/z.md', text: '' },
    { path: 'dir/a.md', text: '' },
  ])
  assert.equal(firstDocPath(tree), 'dir/a.md')
  assert.equal(firstDocPath([]), null)
})
