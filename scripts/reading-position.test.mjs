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

  /*
   * 老会话文件没有 topLine。必须读成 -1（「不知道」），不能读成 0。
   * 0 是合法坐标（用户就在开头），拿它当缺省值等于谎称「他当时在最顶上」，
   * 恢复时会把文档拽回开头。
   */
  assert.match(
    TABS,
    /topLine: Number\.isFinite\(Number\(raw\.topLine\)\) \? Number\(raw\.topLine\) : -1/,
    '旧记录缺 topLine 时要回落到 -1（未知），不能是 0',
  )

  /* setScroll 要同时写两份，且不能把合法的 0 吞掉 */
  const setter = TABS.slice(TABS.indexOf('function setScroll('))
  assert.match(setter.slice(0, 900), /ref\.scrollY = scrollY/)
  assert.match(setter.slice(0, 900), /ref\.topLine = topLine/, 'setScroll 必须一起记源行')
  assert.match(
    setter.slice(0, 900),
    /if \(topLine >= 0\)/,
    '只拒绝负数（-1 = 未知）；写成 > 0 会把「在最顶部」也吞掉',
  )
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

test('恢复时按排版签名决定信像素还是源行', () => {
  /*
   * 只按源行会「停在块开头」——`scrollToSourceLine` 只能定位到块的起点，
   * 用户滚到长代码块中间时，切回来会跳到块首（实测偏差几百像素）。
   * 只按像素会在改字体/宽度后落到别处，因为整篇高度重排了。
   *
   * 所以判据是排版签名：没变 → 像素精确；变了 → 退回源行。
   */
  const body = bodyOf('applyRecordedPosition')
  const sigAt = body.indexOf('layoutSignature()')
  const lineAt = body.indexOf('scrollToSourceLine')
  const pixelAt = body.indexOf('restoreScroll(ref.scrollY)')
  assert.ok(sigAt > 0, '必须先比对排版签名')
  assert.ok(lineAt > sigAt, '签名不一致时才走源行')
  assert.ok(pixelAt > lineAt, '源行不可用时像素兜底')
})

