/**
 * 跨版本更新说明的选取逻辑（纯函数单测）。
 *
 * 这条逻辑错一步，用户看到的就是错的「你会得到什么」：
 *  - 把等于当前版本的列进去 → 让人以为自己装的是旧的；
 *  - 把预发布/草稿列进去 → 承诺了没发布的东西；
 *  - 超出上限时砍最新的而不是最旧的 → 用户马上要装的那版反而没说明；
 *  - 语言段抽错 → 中文用户读到英文段（或整段 changelog）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { pickLanguageNotes, selectUpdateRange } from '../../apps/desktop/src/main/update-plan.ts'
import { compareVersions } from '../../apps/desktop/src/main/version.ts'

const rel = (version, extra = {}) => ({ version, notes: `notes for ${version}`, ...extra })

test('只取严格大于当前版本的，按版本从旧到新', () => {
  const releases = [rel('0.9.0'), rel('0.7.0'), rel('0.8.0'), rel('0.6.0')]
  const { sections, omitted } = selectUpdateRange('0.7.0', releases, compareVersions)
  assert.deepEqual(
    sections.map(item => item.version),
    ['0.8.0', '0.9.0'],
    '等于当前版本的 0.7.0 不能出现，且必须旧→新排列',
  )
  assert.equal(omitted, 0)
})

test('数组顺序不可信：按版本号数值排序，不是按传入顺序', () => {
  /*
   * GitHub 的 /releases 通常按发布时间倒序，但「通常」不是契约；
   * 补发旧版本时时间序与版本序还会不一致。
   */
  const releases = [rel('0.10.0'), rel('0.9.0'), rel('0.11.0')]
  const { sections } = selectUpdateRange('0.8.0', releases, compareVersions)
  assert.deepEqual(
    sections.map(item => item.version),
    ['0.9.0', '0.10.0', '0.11.0'],
    '0.10.0 必须排在 0.9.0 之后（数值序，不是字符串序）',
  )
})

test('跳过预发布与草稿', () => {
  const releases = [rel('1.0.0', { prerelease: true }), rel('0.9.0', { draft: true }), rel('0.8.0')]
  const { sections } = selectUpdateRange('0.7.0', releases, compareVersions)
  assert.deepEqual(
    sections.map(item => item.version),
    ['0.8.0'],
    '预发布与草稿都不该出现在「你会得到什么」里',
  )
})

test('超上限时砍最旧的，被砍条数如实报告', () => {
  /*
   * 用户马上要装的是最新那版，离它近的说明才是他关心的。
   * 砍最新那版、留最旧的一批，等于给了最不相关的信息。
   */
  const releases = Array.from({ length: 15 }, (_, index) => rel(`1.0.${index}`))
  const { sections, omitted } = selectUpdateRange('0.9.0', releases, compareVersions, 10)
  assert.equal(sections.length, 10)
  assert.equal(omitted, 5)
  assert.equal(sections.at(-1)?.version, '1.0.14', '最新那版必须留下')
  assert.equal(sections[0]?.version, '1.0.5', '被砍掉的是最旧的 1.0.0~1.0.4')
})

test('没有新版本时区间为空', () => {
  const { sections, omitted } = selectUpdateRange('1.0.0', [rel('1.0.0')], compareVersions)
  assert.deepEqual(sections, [])
  assert.equal(omitted, 0)
})

test('空列表不抛异常', () => {
  const { sections, omitted } = selectUpdateRange('1.0.0', [], compareVersions)
  assert.deepEqual(sections, [])
  assert.equal(omitted, 0)
})

/* ---------- 语言段抽取 ---------- */

const BODY_WITH_SECTIONS = `### 中文

- 第一条摘要
- 第二条摘要

#### 完整变更

- 一条不该出现在摘要里的明细

### English

- First summary line
- Second summary line

#### Full changelog

- A detail that must not appear in the summary`

test('只取目标语言的摘要段，到「完整变更」为止', () => {
  const zh = pickLanguageNotes(BODY_WITH_SECTIONS, 'zh')
  assert.match(zh, /第一条摘要/)
  assert.doesNotMatch(zh, /明细/, '「完整变更」之后的明细不该进摘要')
  assert.doesNotMatch(zh, /First summary/, '不该混进英文段')

  const en = pickLanguageNotes(BODY_WITH_SECTIONS, 'en')
  assert.match(en, /First summary line/)
  assert.doesNotMatch(en, /A detail that must not/, '「Full changelog」之后的明细不该进摘要')
  assert.doesNotMatch(en, /第一条摘要/, '不该混进中文段')
})

test('标题层级从实际结构推断：## 与 #### 两种形态都认', () => {
  /*
   * 同一份正文在 CHANGELOG 里语言标题是 `###`，在 GitHub Release 页面上
   * 因为多了版本标题会显得更深。硬编码层级会导致一条都匹配不到、
   * 然后静默回退成整篇正文（弹窗里出现几十条明细）。
   */
  const shallow = `## 中文\n\n- 浅层摘要\n\n## English\n\n- shallow summary`
  assert.match(pickLanguageNotes(shallow, 'zh'), /浅层摘要/)

  const deep = `#### 中文\n\n- 深层摘要\n\n#### English\n\n- deep summary`
  assert.match(pickLanguageNotes(deep, 'zh'), /深层摘要/)
})

test('没有语言标题的正文原样返回（手写 Release 说明不该被吞掉）', () => {
  const plain = '- 只是一个普通说明\n- 没有语言分段'
  assert.equal(pickLanguageNotes(plain, 'zh'), plain)
})

test('空正文返回空串，不抛异常', () => {
  assert.equal(pickLanguageNotes(undefined, 'zh'), '')
  assert.equal(pickLanguageNotes('', 'zh'), '')
})

test('目标语言段为空时退回整篇正文', () => {
  /*
   * 只有中文段、用户界面是英文时，宁可给他中文原文（至少能看懂或翻译），
   * 也不要给一个空白弹窗。
   */
  const onlyZh = `### 中文\n\n- 只有中文`
  const en = pickLanguageNotes(onlyZh, 'en')
  assert.ok(en.length > 0, '不该返回空串')
  assert.match(en, /只有中文/, '退回整篇正文')
})
