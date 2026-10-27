/**
 * 排版基准同源守卫。
 *
 * 编辑器的实时预览和阅读态的正文来自两套文档（`editor.css` / `doc.css`），
 * 历史上各写一套 px 与 em，结果切模式时字号、行高、左边距全都跳一下
 * （实测正文差 8px 左边距、1.7px 行高，见踩坑库 2026-10-26）。
 *
 * 这个测试锁两件事：
 *  1. 编辑器的基础字号/行高**必须读令牌**，不许写字面量；
 *  2. 六个标题级别的字号与行高必须与 `doc.css` 逐项相等。
 *
 * 判据是「两处数值相等」，不是「看起来差不多」——字符串比对能拦住下一次静默漂移。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const editorTs = readFileSync(join(root, 'packages/editor/src/create-editor.ts'), 'utf8')
const editorCss = readFileSync(join(root, 'packages/editor/src/styles/editor.css'), 'utf8')
const docCss = readFileSync(join(root, 'packages/renderer-core/src/styles/doc.css'), 'utf8')

/**
 * 取某个选择器的**全部**规则块并合并。
 *
 * 同一个选择器可以出现多次（doc.css 里 `.at-doc h6` 就分两段：先给通用标题基样式，
 * 再单独给字号），只取第一段会漏掉字号声明。合并后按出现顺序覆盖，后者生效。
 */
function rulesOf(css, selector) {
  const blocks = []
  let from = 0
  for (;;) {
    const start = css.indexOf(selector + ' {', from)
    if (start < 0) break
    const end = css.indexOf('}', start)
    blocks.push(css.slice(start, end))
    from = end
  }
  assert.ok(blocks.length > 0, `找不到 ${selector}`)
  return blocks.join('\n')
}

const docRule = selector => rulesOf(docCss, selector)
const editorRule = selector => rulesOf(editorCss, selector)

/**
 * 取某个属性的值；同一选择器有多次声明时**取最后一次**——与 CSS 层叠一致。
 * doc.css 的 `.at-doc h6` 分两段写，先给 `line-height: 1.25`（通用基样式），
 * 后给 `line-height: 22px`（具体值），生效的是后者。
 */
function propOf(block, name) {
  const all = [...block.matchAll(new RegExp(`(?:^|\\s|;)${name}:\\s*([^;]+);`, 'g'))]
  return all.length ? all[all.length - 1][1].trim() : null
}

