/**
 * 单文件文档的图片资产登记与灯箱尺寸的回归测试。
 *
 * 用户报了两件事，都在这里钉住：
 *  1. 「相对路径的图片无法预览」——单文件文档没有内容根，图片前缀缺失，
 *     `images/a.png` 被拼到 `docvi://app/`（渲染产物目录）必然 404。
 *  2. 「mermaid 大图看不清」——mermaid 产物写 `width="100%"`，放进
 *     `width: max-content` 的灯箱容器后百分比无参照，浏览器回落到 300px 宽。
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'

const { createLocalAssetRegistry } = await import('../apps/desktop/src/main/local-assets.ts')
const { pinSize } = await import('../plugins/base/src/components/svg-size.ts')

/*
 * 路径一律用宿主原生写法拼出来，不能写死 `C:\docs\note.md`。
 *
 * 登记表用宿主的 `dirname` 取资产根，而 `path.posix.dirname('C:\\docs\\note.md')`
 * 返回 `'.'`——在 Linux 上写死 Windows 路径的断言必然失败（CI 实测挂了两条）。
 * 真实路径永远是宿主原生的，所以这样写既跨平台又更贴近实际输入。
 */
const DIR = join(process.cwd(), 'fake-docs')
const fileIn = name => join(DIR, name)

test('登记单文件后返回可用的资产前缀，且能按 id 反查所在目录', () => {
  const registry = createLocalAssetRegistry()
  const file = fileIn('note.md')
  const prefix = registry.register(file)
  assert.match(prefix, /^docvi:\/\/local\/[0-9a-f]{16}$/)
  const id = prefix.split('/').pop()
  assert.equal(registry.rootOf(id), dirname(file))
})

test('同一文件重复登记返回同一个前缀（每次重读不该生成新 id）', () => {
  const registry = createLocalAssetRegistry()
  const file = fileIn('note.md')
  assert.equal(registry.register(file), registry.register(file))
})

/*
 * 大小写与斜杠方向不参与 id 计算：Windows 上 `C:\Docs\Note.md` 与 `c:/docs/note.md`
 * 是同一个文件，给两个 id 会让同一篇文档的图片前缀来回抖动。
 *
 * 这条只比较两个前缀是否相等，不经过 `dirname`，因此任何平台都能断言。
 */
test('路径大小写与斜杠方向不影响 id（Windows 同一文件两种写法）', () => {
  const registry = createLocalAssetRegistry()
  const a = registry.register('C:\\Docs\\Note.md')
  const b = registry.register('c:/docs/note.md')
  assert.equal(a, b)
})

/* 反斜杠能不能解析成目录是 Windows 专有的行为，只能在 Windows 上断言 */
test('Windows 反斜杠路径解析到所在目录', { skip: process.platform !== 'win32' }, () => {
  const registry = createLocalAssetRegistry()
  const id = registry.register('C:\\docs\\note.md').split('/').pop()
  assert.equal(registry.rootOf(id), 'C:\\docs')
})

test('未登记过的 id 反查不到（渲染层无法凭空访问任意目录）', () => {
  const registry = createLocalAssetRegistry()
  registry.register(fileIn('note.md'))
  assert.equal(registry.rootOf('0000000000000000'), undefined)
  assert.equal(registry.rootOf(''), undefined)
})

test('登记数量有上限：超过后淘汰最久未用的（内存不随标签数无限增长）', () => {
  const registry = createLocalAssetRegistry()
  const firstId = registry.register(fileIn('a.md')).split('/').pop()
  for (let i = 0; i < 70; i += 1) registry.register(fileIn(`doc-${i}.md`))
  assert.equal(registry.rootOf(firstId), undefined, '最久未用的条目应被淘汰')
})

test('重复访问会刷新 LRU 位置（最近用过的不会被淘汰）', () => {
  const registry = createLocalAssetRegistry()
  const keep = fileIn('keep.md')
  const firstId = registry.register(keep).split('/').pop()
  for (let i = 0; i < 60; i += 1) {
    registry.register(fileIn(`doc-${i}.md`))
    // 每轮都重新登记 keep：它始终是「最近用过」的
    registry.register(keep)
  }
  assert.equal(registry.rootOf(firstId), dirname(keep))
})

/**
 * mermaid 的 `width="100%"` 必须被钉成 viewBox 尺寸。
 *
 * 这里断言的是**规则**而非实现：带百分比宽度的 SVG 在没有包含块时，
 * 浏览器按 300px 兜底——这是 SVG 规范的初始值，不是某个浏览器的怪癖。
 */
test('尺寸钉定：百分比宽度一律换成 viewBox 的实际尺寸', () => {
  // viewBox 是唯一的真实尺寸来源；width/height 属性可能是 100% 这种相对值
  assert.deepEqual(pinSize('100%', '0 0 800.48046875 949.171875'), {
    width: 800.48046875,
    height: 949.171875,
  })
  // 已是绝对尺寸时保持一致（不因取整而抖动）
  assert.deepEqual(pinSize('640', '0 0 640 480'), { width: 640, height: 480 })
  // 没有 viewBox 就没有可用的真实尺寸来源：不给尺寸，让浏览器自己排
  assert.equal(pinSize('100%', null), null)
  // viewBox 畸形（0 宽高）同样视为不可用
  assert.equal(pinSize('100%', '0 0 0 0'), null)
})
