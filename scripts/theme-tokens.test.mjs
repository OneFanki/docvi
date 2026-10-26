/**
 * 主题 token 继承关系的回归测试（读 theme.css 源码，不启浏览器）。
 *
 * 背景：主题统一成单一维度后，插件主题可以只覆盖局部变量（例如只改正文配色）。
 * 未声明的变量必须从「**同明暗**的内置主题」继承，否则一个 appearance=light 的
 * 插件主题会拼出「浅色正文 + 深色窗口」的半截外观——这正是本轮要消除的问题。
 *
 * 实现手段是给每组主题选择器都挂一个 `[data-appearance]` 基底分支。这些选择器
 * 一旦被谁改掉（比如合并、重排），继承就会静默失效，页面不会报错，只会突然变丑，
 * 所以用断言钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(
  new URL('../packages/renderer-core/src/styles/theme.css', import.meta.url),
  'utf8',
)

/** 取某个变量声明的全部行 */
function declaredValues(name) {
  return css.split('\n').filter(line => line.includes(`${name}:`))
}

/**
 * 取某个内置主题的**全部**变量名。
 *
 * 一套主题分布在三个节里（UI / 文档 / 编辑器），每节各有一个选择器组；
 * 因此要遍历文件里所有该 marker 出现的位置，而不是只取第一处。
 */
function themeVariables(id) {
  const marker = `:root[data-theme='${id}']`
  const names = new Set()
  let from = 0
  for (;;) {
    const start = css.indexOf(marker, from)
    if (start < 0) break
    const open = css.indexOf('{', start)
    const end = css.indexOf('}', open)
    if (open < 0 || end < 0) break
    for (const match of css.slice(open + 1, end).matchAll(/(--dv-[a-z0-9-]+)\s*:/g)) {
      names.add(match[1])
    }
    from = end
  }
  return names
}

/** 内置主题清单：与 stores/app.ts 的 BUILTIN_KEYS 同集合 */
const BUILTIN_THEMES = ['graphite', 'paper', 'slate', 'mist']

test('每套内置主题都声明了完整的一套变量（不能只覆盖一半）', () => {
  /*
   * 为什么必须完整：内置主题块不带 `data-appearance` 兜底，缺哪个变量那块区域
   * 就落到 `:root` 的深色默认值。只写 UI 不写正文的浅色主题会拼出
   * 「白色窗口 + 深色正文」，而且页面不报任何错。
   */
  const baseline = themeVariables('graphite')
  assert.ok(baseline.size > 40, `graphite 变量数量异常：${baseline.size}`)
  for (const id of BUILTIN_THEMES) {
    const vars = themeVariables(id)
    assert.ok(vars.size > 0, `找不到主题 ${id} 的变量块`)
    const missing = [...baseline].filter(name => !vars.has(name))
    assert.deepEqual(missing, [], `主题 ${id} 缺少变量：${missing.join('、')}`)
  }
})

test('三层主题变量在每套内置主题与明暗基底里都有声明', () => {
  /*
   * 声明块数 = 内置主题数：graphite 与 data-appearance='dark' 共用一个选择器组，
   * paper 与 'light' 共用另一个，其余主题各自一块。少于这个数说明某套主题漏了
   * 一整个变量组（不是漏一条，是整组没写）。
   */
  for (const name of ['--dv-ui-bg', '--dv-doc-bg', '--dv-ed-bg']) {
    const values = declaredValues(name)
    assert.equal(
      values.length,
      BUILTIN_THEMES.length,
      `${name} 应有 ${BUILTIN_THEMES.length} 条声明（每套主题一块），实际 ${values.length} 条`,
    )
  }
})

test('每组主题选择器都带同明暗的 data-appearance 基底分支', () => {
  // 只数「块级」选择器（`{` 结尾），shiki 那两条是后代选择器，不算一层
  const darkBases = css.match(/:root\[data-appearance='dark'\]\s*\{/g) ?? []
  const lightBases = css.match(/:root\[data-appearance='light'\]\s*\{/g) ?? []
  assert.equal(darkBases.length, 3, '深色基底应覆盖 UI / 文档 / 编辑器三处')
  assert.equal(lightBases.length, 3, '浅色基底应覆盖 UI / 文档 / 编辑器三处')
})

test('浅色块写在深色块之后（同权重时后者生效）', () => {
  const darkAt = css.indexOf(":root[data-appearance='dark']")
  const lightAt = css.indexOf(":root[data-appearance='light']")
  assert.ok(darkAt > 0 && lightAt > 0, '两个基底都应存在')
  assert.ok(lightAt > darkAt, '浅色基底必须排在深色之后，否则插件浅色主题会拿到深色值')
})

test('不再残留已废弃的维度属性选择器', () => {
  assert.doesNotMatch(css, /data-editor-theme/, '编辑器不该再有独立主题属性')
  assert.doesNotMatch(css, /\.doc-surface\[data-doc-theme/, '文档不该再有独立主题属性')
})

test('UI 尺度与动效别名有定义（缺了会让圆角/过渡静默失效）', () => {
  for (const name of [
    '--dv-ui-radius-sm',
    '--dv-ui-radius-md',
    '--dv-ui-radius-lg',
    '--dv-ui-dur-1',
    '--dv-ui-dur-2',
    '--dv-ui-ease',
    '--dv-ui-ok',
  ]) {
    assert.match(css, new RegExp(`${name}:\\s*var\\(--dv-`), `${name} 缺少别名定义`)
  }
})

test('插件主题覆盖三层：只声明部分层的主题会拼出半截外观', () => {
  const sea = JSON.parse(
    readFileSync(new URL('../plugins/base/themes/sea.json', import.meta.url), 'utf8'),
  )
  const prefixes = ['--dv-ui-', '--dv-doc-', '--dv-ed-']
  for (const prefix of prefixes) {
    const count = Object.keys(sea).filter(key => key.startsWith(prefix)).length
    assert.ok(count >= 10, `${prefix}* 只有 ${count} 个变量，不足以构成一套完整主题`)
  }
  // UI 层必须覆盖到「会直接显示在窗口上」的那几项，缺一项就会出现拼色
  for (const key of ['--dv-ui-bg', '--dv-ui-surface-1', '--dv-ui-text', '--dv-ui-accent']) {
    assert.ok(key in sea, `缺少 ${key}`)
  }
})
