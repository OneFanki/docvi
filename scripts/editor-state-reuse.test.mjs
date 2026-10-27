/**
 * 复用 `EditorState` 时必须换用新扩展。
 *
 * 用户报的现象：「切一次渲染模式之后，斜杠面板就不弹了」。
 *
 * 根因：`EditorState` 里装的是**旧配置**——`contextReporter` 的 onSlash /
 * onSelection、`onEditTable`、`onImageFiles`、`onChange` 全是旧组件实例的闭包。
 * 切视图后组件实例是新的，旧闭包仍写进已销毁实例的 ref：
 *  - 斜杠菜单永远不弹；
 *  - 气泡工具条不再更新；
 *  - 表格 / 图片的可视化入口点了没反应。
 *
 * 代码看起来完全正常（state 复用的写法毫无破绽），所以只能靠契约钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(
  new URL('../packages/editor/src/create-editor.ts', import.meta.url),
  'utf8',
)

test('复用状态必须经 StateEffect.reconfigure 换成新扩展', () => {
  assert.match(
    source,
    /reusable\.update\(\{\s*effects:\s*StateEffect\.reconfigure\.of\(extensions\)\s*\}\)/,
    '必须用 StateEffect.reconfigure 重配扩展：直接把旧 state 交给 EditorView 会沿用旧闭包',
  )
  assert.match(source, /StateEffect/, '需要从 @codemirror/state 引入 StateEffect')
})

test('新 EditorView 一律从 baseState 构造（不得有第二处直接用旧 state）', () => {
  assert.match(source, /const baseState = reusable\s*\?/, '应有统一的 baseState 收敛点')
  assert.match(
    source,
    /new EditorView\(\{\s*state:\s*baseState,\s*parent\s*\}\)/,
    'EditorView 必须吃 baseState',
  )
  assert.doesNotMatch(
    source,
    /\.\.\.\(reusable \? \{ state: reusable \} : \{ state: EditorState\.create/,
    '不得再把旧 state 直接展开进 EditorView 参数',
  )
})

test('状态复用的内容校验仍然保留（防止显示旧内容）', () => {
  assert.match(
    source,
    /options\.state\.doc\.toString\(\) === doc/,
    '卸载期间缓冲区可能被磁盘重载改过，复用前必须比对正文',
  )
})

test('重配只换扩展，不新建文档（撤销栈要活下来）', () => {
  const block =
    /reusable\s*\?\s*reusable\.update\([\s\S]*?\)\.state[\s\S]*?: EditorState\.create/.exec(source)
  assert.ok(block, '找不到 baseState 三元表达式')
  assert.doesNotMatch(
    block[0].split(': EditorState.create')[0] ?? '',
    /EditorState\.create/,
    '复用分支里不得重新 create 状态——那会丢掉 history',
  )
})
