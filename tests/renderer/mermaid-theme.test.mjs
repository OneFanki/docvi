/**
 * mermaid 主题映射（纯逻辑单测）。
 *
 * 钉住的契约：子图（cluster）标题文字色 titleColor 必须跟正文文字同源
 * （--dv-mermaid-text），绝不能跟子图背景 clusterBkg 同源。曾经 titleColor
 * 误绑到 --dv-mermaid-cluster-bg，flowchart 子图标题与自身背景同色而隐形
 * （明暗两套主题都中招），文档里只能靠逐个 subgraph 手写 style color 救场。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mermaidThemeVariables } from '../../packages/renderer-core/src/mermaid-theme.ts'

/** 用真实主题的深色取值做替身：正文近白、子图背景近黑，二者明显不同 */
function darkTokens(overrides = {}) {
  const tokens = {
    '--dv-mermaid-text': '#e8e5de',
    '--dv-mermaid-cluster-bg': '#171a1f',
    '--dv-mermaid-node-bg': '#1d2127',
  }
  return Object.assign(tokens, overrides)
}

test('titleColor 跟正文文字同源，与子图背景不同色', () => {
  const vars = mermaidThemeVariables(token => darkTokens()[token] ?? '')
  assert.equal(vars.titleColor, '#e8e5de', '标题文字色必须来自 --dv-mermaid-text')
  assert.equal(vars.clusterBkg, '#171a1f', '子图背景色必须来自 --dv-mermaid-cluster-bg')
})

test('回归：正文与子图背景取值不同时，标题色绝不等于子图背景色', () => {
  /*
   * 旧缺陷形态：titleColor 绑 --dv-mermaid-cluster-bg，导致两者相等 → 标题隐形。
   * 这条断言在旧绑定下必红，防止映射表再被改回去。
   */
  const vars = mermaidThemeVariables(token => darkTokens()[token] ?? '')
  assert.notEqual(vars.titleColor, vars.clusterBkg, '标题与背景同色 = 标题隐形')
})

test('浅色主题同样成立：近黑文字与近白背景', () => {
  const vars = mermaidThemeVariables(
    token =>
      ({
        '--dv-mermaid-text': '#1b1915',
        '--dv-mermaid-cluster-bg': '#faf8f3',
      })[token] ?? '',
  )
  assert.equal(vars.titleColor, '#1b1915')
  assert.notEqual(vars.titleColor, vars.clusterBkg)
})

test('token 缺失时不写入对应键', () => {
  const vars = mermaidThemeVariables(() => '')
  assert.equal('titleColor' in vars, false)
  assert.equal('clusterBkg' in vars, false)
})
