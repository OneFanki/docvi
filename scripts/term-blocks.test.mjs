/**
 * 术语块升格（`.at-term` / `.at-step` / `.at-question`）的纯逻辑单测。
 *
 * 这条规则处理全库 700+ 处「段首加粗」写法，误判成本很高：
 * - 漏判：长段落没有扫读锚点，读者看不进去；
 * - 误判：把强调句、整句论断、单段列表项升格成标题，文档结构直接乱掉。
 * 因此下面把每种形态和每种反例都钉一条用例。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderMarkdown } from '../packages/renderer-core/src/markdown.ts'

function render(src) {
  return renderMarkdown(src, 'test.md').html
}

test('术语块：`**术语**：定义` 升格并剥掉冒号', () => {
  const html = render('**术语**：定义内容。\n')
  assert.match(html, /<p class="at-term" data-term="术语">/)
  assert.match(html, /<strong class="at-term__label">术语<\/strong>定义内容。/)
  // 冒号必须被剥掉（标签已是块级标题，留着会在下一行行首悬一个冒号）
  assert.doesNotMatch(html, /<\/strong>：/)
})

test('术语块：`**短语**。正文` 升格并剥掉句号', () => {
  const html = render('**HTTP 失败与有限重试**。批量切换请求超时。\n')
  assert.match(html, /<p class="at-term" data-term="HTTP 失败与有限重试">/)
  assert.match(html, /<strong class="at-term__label">HTTP 失败与有限重试<\/strong>批量切换/)
})

test('术语块：整段只有一个加粗词时升格为独立小标题', () => {
  const html = render('**本次功能改动**\n')
  assert.match(html, /<p class="at-term" data-term="本次功能改动">/)
})

test('术语块反例：正文中间的加粗是强调，不升格', () => {
  const html = render('普通段落**强调**在这里。\n')
  assert.doesNotMatch(html, /at-term/)
  assert.match(html, /<strong>强调<\/strong>/)
})

test('术语块反例：整句加粗（以句号收尾）不升格为标题', () => {
  const html = render('**它更像是你面对一个空白工程时的底层创作本能。**\n')
  assert.doesNotMatch(html, /at-term/)
  assert.doesNotMatch(html, /at-question/)
})

test('设问标题：以问号收尾升格为 at-question，不套术语竖线', () => {
  const html = render('**为什么壳要这么小？**\n\n正文说明。\n')
  assert.match(html, /<p class="at-question" data-term="为什么壳要这么小？">/)
  assert.match(html, /<strong class="at-question__label">/)
  assert.doesNotMatch(html, /at-term/)
})

test('步骤标题：有序列表项内加粗独占首段且后面有正文 → at-step', () => {
  const src = `1. **创建记录并固化快照**\n\n   说明正文一段。\n`
  const html = render(src)
  assert.match(html, /<p class="at-step" data-term="创建记录并固化快照">/)
  assert.match(html, /<strong class="at-step__label">/)
})

test('步骤标题反例：单段列表项里的加粗是强调，不升格', () => {
  const html = render('- **单段强调**：这就是全部内容\n')
  assert.doesNotMatch(html, /at-step/)
  assert.doesNotMatch(html, /at-term/)
})

test('术语块：带括注的长标题（≤48 字）正常升格', () => {
  const html = render('**Phase B 骨架（2026-10-09 已落地，端点以控制器/DTO 代码为准）**\n')
  assert.match(html, /class="at-term"/)
})

test('文档级开关：frontmatter `terms: false` 关闭升格', () => {
  const html = render('---\nterms: false\n---\n\n**术语**：定义内容。\n')
  assert.doesNotMatch(html, /at-term/)
  // 关闭时标点保持原样
  assert.match(html, /<strong>术语<\/strong>：定义内容。/)
})

test('术语块：默认开启（无 frontmatter 时）', () => {
  const html = render('**术语**：定义内容。\n')
  assert.match(html, /class="at-term"/)
})
