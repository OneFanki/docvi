/**
 * 颜色字面量识别单测（scripts/lib/color-literal.mjs 直接跑）。
 * 口径：hex 3/4/6/8 位 + rgb/rgba/hsl/hsla 函数式命中；named 颜色与单位写法不认。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { colorLiteral } from './lib/color-literal.mjs'

test('hex 三/四/六/八位命中（含大写与前后空白）', () => {
  assert.equal(colorLiteral('#23845d'), '#23845d')
  assert.equal(colorLiteral('#FFF'), '#FFF')
  assert.equal(colorLiteral('#ffff'), '#ffff')
  assert.equal(colorLiteral('#C2413B'), '#C2413B')
  assert.equal(colorLiteral('#8f373488'), '#8f373488')
  assert.equal(colorLiteral('  #6750a4  '), '#6750a4')
})

test('hex 位数错误/缺井号不命中', () => {
  assert.equal(colorLiteral('23845d'), null)
  assert.equal(colorLiteral('#23845'), null)
  assert.equal(colorLiteral('#23845dd'), null)
  assert.equal(colorLiteral('#gggggg'), null)
  assert.equal(colorLiteral('#'), null)
})

test('函数式写法命中（rgb/rgba/hsl/hsla）', () => {
  assert.equal(colorLiteral('rgb(255, 0, 0)'), 'rgb(255, 0, 0)')
  assert.equal(colorLiteral('rgba(0,0,0,.5)'), 'rgba(0,0,0,.5)')
  assert.equal(colorLiteral('rgb(255 0 0 / 50%)'), 'rgb(255 0 0 / 50%)')
  assert.equal(colorLiteral('hsl(210, 50%, 40%)'), 'hsl(210, 50%, 40%)')
  assert.equal(colorLiteral('HSLA(210 50% 40% / 0.3)'), 'HSLA(210 50% 40% / 0.3)')
})

test('named 颜色与非法函数式不命中', () => {
  assert.equal(colorLiteral('red'), null)
  assert.equal(colorLiteral('orange'), null)
  assert.equal(colorLiteral('rgb(255,0)'), null, '参数不完整的函数式')
  assert.equal(colorLiteral('hsl(210deg 50% 40%)'), null, '单位写法（deg）保守不认')
  assert.equal(colorLiteral('var(--app-color-primary)'), null)
  assert.equal(colorLiteral('linear-gradient(90deg, red, blue)'), null)
  assert.equal(colorLiteral('color'), null)
})

test('长度上限与非法输入', () => {
  assert.equal(colorLiteral(`#${'a'.repeat(50)}`), null)
  assert.equal(colorLiteral(''), null)
  assert.equal(colorLiteral('   '), null)
  assert.equal(colorLiteral(null), null)
  assert.equal(colorLiteral(42), null)
})
