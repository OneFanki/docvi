/**
 * 传给宿主的参数必须先变成纯对象（`toPlain`）。
 *
 * 这条约束不是洁癖：Vue 的响应式对象是 Proxy，**跨 contextBridge 的第一次
 * 克隆**（渲染侧 → preload）就会抛 `An object could not be cloned.`。抛在
 * Electron 内部，渲染层只拿到一个 rejected promise；调用点若没接 catch，
 * 界面就是「点了按钮没反应」，控制台一行不打。
 *
 * 关键事实（2026-11-18 用真应用的分层实验确认，别再试着在 preload 里修）：
 *  - 同步方法 `pathsForFiles` 传 Proxy 同样抛错——它根本没走 IPC；
 *  - 所以卡点在 contextBridge 边界，preload 里的代码**还没执行**；
 *  - `structuredClone` 对 Proxy 抛错，但它抛错不代表参数有问题
 *    （普通对象里嵌一个 Proxy 也会抛），不能拿它当判据。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { reactive, toRaw } from 'vue'

import { toPlain } from '../../apps/desktop/src/renderer/src/lib/plain-request.ts'

test('普通对象原样往返，字段一个不少', () => {
  const input = { name: 'a.exe', url: 'https://x', size: 12, sha256: 'abc' }
  const out = toPlain(input)
  assert.deepEqual(out, input)
  assert.notEqual(out, input, '应当是新的副本，不是同一个引用')
})

test('剥掉 Vue 的响应式包装：克隆不再抛错', () => {
  /*
   * 这条是整个修复的核心。断言分两步：
   *  1. 未剥的响应式对象确实不可克隆（证明测试对象真的会触发缺陷）；
   *  2. 剥过之后可以克隆。
   * 只断言第 2 步会得出「toPlain 有用」的假结论——它可能对任何对象都成功。
   */
  const asset = reactive({ name: 'a.exe', url: 'https://x', sha256: 'abc' })
  assert.throws(() => structuredClone(asset), /could not be cloned/, '前置条件：响应式对象不可克隆')

  const plain = toPlain(asset)
  assert.doesNotThrow(() => structuredClone(plain), '剥过之后必须可克隆')
  assert.deepEqual(plain, toRaw(asset))
})

test('嵌套的响应式对象也一起剥掉', () => {
  /*
   * 外层的 asset 是普通对象、内层某个字段是响应式对象时，浅拷贝会漏掉内层。
   * JSON 往返看的是「值」，所以两层都能剥干净。
   */
  const nested = { asset: reactive({ url: 'https://x' }), version: '1.0.0' }
  assert.throws(() => structuredClone(nested), /could not be cloned/)

  const plain = toPlain(nested)
  assert.doesNotThrow(() => structuredClone(plain))
  assert.equal(plain.asset.url, 'https://x')
})

test('字符串、数字、null、undefined 原样返回', () => {
  assert.equal(toPlain('abc'), 'abc')
  assert.equal(toPlain(42), 42)
  assert.equal(toPlain(null), null)
  assert.equal(toPlain(undefined), undefined)
})

test('含 undefined 字段的对象：丢字段但不抛错', () => {
  /*
   * JSON 往返会丢掉值为 undefined 的键。对 IPC 参数来说这是正确行为——
   * undefined 本来也传不过结构化克隆的某些路径，缺字段由主进程的校验兜底。
   */
  const out = toPlain({ a: 1, b: undefined })
  assert.deepEqual(out, { a: 1 })
})

test('循环引用不抛异常，退回原值', () => {
  /*
   * 在这里抛会让全部调用点都必须处理一个几乎不会发生的分支；
   * 退回原值让主进程按自己的校验报出有意义的错误。
   */
  const cyclic = { name: 'a' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => toPlain(cyclic))
  assert.equal(toPlain(cyclic), cyclic, '剥不了就原样交回，不吞掉参数')
})
