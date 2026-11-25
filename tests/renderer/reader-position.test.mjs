/**
 * 阅读位置恢复的策略选择。
 *
 * 这些用例覆盖的是「切标签先回顶再闪回去」那个缺陷的三条成因，每条对应
 * 一个决策分支。策略是纯函数，所以判据能在这里穷举；真实应用里只能靠抓帧观察。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseRestoreStrategy,
  positionTrustworthy,
} from '../../apps/desktop/src/renderer/src/lib/reader-position.ts'

/** 默认：排版未变、位置可信、非早期 —— 最理想的情况 */
const base = {
  topLine: 120,
  scrollY: 3400,
  layoutKey: 'sans|mono|820',
  currentLayoutKey: 'sans|mono|820',
  early: false,
}

test('排版未变且位置可信 → 像素（块级源行会差几十像素）', () => {
  assert.equal(chooseRestoreStrategy(base), 'pixel')
})

test('早期落位一律用源行：正文刚插入 DOM，高度还在长，像素会被截断', () => {
  assert.equal(chooseRestoreStrategy({ ...base, early: true }), 'source')
})

test('早期落位即使排版变了也用源行（高度未稳定的前提下像素更不可信）', () => {
  assert.equal(
    chooseRestoreStrategy({ ...base, early: true, currentLayoutKey: 'serif|sans|720' }),
    'source',
  )
})

test('排版签名变化 → 源行：整篇高度重排过，旧像素值失效', () => {
  assert.equal(chooseRestoreStrategy({ ...base, currentLayoutKey: 'serif|sans|720' }), 'source')
})

test('从未记录过排版签名 → 源行（旧会话文件没有这个字段）', () => {
  assert.equal(chooseRestoreStrategy({ ...base, layoutKey: '' }), 'source')
})

test('源行不可信时退回像素：没有更好的坐标系', () => {
  assert.equal(chooseRestoreStrategy({ ...base, topLine: -1 }), 'pixel')
  assert.equal(chooseRestoreStrategy({ ...base, topLine: -1, early: true }), 'pixel')
})

test('topLine 为 0 但像素不在顶部 → 不可信（老会话把「不知道」存成 0）', () => {
  assert.equal(positionTrustworthy({ topLine: 0, scrollY: 1200 }), false)
  assert.equal(chooseRestoreStrategy({ ...base, topLine: 0, scrollY: 1200 }), 'pixel')
})

test('topLine 为 0 且像素也在顶部 → 可信，用户确实就在开头', () => {
  assert.equal(positionTrustworthy({ topLine: 0, scrollY: 0 }), true)
  assert.equal(chooseRestoreStrategy({ ...base, topLine: 0, scrollY: 0 }), 'pixel')
})

test('早期落位 + topLine 为 0 且在顶部 → 仍走源行（落位到开头是正确的）', () => {
  assert.equal(chooseRestoreStrategy({ ...base, topLine: 0, scrollY: 0, early: true }), 'source')
})

test('判据优先级固定：早期 > 排版签名 > 源行 > 像素', () => {
  // 早期且排版已变：早期优先
  assert.equal(chooseRestoreStrategy({ ...base, early: true, currentLayoutKey: 'x' }), 'source')
  // 非早期、排版变了、源行可信：源行
  assert.equal(chooseRestoreStrategy({ ...base, currentLayoutKey: 'x' }), 'source')
  // 非早期、排版变了、源行不可信：像素兜底
  assert.equal(chooseRestoreStrategy({ ...base, currentLayoutKey: 'x', topLine: -1 }), 'pixel')
})
