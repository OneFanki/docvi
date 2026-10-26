/**
 * 编辑器选区可见性的守卫。
 *
 * 用户报的问题很具体：「选中文本，几乎看不到选中效果」。根因不是颜色太淡，
 * 而是**层级**——CM6 默认把选区层放在正文下方（`z-index: -1`），于是任何带
 * 不透明背景的块都会把它盖掉：
 *  - `.cm-activeLine`（光标所在行的底色）——拖选一整段时最后一行选区完全消失；
 *  - 行内代码的色块、`cm-lp-*` 的各种块级样式，同理。
 *
 * 再加两个叠加因素：
 *  - `EditorView.theme` 没声明 `dark`，CM6 视作浅色，用 `&light.cm-focused …`
 *    这条高特异度规则画出它自己的淡紫（#d7d4f0），品牌色失效；
 *  - 浅色主题的选区 token 只有 20%，在米白底上几乎与背景同色。
 *
 * 三条约束都是「改主题时容易无意破坏」的，所以用源码级断言钉住。真实观感在
 * CDP 脚本里核对（`.temp/sel-verify.mjs`：深浅两套主题各截一次）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const editorSource = readFileSync(
  new URL('../packages/editor/src/create-editor.ts', import.meta.url),
  'utf8',
)
const themeCss = readFileSync(
  new URL('../packages/renderer-core/src/styles/theme.css', import.meta.url),
  'utf8',
)

test('选区层必须盖在正文之上（否则活动行背景会盖掉选区）', () => {
  const rule = /'\.cm-selectionLayer':\s*\{\s*zIndex:\s*'(-?\d+)(\s*!important)?'/.exec(
    editorSource,
  )
  assert.ok(rule, '找不到 .cm-selectionLayer 的 zIndex 声明')
  const z = Number(rule[1])
  assert.ok(z >= 0, `选区层 z-index 必须非负（当前 ${z}）——负值会被行背景盖住`)
  assert.ok(rule[2], 'z-index 必须带 !important：CM6 的层顺序由内联样式写死')
})

test('选区层与选区矩形都不接收指针事件（否则选区内的点击会被吃掉）', () => {
  /*
   * 抬高层级后的必然后果：选区矩形覆盖在正文上，一旦它能接事件，点击它的
   * 位置就再也落不到光标——实测「选中一段后点任意一行，光标完全不移动」，
   * 用户看到的正是「这一行点不进去 / 点这里光标却留在别处」。
   * 选区层是纯视觉层，事件必须穿到下面的正文。
   */
  const layerRule = /'\.cm-selectionLayer':\s*\{[^}]*\}/.exec(editorSource)?.[0] ?? ''
  assert.match(layerRule, /pointerEvents:\s*'none !important'/, '选区层必须 pointer-events: none')

  const bgRule =
    /'\.cm-selectionLayer \.cm-selectionBackground':\s*\{[^}]*\}/.exec(editorSource)?.[0] ?? ''
  assert.match(
    bgRule,
    /pointerEvents:\s*'none !important'/,
    '选区矩形自己也要 pointer-events: none（层设了不足以覆盖内联样式）',
  )
})

test('选区底色必须压过 CM6 自带的浅色主题规则', () => {
  assert.match(
    editorSource,
    /'\.cm-selectionLayer \.cm-selectionBackground':\s*\{\s*backgroundColor:\s*'var\(--dv-ed-selection\) !important'/,
    '选区底色声明需要 !important——CM6 的 &light.cm-focused 规则特异度更高',
  )
})

test('四套主题的编辑器选区都足够可见（深色 ≥40%，浅色 ≥28%）', () => {
  const matches = [...themeCss.matchAll(/--dv-ed-selection:\s*rgb\(([\d\s]+)\/\s*([\d.]+)%\)/g)]
  assert.equal(matches.length, 4, `应有 4 套主题的 --dv-ed-selection，实际 ${matches.length}`)
  for (const match of matches) {
    const percent = Number(match[2])
    assert.ok(percent >= 28, `--dv-ed-selection ${percent}% 太淡，选中效果会看不出来`)
  }
  // 深色底的对比度需求更高（光渗效应会让低透明度的色块更不明显）
  const dark = [...themeCss.matchAll(/--dv-ed-selection:\s*rgb\(217 160 91 \/\s*([\d.]+)%\)/g)]
  assert.ok(dark.length === 1 && Number(dark[0][1]) >= 40, 'graphite 主题选区应 ≥40%')
})