test('编辑器基础字号与行高必须读令牌，不写字面量', () => {
  assert.doesNotMatch(
    editorTs,
    /fontSize:\s*'\d+(?:\.\d+)?px'/,
    '编辑器基础字号写成了字面量，应读 var(--dv-content-font-size)',
  )
  assert.doesNotMatch(
    editorTs,
    /lineHeight:\s*'[0-9.]+'/,
    '编辑器行高写成了字面量，应读 var(--dv-content-line-height)',
  )
  assert.match(editorTs, /var\(--dv-content-font-size/, '编辑器字号应读 --dv-content-font-size')
  assert.match(editorTs, /var\(--dv-content-line-height/, '编辑器行高应读 --dv-content-line-height')
})

test('六个标题级别的字号与行高与阅读态逐项相等', () => {
  for (let level = 1; level <= 6; level += 1) {
    const doc = docRule(`.at-doc h${level}`)
    const live = editorRule(`.cm-lp-h${level}`)
    for (const name of ['font-size', 'line-height']) {
      const a = propOf(doc, name)
      const b = propOf(live, name)
      assert.ok(a, `doc.css 的 h${level} 缺少 ${name}`)
      assert.ok(b, `editor.css 的 .cm-lp-h${level} 缺少 ${name}`)
      assert.equal(
        b,
        a,
        `h${level} 的 ${name} 两处不一致：阅读态 ${a}，实时预览 ${b}（切模式会跳）`,
      )
    }
  }
})

test('列表项层级 class 从 1 起，且与 doc.css 的缩进步长一致', () => {
  // listDepth 必须返回 1 基：CSS 只有 cm-lp-li-1..6，返回 0 会落到无规则的类名
  const livePreview = readFileSync(join(root, 'packages/editor/src/live-preview.ts'), 'utf8')
  assert.match(livePreview, /function listDepth/, '缺少 listDepth')
  assert.doesNotMatch(
    livePreview,
    /Math\.max\(0, depth \+ 1\)/,
    'listDepth 回到了 0 基写法——最外层列表会失去缩进（cm-lp-li-0 无匹配规则）',
  )

  // 缩进步长两处必须一致：doc.css 的 padding-left 与 editor.css 的一级步长
  const docList = docCss.slice(
    docCss.indexOf('.at-doc ul,'),
    docCss.indexOf('}', docCss.indexOf('.at-doc ul,')),
  )
  const step = propOf(docList, 'padding-left')
  assert.ok(step, 'doc.css 的列表缺少 padding-left')
  const li1 = editorRule('.cm-line.cm-lp-li-1')
  assert.ok(
    li1.includes(step),
    `一级列表缩进应包含与阅读态相同的步长 ${step}，实际为：${li1.trim()}`,
  )
})

test('块级替换装饰的 widget 必须是块级元素，且上下留白用 padding', () => {
  const live = readFileSync(join(root, 'packages/editor/src/live-preview.ts'), 'utf8')

  /*
   * 两条硬约束，都只影响「点击命中」而不影响观感——所以必须靠测试锁住，
   * 靠肉眼根本发现不了（实测：带 frontmatter 时命中率 68%，去掉后 100%）。
   *
   * 1. `Decoration.replace({ block: true })` 的 widget DOM 必须是块级：
   *    行内元素（span / display:inline-flex）参与行内布局，而 CM6 按块记账高度，
   *    两个口径错开 → 其后所有行点击坐标整体偏移。
   * 2. 块 widget 的上下间距必须用 padding：CM6 用 getBoundingClientRect 量高度，
   *    margin 不计入，会与真实布局高度错开。
   */
  assert.doesNotMatch(
    live,
    /new FrontmatterWidget[\s\S]{0,200}?createElement\('span'\)/,
    'frontmatter 卡是 block:true 的替换装饰，DOM 必须是块级元素（不能用 span）',
  )

  const chip = editorRule('.cm-lp-frontmatter')
  assert.match(
    chip,
    /display:\s*flex/,
    'frontmatter 卡必须是块级 display（flex，不能是 inline-flex）',
  )
  assert.doesNotMatch(chip, /display:\s*inline-flex/, 'frontmatter 卡不能是 inline-flex')

  const blockStyle = editorRule('.cm-lp-block')
  assert.doesNotMatch(
    blockStyle,
    /margin:\s*[^;]*\d(px|em)\s+0/,
    '块 widget 的上下间距不能用 margin（CM6 量高度不计 margin），应改用 padding',
  )
  assert.match(blockStyle, /padding:\s*0\.6em 0/, '块 widget 应保留 0.6em 的上下 padding')
})

test('实时预览不做视口窗口化（装饰必须按全文构建）', () => {
  const live = readFileSync(join(root, 'packages/editor/src/live-preview.ts'), 'utf8')
  /*
   * 窗口化会让「切到实时预览」时装饰只覆盖文档开头（视口还没测量），
   * 表现为正文仍是 Markdown 源码、点一下才渲染。详见踩坑库 2026-10-27。
   */
  assert.doesNotMatch(live, /viewportDriver/, '视口窗口化已删除，不应再引入')
  assert.match(
    live,
    /ensureSyntaxTree\(state, doc\.length/,
    '构建装饰前必须确保整篇文档已解析，否则遍历不到远处的标题/强调节点',
  )
  assert.doesNotMatch(
    live,
    /syntaxTree\(state\)\.iterate/,
    '必须遍历 ensureSyntaxTree 的返回值；syntaxTree(state) 只是视口局部树',
  )
})
