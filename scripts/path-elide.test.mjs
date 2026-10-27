/**
 * 状态栏路径截断的回归测试。
 *
 * 用户报「底部小窗口下会乱，其实路径是可以优先显示后面的部分的，前面可以显示
 * 省略」。规则本身不难，但错法很隐蔽：CSS 的 `direction: rtl` 取巧会把中性的
 * 斜杠按 RTL 重排（`docs/` 渲染成 `/docs`），所以这里直接算字符串。
 *
 * 断言的是**输出契约**：给定宽度与字宽，结尾必须是文件名、前部可以省略、
 * 放得下时一字不改。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { fitPathTail } = await import('../apps/desktop/src/renderer/src/lib/path-elide.ts')

/** 固定字宽测量：每个字符 10px，让期望值可手算 */
const measure = value => value.length * 10

test('放得下时原样返回（不做无意义截断）', () => {
  const text = 'docs/guide/intro.md'
  assert.equal(fitPathTail(text, 1000, measure), text)
})

test('放不下时保留尾部：文件名词不丢', () => {
  // 可用 120px → 12 个字符预算（含省略号占 1 个）
  const text = 'a/very/deep/nested/folder/readme.md'
  const result = fitPathTail(text, 120, measure)
  assert.ok(result.startsWith('…'), `应以省略号开头：${result}`)
  assert.ok(result.endsWith('readme.md'), `必须以完整文件名结尾：${result}`)
  assert.ok(measure(result) <= 120, `不得超出可用宽度：${result} = ${measure(result)}px`)
})

test('截断点落在分隔符上时补一个斜杠，读起来仍像路径', () => {
  const result = fitPathTail('aaa/bbb/ccc/ddd.md', 130, measure)
  assert.ok(result.startsWith('…/'), `应以「…/」开头：${result}`)
  assert.ok(result.endsWith('ddd.md'), result)
})

test('宽度极窄时仍保留最小尾部，不退化成只有一个省略号', () => {
  const result = fitPathTail('some/long/path/file.md', 15, measure)
  assert.ok(result.length > 1, `不能只剩省略号：${JSON.stringify(result)}`)
  assert.ok(result.startsWith('…'), result)
})

test('零/负宽度返回省略号，不抛错', () => {
  assert.equal(fitPathTail('a/b.md', 0, measure), '…')
  assert.equal(fitPathTail('a/b.md', -50, measure), '…')
})

test('空路径返回空串（状态栏没有文档时不显示占位）', () => {
  assert.equal(fitPathTail('', 200, measure), '')
})

test('真实中文长路径：文件名完整、宽度不超', () => {
  const text = '/临时文件夹/前端功能文档-数据货架/数据货架-前端功能文档.md'
  const width = 300
  const result = fitPathTail(text, width, measure)
  assert.ok(result.endsWith('数据货架-前端功能文档.md'), result)
  assert.ok(measure(result) <= width, `${result} = ${measure(result)}px`)
  assert.ok(result.startsWith('…'), result)
})

test('不含分隔符的长文件名：只能从前面切，尾部仍完整', () => {
  const text = 'a-very-long-file-name-without-any-slashes.md'
  const result = fitPathTail(text, 200, measure)
  assert.ok(result.endsWith('.md'), result)
  assert.ok(result.startsWith('…'), result)
  assert.ok(measure(result) <= 200, result)
})