test('三处恢复入口共用同一套判据', () => {
  /* 各写一套必然漂移：一处修好另一处还是旧逻辑，问题就「只在一半场景下复现」 */
  for (const name of ['restoreScroll', 'stepHistory', 'onRendered']) {
    assert.match(bodyOf(name), /applyRecordedPosition\(/, `${name} 必须走统一判据`)
  }
})

test('重渲染时视图锚点仍优先（切视图不丢视野）', () => {
  const body = bodyOf('onRendered')
  const anchorAt = body.indexOf('takeAnchor(handoff)')
  const applyAt = body.indexOf('applyRecordedPosition(ref)')
  assert.ok(anchorAt > 0, '要取视图切换的锚点')
  assert.ok(applyAt > anchorAt, '锚点优先，其次才是标签记忆的位置')
})

/* ---------- 持续上报：位置不能等到切走才落盘 ---------- */

test('滚动时持续回写位置（不是只在切走时读一次）', () => {
  /*
   * 只在切走时读一次的话，用户滚完但还没做任何动作的那段时间位置从未落盘，
   * 任何一次重新应用位置（切标签回来、重渲染）都会拿到陈旧值——回顶。
   * 这是「我明明滚到了中间，切个标签就回顶」的根因。
   */
  const reader = readFileSync(
    new URL('apps/desktop/src/renderer/src/components/ReaderView.vue', ROOT),
    'utf8',
  )
  assert.match(
    reader,
    /scrolled: \[payload: \{ topLine: number; scrollY: number \}\]/,
    '要声明上报事件',
  )
  assert.match(reader, /addEventListener\('scroll', reportScroll/, '要监听滚动')

  const app = readFileSync(new URL('apps/desktop/src/renderer/src/App.vue', ROOT), 'utf8')
  assert.match(app, /function onReaderScrolled\(/, 'App 要接收上报')
  assert.match(app, /@scrolled="onReaderScrolled"/, '普通阅读视图要接上事件')
})

test('切走前 flush 待上报的位置（节流窗口内的最后一段不能丢）', () => {
  const body = bodyOf('rememberReadingPosition')
  assert.match(body, /reader\.flushScroll\(\)/, '切走前必须把节流队列冲空')
})

test('节流间隔要短于会话防抖，否则永远写不进去', () => {
  /*
   * session.json 的写入是 600ms 防抖。若上报频率高于这个防抖的间隔（即
   * 每次都重置计时器），防抖永远不触发，位置永远不落盘。200ms 上报 + 600ms
   * 防抖能保证「滚动停下后 600ms 一定写盘」。
   */
  const reader = readFileSync(
    new URL('apps/desktop/src/renderer/src/components/ReaderView.vue', ROOT),
    'utf8',
  )
  const interval = /scrollReportTimer = setTimeout\([\s\S]{0,200}?\},\s*(\d+)\)/.exec(reader)?.[1]
  assert.ok(interval, '找不到节流间隔')
  assert.ok(Number(interval) < 600, `节流 ${interval}ms 必须小于会话防抖 600ms`)
})

test('源行为 0 时不能盲信（旧会话把它当缺省值）', () => {
  /*
   * 上一版把「没有源行信息」也存成 0。加载旧会话后若照单全收，
   * scrollToSourceLine(0) 会把文档滚到顶部**并返回 true**，压住像素兜底——
   * 这正是用户机器上能复现、而全新数据目录测不出来的原因。
   */
  const body = bodyOf('positionTrustworthy')
  assert.match(body, /ref\.topLine < 0/, '负数（未知）必须直接判不可信')
  assert.match(body, /ref\.topLine > 0 \|\| ref\.scrollY < 40/, '0 只有在像素也接近顶部时才可信')
})

/* ---------- 恢复期的副作用不能写回存储 ---------- */

test('恢复位置期间抑制滚动上报', () => {
  /*
   * 恢复把 scrollTop 设成 1733，浏览器随后还会因布局重排、图片解码再发几次
   * scroll。若这些也上报，最后一条会把刚恢复的正确值覆盖成中间态
   * （实测 1733 → 95），表现为「恢复成功但界面仍回顶」。
   */
  const reader = readFileSync(
    new URL('apps/desktop/src/renderer/src/components/ReaderView.vue', ROOT),
    'utf8',
  )
  assert.match(reader, /if \(restoring\) return/, '上报入口要先检查恢复标志')
  assert.match(reader, /function beginRestore\(\)/, '要有开窗函数')

  /* 三个程序性滚动入口都要开窗 */
  for (const method of ['restoreScroll:', 'scrollToRatio:', 'scrollToSourceLine:']) {
    const at = reader.indexOf(method)
    assert.ok(at > 0, `找不到 ${method}`)
    const body = reader.slice(at, at + 1400)
    assert.match(body, /beginRestore\(\)/, `${method} 设置 scrollTop 前要开窗抑制上报`)
  }
})

test('读不到源行时默认值必须是 -1，不能是 0', () => {
  /*
   * 三处 `getTopLine() ?? 0` 都曾是埋点：阅读视图刚重挂载、还没排版完时
   * 读位置会拿到 -1，被 `?? 0` 变成 0，再经 leaveView 的 `Math.max` 固化成
   * 「用户在最顶部」，最后被 onRendered 拿去 scrollToSourceLine(0) 拽回顶部。
   *
   * 只查阅读视图：编辑器的 getTopLine 没有 -1 语义，`?? 0` 对它是正确的。
   */
  const app = readFileSync(new URL('apps/desktop/src/renderer/src/App.vue', ROOT), 'utf8')
  const offenders = [...app.matchAll(/readerRef\.value\?\.getTopLine\(\) \?\? 0/g)]
  assert.equal(offenders.length, 0, '阅读视图 getTopLine 的默认值必须是 -1（未知），不能是 0')
})

test('排版签名只在排版设置变化时改变，不含内容高度', () => {
  /*
   * 签名里放 `scrollHeight` 会让它永远对不上：图片解码、mermaid 渲染、
   * 字体加载都会改内容高度，刚挂载与稳定态天然不同。那样每次都走源行分支，
   * 而源行只能定位到块起点，落点必然偏。
   */
  const body = bodyOf('layoutSignature')
  for (const field of ['fontFamily', 'monoLatin', 'contentWidth']) {
    assert.ok(body.includes(`theme.${field}`), `签名要含 ${field}`)
  }
  assert.doesNotMatch(body, /scrollHeight|getContentHeight/, '签名不能含内容高度')
})
