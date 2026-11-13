/**
 * 阅读位置跨标签切换的保持契约。
 *
 * 守的是一类「用户什么都没改，界面却变了」的缺陷：切到设置标签再切回来，
 * 文档回到顶部。根因不止一处，且每一处单独看都「逻辑正确」：
 *
 *  1. **漏保存**：打开设置走 `tabs.openPage`，它直接 activate，不经过
 *     `activateTab`。`activateTab` 里那行保存滚动位置于是永远跑不到，
 *     回来时读到的是旧值 0。
 *  2. **坐标错**：保存的是像素 `scrollY`。字体、正文宽度一改，整篇排版高度
 *     就变了，同一像素指向别的内容；新排版更短时浏览器还会 clamp 到顶部。
 *  3. **重渲染抢位**：高亮 / mermaid / 主题变化会再发一次 `rendered`，
 *     若它拿旧记忆强行落位，用户正看着的位置会被拽走。
 *
 * 所以断言三件事：进出文档的每条路径都保存、恢复优先用源行、重渲染后也按
 * 源行落位。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url)
const APP = readFileSync(new URL('apps/desktop/src/renderer/src/App.vue', ROOT), 'utf8')
const TABS = readFileSync(new URL('apps/desktop/src/renderer/src/stores/tabs.ts', ROOT), 'utf8')

/** 取某函数的实现体（到下一个顶层 function 或区块注释为止） */
function bodyOf(name) {
  const at = APP.indexOf(`function ${name}(`)
  assert.ok(at > 0, `找不到 ${name}`)
  const rest = APP.slice(at)
  const next = rest.search(/\n(?:async )?function |\n\/\* ---------- /)
  return next > 0 ? rest.slice(0, next) : rest
}

/* ---------- 数据结构 ---------- */

test('文档位置同时记像素与源行', () => {
  /*
   * 只记像素就会在「排版变了」之后落错位置。源行是内容坐标，字体、正文宽度、
   * 主题怎么变都指向同一段文字。
   */
  assert.match(TABS, /scrollY: number/, 'DocRef 要有 scrollY')
  assert.match(TABS, /topLine: number/, 'DocRef 要有 topLine（排版无关的坐标）')

  /* 归一化：老标签记录没有这个字段，必须能读成 0 而不是 NaN */
  assert.match(TABS, /topLine: Number\(raw\.topLine\) \|\| 0/, '旧记录缺 topLine 时要回落到 0')

  /* setScroll 要同时写两份 */
  const setter = TABS.slice(TABS.indexOf('function setScroll('))
  assert.match(setter.slice(0, 600), /ref\.scrollY = scrollY/)
  assert.match(setter.slice(0, 600), /ref\.topLine = topLine/, 'setScroll 必须一起记源行')
})

/* ---------- 保存：每条离开路径都要存 ---------- */

test('打开设置 / 插件页前保存阅读位置', () => {
  /*
   * 这是「只切一下设置回来就回顶」的直接原因：openPage 绕过 activateTab。
   */
  for (const name of ['openSettings', 'openPlugins']) {
    const body = bodyOf(name)
    assert.match(body, /rememberReadingPosition\(\)/, `${name} 必须先保存阅读位置`)
  }
})

test('保存动作统一走一个函数，而不是各写一遍', () => {
  const body = bodyOf('rememberReadingPosition')
  assert.match(body, /reader\.getScroll\(\)/, '要存像素（无源行时的兜底）')
  assert.match(body, /reader\.getTopLine\(\)/, '要存源行（排版无关的坐标）')
  assert.match(body, /tabs\.setScroll\(/, '写回标签状态')
})

test('切换标签与标签内导航都保存', () => {
  assert.match(bodyOf('activateTab'), /rememberReadingPosition\(\)/, 'activateTab 要保存')
  assert.match(bodyOf('stepHistory'), /rememberReadingPosition\(\)/, '历史前进/后退要保存')
})

test('正文里点开另一篇文档时保存', () => {
  /*
   * 同一标签内替换文档（navigate）时，旧位置属于旧文档，不存就等于丢掉。
   */
  const navigateAt = APP.indexOf('// 替换当前标签：先把当前屏阅读位置写回')
  assert.ok(navigateAt > 0, '找不到同标签内替换文档的保存点')
  assert.match(
    APP.slice(navigateAt, navigateAt + 200),
    /rememberReadingPosition\(\)/,
    '替换文档前要保存当前位置',
  )
})

/* ---------- 恢复：源行优先 ---------- */

test('恢复时源行优先，像素只作兜底', () => {
  const body = bodyOf('restoreScroll')
  const lineAt = body.indexOf('scrollToSourceLine(ref.topLine)')
  const pixelAt = body.indexOf('restoreScroll(ref.scrollY)')
  assert.ok(lineAt > 0, '恢复要先尝试按源行落位')
  assert.ok(pixelAt > lineAt, '像素恢复只能排在源行之后当兜底')
})

test('重渲染后也按源行落位（否则主题/字体一改就被拽走）', () => {
  /*
   * 高亮、mermaid、主题切换都会再触发一次 `rendered`。那时拿旧记忆强行落位，
   * 用户正在看的位置会被拉回旧处，表现为「什么都没动，页面自己跳了」。
   */
  const body = bodyOf('onRendered')
  const anchorAt = body.indexOf('takeAnchor(handoff)')
  const lineAt = body.indexOf('scrollToSourceLine(ref.topLine)')
  const pixelAt = body.indexOf('restoreScroll(ref.scrollY)')
  assert.ok(anchorAt > 0, '视图切换的锚点仍要优先')
  assert.ok(lineAt > anchorAt, '锚点之后要按记忆的源行落位')
  assert.ok(pixelAt > lineAt, '像素只能最后兜底')
})

test('标签内历史导航也按源行恢复', () => {
  const body = bodyOf('stepHistory')
  assert.match(body, /scrollToSourceLine\(next\.topLine\)/, '历史条目同样记了源行，要用上')
})
