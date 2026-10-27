/**
 * 实时预览交互的可点击性契约。
 *
 * 用户报的两个问题都属于「看得见但点不动」：
 *  1. **待办项勾选框点不了**——CM6 的装饰部件默认 `ignoreEvent() === true`，
 *     部件里的 mousedown 被编辑器当成「非编辑器事件」丢掉，点击处理器永远收不到；
 *  2. **点表格只是把光标放进块里**——表格是有结构的内容，点它的意图就是改它。
 *
 * 这类缺陷跑不出来（没有异常、DOM 也正确），只能在源码层钉住交互契约。
 * 真实点击行为在 `.temp/harness/` 的 CDP 脚本里验证。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../packages/editor/src/live-preview.ts', import.meta.url),
  'utf8',
)
const css = readFileSync(
  new URL('../packages/editor/src/styles/editor.css', import.meta.url),
  'utf8',
)

test('勾选框部件必须让事件冒泡给 CM6（ignoreEvent 返回 false）', () => {
  const body = /class TaskBoxWidget[\s\S]*?\n}\n/.exec(source)?.[0] ?? ''
  assert.ok(body, '找不到 TaskBoxWidget')
  assert.match(
    body,
    /ignoreEvent\(\): boolean \{\s*return false;?\s*\}/,
    'TaskBoxWidget 的 ignoreEvent 必须返回 false',
  )
})

test('勾选框点击必须改写文档里的 [ ] / [x]（状态真相在原文）', () => {
  assert.match(source, /function taskBoxClickHandler/, '缺少勾选框点击处理器')
  const body = /function taskBoxClickHandler[\s\S]*?\n}\n/.exec(source)?.[0] ?? ''
  assert.match(body, /insert: checked \? '\[ \]' : '\[x\]'/, '点击要切换方框状态')
  assert.match(body, /view\.dispatch\(/, '点击必须派发事务改文档')
})

test('勾选框可交互样式与会话可达性', () => {
  const rule = /\.cm-lp-taskbox\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.ok(rule, '找不到 .cm-lp-taskbox 样式')
  assert.match(rule, /cursor:\s*pointer/, '勾选框要有可点击的手型光标')
})

test('点击表格块直接交给网格编辑器（不是把光标放进块里）', () => {
  assert.match(source, /function tableBlockClickHandler/, '缺少表格块点击处理器')
  const body = /function tableBlockClickHandler[\s\S]*?\n}\n/.exec(source)?.[0] ?? ''
  assert.match(body, /onEdit\(\{/, '点击表格要触发编辑回调')
  assert.match(body, /preventDefault\(\)/, '必须拦下默认行为，否则光标会先进块')
  // 区间由 widget 在建立装饰时写进 DOM：posAtDOM 反推在缩进 / 相邻块时会算错
  assert.match(body, /dataset\.tableFrom/, '区间必须从 DOM 的 dataset 读')
  assert.match(
    source,
    /wrapper\.dataset\.tableSource = this\.source/,
    'widget 要把原文写进 dataset',
  )
})

test('图片块整块可点开弹窗', () => {
  const body = /if \(this\.imageEdit\)[\s\S]*?\n {4}\}/.exec(source)?.[0] ?? ''
  assert.ok(body, '找不到图片块的点击绑定')
  assert.match(body, /closest\('img'\)/, '点图片本体也要打开弹窗')
  assert.match(
    body,
    /wrapper\.addEventListener\('mousedown'/,
    '图片块要监听 mousedown（click 阶段部件已销毁）',
  )
})

test('点击触发区限定在表格本体（块的留白要留给「插入正文」）', () => {
  /*
   * 用户报：「表格的上下都会有空白的地方，点击后触发的是表格弹窗，
   * 但我可能只是想往表格后面插入文本内容」。
   * 块的上下留白是块间距（`.cm-lp-block` 的 padding），不是表格的一部分。
   */
  const body = /function tableBlockClickHandler[\s\S]*?\n}\n/.exec(source)?.[0] ?? ''
  assert.match(
    body,
    /closest\('\.cm-lp-block--table table'\)/,
    '必须以「表格元素之内」为触发条件，不能用整个块 wrapper',
  )
  assert.doesNotMatch(
    body,
    /closest<HTMLElement>\('\.cm-lp-block--table'\)\s*\n\s*if \(!wrapper\) return false/,
    '不能让块 wrapper 本身成为触发条件（留白点击会误开弹窗）',
  )
})

test('编辑按钮定位在块内（出块会被滚动容器裁掉）', () => {
  /*
   * 用户报：「表格右上角会被标题栏的按钮遮挡」。
   * 实测：块贴到视口顶部时，按钮 top = -270 而滚动容器 top = 83。
   * 根因是 `top: -9px` 把按钮浮到块外——块级 Widget 的记账只算自身盒尺寸，
   * 浮出去那部分不进入高度，滚到视口顶端就落在可视区之外。
   */
  const tableBtn = /\.cm-lp-table-edit\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.ok(tableBtn, '找不到 .cm-lp-table-edit 样式')
  const top = /top:\s*(-?\d+)px/.exec(tableBtn)
  assert.ok(top, '按钮缺少 top 声明')
  assert.ok(Number(top[1]) >= 0, `按钮 top 必须非负（当前 ${top[1]}px，出块会被裁掉）`)

  const imageBtn = /\.cm-lp-image-edit\s*\{[^}]*\}/.exec(css)?.[0] ?? ''
  const imageTop = /top:\s*(-?\d+)px/.exec(imageBtn)
  assert.ok(imageTop && Number(imageTop[1]) >= 0, '图片按钮同理，top 必须非负')

  // 按钮占的那条横带必须由块体让出来，否则会压住表头/图片
  assert.match(
    css,
    /\.cm-lp-block--table \.cm-lp-block__body\s*\{[^}]*padding-top:\s*\d+px/,
    '表格块体要留出顶部横带给按钮',
  )
})

test('输入法冻结只做位置映射，不清空装饰（清空会让文档高度塌陷 → 跳顶）', () => {
  /*
   * 用户报：「输入斜杠时没切中英文，输入了顿号，但会导致页面跳转到顶部」。
   * 根因：组合输入期间冻结实现返回 `Decoration.none`，块级 Widget 全部消失，
   * 文档高度骤降，scrollTop 被夹到 0。
   */
  const body =
    /return StateField\.define<DecorationValue>\(\{[\s\S]*?\n {2}\}\)/.exec(source)?.[0] ?? ''
  assert.ok(body, '找不到 decorationField 的 StateField 定义')
  assert.doesNotMatch(
    body,
    /frozen[\s\S]{0,120}Decoration\.none/,
    '冻结分支不得返回 Decoration.none（会让块级 Widget 消失、高度塌陷）',
  )
  assert.match(body, /frozen:\s*true/, '冻结标记必须写进字段值（粘性，跨整个组合期）')
  assert.match(
    body,
    /value\.decorations\.map\(tr\.changes\)/,
    '冻结期间必须对现有装饰做位置映射，而不是重建或清空',
  )
})
