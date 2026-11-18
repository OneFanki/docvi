/**
 * 性能埋点的上限与裁剪不变量。
 *
 * 用户对这个功能提了两条硬要求：「不要疯狂写盘」「数据大小要限制」。
 * 这两条都不是靠代码审查能守住的——它们全是**边界行为**：
 * 第一次超出上限、文件损坏、detail 被塞进整篇文档……所以逐条钉住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PERF_FILE_MAX_BYTES,
  PERF_KEPT_LIMIT,
  PERF_TEXT_MAX,
  clampText,
  mergeBounded,
  normalizeSample,
  pushBounded,
  trimToBytes,
} from '../../packages/shared/src/perf.ts'

const sample = (overrides = {}) => ({
  at: 1_700_000_000_000,
  kind: 'render',
  ms: 120,
  scene: 'reader:render',
  ...overrides,
})

test('pushBounded 超出上限时丢最旧的，保留最新的', () => {
  const buffer = []
  for (let index = 0; index < 10; index += 1) pushBounded(buffer, index, 4)
  assert.deepEqual(buffer, [6, 7, 8, 9], '必须保留最新四条，否则诊断时看到的是昨天的现场')
})

test('pushBounded 在上限内不丢任何东西', () => {
  const buffer = []
  pushBounded(buffer, 'a', 3)
  pushBounded(buffer, 'b', 3)
  assert.deepEqual(buffer, ['a', 'b'])
})

test('mergeBounded 合并历史与新增后仍受上限约束', () => {
  const history = ['h1', 'h2', 'h3']
  const incoming = ['n1', 'n2', 'n3']
  assert.deepEqual(mergeBounded(history, incoming, 4), ['h3', 'n1', 'n2', 'n3'])
})

test('mergeBounded 上限为 0 时返回空数组，不返回全部', () => {
  assert.deepEqual(mergeBounded(['a'], ['b'], 0), [])
})

test('trimToBytes 在超预算时从最旧一端开始丢', () => {
  const items = Array.from({ length: 100 }, (_, index) => ({
    at: index,
    // 每条约 100 字节
    padding: 'x'.repeat(100),
  }))
  const kept = trimToBytes(items, 2000)
  assert.ok(kept.length > 0, '不能裁剪到一条都不剩')
  assert.ok(JSON.stringify(kept).length <= 2000, `实际 ${JSON.stringify(kept).length} 字节`)
  // 保留的必须是尾部（最新的），不是头部
  assert.equal(kept[kept.length - 1].at, 99, '最新一条必须在结果里')
  assert.ok(kept[0].at > 0, '最旧的应该被丢掉')
})

test('trimToBytes 在预算内时原样返回', () => {
  const items = [sample(), sample()]
  assert.deepEqual(trimToBytes(items, PERF_FILE_MAX_BYTES), items)
})

test('trimToBytes 遇到单条就超预算时返回空数组而不是超限', () => {
  const huge = [{ padding: 'x'.repeat(5000) }]
  assert.deepEqual(trimToBytes(huge, 1000), [], '宁可丢光也不能写出超过上限的文件')
})

test('trimToBytes 空数组不抛异常', () => {
  assert.deepEqual(trimToBytes([], 100), [])
})

test('clampText 截断超长文本并加省略号', () => {
  const long = 'a'.repeat(PERF_TEXT_MAX + 50)
  const clamped = clampText(long)
  assert.equal(clamped.length, PERF_TEXT_MAX)
  assert.ok(clamped.endsWith('…'))
})

test('clampText 不动短文本', () => {
  assert.equal(clampText('短标题'), '短标题')
})

test('normalizeSample 把非有限数归零（否则 JSON 会写出 null）', () => {
  const normalized = normalizeSample(sample({ ms: Number.NaN, at: Number.POSITIVE_INFINITY }))
  assert.equal(normalized.ms, 0)
  assert.equal(normalized.at, 0)
  assert.equal(JSON.stringify(normalized).includes('null'), false)
})

test('normalizeSample 削掉超长 scene', () => {
  const normalized = normalizeSample(sample({ scene: 'x'.repeat(500) }))
  assert.ok(normalized.scene.length <= 60, `实际 ${normalized.scene.length}`)
})

test('normalizeSample 限制 detail 的键数，防止被塞进整篇文档', () => {
  const detail = {}
  for (let index = 0; index < 30; index += 1) detail[`k${index}`] = index
  const normalized = normalizeSample(sample({ detail }))
  assert.ok(Object.keys(normalized.detail ?? {}).length <= 6)
})

test('normalizeSample 削掉超长 detail 值', () => {
  const normalized = normalizeSample(sample({ detail: { title: 'y'.repeat(500), blocks: 451 } }))
  assert.ok(String(normalized.detail?.title).length <= 40)
  assert.equal(normalized.detail?.blocks, 451, '数字原样保留')
})

test('normalizeSample 对小数做一位四舍五入，控制文件体积', () => {
  const normalized = normalizeSample(sample({ ms: 123.456, detail: { ratio: 12.3456 } }))
  assert.equal(normalized.ms, 123)
  assert.equal(normalized.detail?.ratio, 12.3)
})

test('normalizeSample 在没有 detail 时不写空对象', () => {
  const normalized = normalizeSample(sample())
  assert.equal('detail' in normalized, false, '空对象会白白占几十字节 JSON')
})

test('PERF_KEPT_LIMIT 与 PERF_FILE_MAX_BYTES 都是有限正数', () => {
  /*
   * 这两个常量是「数据大小有上限」这条要求的落点。若被改成 0 或 Infinity，
   * 上限就不存在了——而那正是最容易被顺手改错的地方。
   */
  assert.ok(Number.isFinite(PERF_KEPT_LIMIT) && PERF_KEPT_LIMIT > 0)
  assert.ok(Number.isFinite(PERF_FILE_MAX_BYTES) && PERF_FILE_MAX_BYTES > 0)
  assert.ok(PERF_FILE_MAX_BYTES <= 1024 * 1024, '埋点文件不该超过 1MB')
})
