/**
 * 实时预览「隐藏语法」的守卫。
 *
 * 本轮把行内标记（`#`、`**`、反引号、`-`、`>`、链接地址）改成**任何时刻都不显示**，
 * 与飞书的手感一致。这条改动带一个必须同时成立的约束：标记看不见以后，光标
 * 不能停在标记**内部**——用户会以为自己站在正文里，敲字却把字符插进了 `**` 之间，
 * 原文被静默改坏，屏幕上看不出任何异常。
 *
 * 单测只做源码级断言，不引编辑器运行时：`packages/editor` 用了 TS 参数属性，
 * Node 的 strip-only 类型擦除跑不动它（`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）。
 * 真实行为的验收在 `pnpm verify` 之外的 CDP 脚本里（真窗口里右移/左移各一次）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../packages/editor/src/live-preview.ts', import.meta.url),
  'utf8',
)

test('行内标记的隐藏无条件生效（不再看光标行）', () => {
  // hide() 里出现 lineHasCursor 就意味着「光标行又露出 # 了」
  const hideBody = /const hide = \(from: number, to: number\): void => \{([\s\S]*?)\n {2}\}/.exec(
    source,
  )
  assert.ok(hideBody, '找不到 hide() 实现')
  assert.ok(!hideBody[1].includes('lineHasCursor'), 'hide() 不得按光标行放开标记')
})

test('被藏掉的标记登记为原子区间', () => {
  assert.match(
    source,
    /const atoms: Array<\{ from: number; to: number; decoration: Decoration \}>/,
    '应收集原子区间',
  )
  assert.match(source, /atoms\.push\(\{ from, to, decoration \}\)/, 'hide() 必须同时登记原子区间')
  assert.match(
    source,
    /EditorView\.atomicRanges\.of\(/,
    '必须提供 atomicRanges，否则光标能落进隐藏标记',
  )
})

test('样式始终生效（光标行不再跳过）', () => {
  const styleBody =
    /const style = \(from: number, to: number, className: string\): void => \{([\s\S]*?)\n {2}\}/.exec(
      source,
    )
  assert.ok(styleBody, '找不到 style() 实现')
  assert.ok(!styleBody[1].includes('lineHasCursor'), 'style() 不得按光标行跳过样式')
})

test('块级替换仍保留光标守卫（否则块内无法编辑）', () => {
  const blockBody =
    /const block = \(from: number, to: number, kind: string, source: string, extra\?: string\): void => \{([\s\S]*?)\n {2}\}/.exec(
      source,
    )
  assert.ok(blockBody, '找不到 block() 实现')
  assert.ok(
    blockBody[1].includes('rangeHasCursor(from, to)'),
    '块级替换必须保留光标守卫——块被完全替换后没有可落脚的可编辑位置',
  )
})

test('装饰字段同时提供 decorations 与 atoms', () => {
  assert.match(
    source,
    /EditorView\.decorations\.from\(field, value => value\.decorations\)/,
    'decorations 应从字段值取',
  )
  assert.match(
    source,
    /atomicRanges\.of\(view => view\.state\.field\(field, false\)\?\.atoms/,
    'atoms 应从同一字段取',
  )
})
