/**
 * 导出产物的主题与资源契约。
 *
 * 这些不是「源码里有没有某字符串」的变更检测，而是导出必须守住的两条语义：
 *  1. **PDF 固定浅色、HTML 跟随文档主题**——深色 PDF 打印费墨，且常与阅读器
 *     深色 UI 叠成一片；HTML 是给人屏幕看的，就该保持他选的主题。
 *  2. **图片走原始字节（Blob）而不是 canvas 重绘**——canvas 会把 JPEG 转成
 *     PNG（体积翻几倍）、丢掉动图与 SVG 语义、跨源图还会 taint 画布。
 *
 * 第 1 条还有一条隐性依赖：离屏渲染必须在**目标主题作用域内**完成。主题选择器
 * 都写成 `:root[data-theme=…]`，所以只能临时改 documentElement；只给离屏容器
 * 加 data-theme 不会命中，mermaid 会把屏幕配色烘焙进产物。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(
  new URL('../apps/desktop/src/renderer/src/lib/export-doc.ts', import.meta.url),
  'utf8',
)

/* ---------- 主题口径 ---------- */

test('PDF 走 paper，HTML 跟随文档主题', () => {
  // 调用方在 App.vue 里决定；这里断言导出层的落点读的是 renderTheme
  assert.match(
    SOURCE,
    /data-theme="\$\{escapeHtml\(options\.renderTheme\)\}"/,
    '产物 <html data-theme> 必须来自 renderTheme，而不是另算一个',
  )
})

test('离屏渲染临时切换 documentElement 主题并恢复', () => {
  assert.match(SOURCE, /root\.dataset\.theme = options\.renderTheme/, '渲染前必须切到目标主题')
  assert.match(SOURCE, /root\.dataset\.appearance = options\.renderAppearance/)
  assert.match(SOURCE, /restoreTheme\(\)/, '渲染完必须还回去')
  // 只给离屏容器加 data-theme 是不够的：主题档都写成 :root[...]
  assert.doesNotMatch(
    SOURCE,
    /host\.dataset\.theme\s*=/,
    '离屏容器上的 data-theme 不命中 :root 选择器，别用这种写法',
  )
})

test('主题恢复发生在 finally 里（渲染抛错也要还回去）', () => {
  const from = SOURCE.indexOf('await highlightPass')
  // 从渲染调用开始截到函数收尾（用下一个函数的声明做右界，避免撞上类型声明里的 dispose）
  const to = SOURCE.indexOf('/** 清理只对屏幕有意义的东西')
  assert.ok(from > 0 && to > from, '导出源码结构变了，请更新本测试的切片边界')
  const block = SOURCE.slice(from, to)
  assert.match(block, /finally\s*\{[\s\S]*?restoreTheme\(\)/, '恢复必须在 finally 中')
})

/* ---------- 图片内联 ---------- */

test('图片内联取原始字节，不用 canvas 重绘', () => {
  assert.match(SOURCE, /await fetch\(src\)/, '必须先试 fetch 原始字节')
  assert.match(SOURCE, /blobToDataUrl/, '必须按原始 MIME 转 data URL')
  // canvas 方案的三个损失见文件头注释；出现 toDataURL 就说明退回去了
  assert.doesNotMatch(
    SOURCE,
    /toDataURL\(/,
    '不能用 canvas.toDataURL 重绘（丢格式/涨体积/跨源 taint）',
  )
})

test('取不到字节时保留原地址而不是删掉图片', () => {
  assert.match(SOURCE, /if \(!response\.ok\) return/)
  // 失败分支只是 return（不改 src），不是 remove()
  const inlineBody = SOURCE.slice(SOURCE.indexOf('async function inlineImages'))
  assert.doesNotMatch(inlineBody.slice(0, 1200), /\.remove\(\)/, '失败不该删元素')
})

test('MIME 未知时不内联（避免 data:;base64 死链）', () => {
  assert.match(SOURCE, /if \(!mime\.startsWith\('image\/'\)\) return/)
})

/* ---------- 屏幕专用元素 ---------- */

test('导出产物剔除只对屏幕有意义的按钮', () => {
  const cleaner = SOURCE.slice(
    SOURCE.indexOf('function cleanClone'),
    SOURCE.indexOf('function materializeEmbeds'),
  )
  for (const selector of ['header-anchor', 'at-copy', 'at-htmlembed__open']) {
    assert.ok(cleaner.includes(`.${selector}`), `.${selector} 必须被清掉`)
  }
})
