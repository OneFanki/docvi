/**
 * 正文分隔线的排版契约。
 *
 * 背景（2026-11-18 用户反馈）：每章之间出现两条平行细线、中间夹一大段空白。
 * 根因是**两种分隔语义叠在一起**——作者写 `---` 表达章节分隔，渲染成 `<hr>`；
 * 而 `h2` 自己带一条 `border-top` 分隔线。两条线加 48px 标题上边距，看起来
 * 像排版错乱。
 *
 * 这里守的是修复方式本身：**紧挨标题的 hr 只留间距、不留线**。读 CSS 而不跑
 * 浏览器，是因为这是纯排版规则，浏览器实测已由探针做过（hr 的 border-top 归零、
 * 独立的 hr 仍是 1px）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const CSS = readFileSync(
  new URL('../packages/renderer-core/src/styles/doc.css', import.meta.url),
  'utf8',
)

/** 取出某条规则块（选择器 → 声明） */
function rule(selector) {
  const index = CSS.indexOf(selector)
  if (index < 0) return null
  const open = CSS.indexOf('{', index)
  const close = CSS.indexOf('}', open)
  if (open < 0 || close < 0) return null
  return CSS.slice(open + 1, close)
}

test('hr 本身是一条 1px 分隔线', () => {
  const body = rule('.at-doc hr {')
  assert.ok(body, '找不到 .at-doc hr 规则')
  assert.match(body, /border-top:\s*1px solid/, 'hr 应当是 1px 实线')
})

test('紧挨标题的 hr 不画线（避免与标题自带的分隔线叠成两条）', () => {
  const body = rule('.at-doc hr:has(+ ')
  assert.ok(body, '缺少「hr 后紧跟标题」的规则——两条线会重新叠出来')
  assert.match(body, /border-top:\s*none/, '这条规则必须把 hr 的线去掉')
  for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    assert.ok(CSS.includes(level), `规则应覆盖 ${level}：章节标题的层级不固定，漏一级就漏一处双线`)
  }
})

test('标题自带的分隔线仍在（hr 去线不等于取消章节分隔）', () => {
  const body = rule('.at-doc h2 {')
  assert.ok(body, '找不到 .at-doc h2 规则')
  assert.match(body, /border-top:\s*1px solid/, 'h2 的分隔线是章节分隔的唯一视觉来源，不能一起删掉')
})

test('h1 的分隔线在下方，与 h2 的在上方互补', () => {
  const body = rule('.at-doc h1 {')
  assert.ok(body)
  assert.match(body, /border-bottom:\s*1px solid/)
  assert.doesNotMatch(body, /border-top:\s*1px solid/)
})
