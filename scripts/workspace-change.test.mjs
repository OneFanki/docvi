/**
 * 目录变化批次的归类规则（纯函数回归测试）。
 *
 * 用户的要求是「AI 写代码时要像 VS Code 一样实时看到」。这条链路里最容易出错
 * 的不是 IO，而是**这批路径到底影响谁**：
 *  - 判宽了：每 400ms 把整库文档重读一遍、目录树整棵重扫；
 *  - 判窄了：AI 新建的文件永远不出现在侧栏，或者某篇已打开的文档停在旧内容。
 *
 * 两种错都不报错，只是慢或者「看起来没反应」，所以规则必须由测试钉住。
 *
 * 另外两组：主进程监视器的排除规则（`.git` 抖动不能算内容变化）与路径等价
 * （Windows 大小写 / 正反斜杠）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { affectsDocument, affectsTree } =
  await import('../apps/desktop/src/renderer/src/lib/workspace-change.ts')
const { isContentRelPath } = await import('../apps/desktop/src/main/content.ts')

/* ---------- affectsDocument：哪些已打开文档要重读 ---------- */

test('精确命中：只影响这一篇', () => {
  assert.equal(affectsDocument('指南/入门.md', ['指南/入门.md']), true)
  assert.equal(affectsDocument('指南/入门.md', ['指南/进阶.md']), false)
})

test('祖先目录被改名/移动：其下所有文档都受影响', () => {
  assert.equal(affectsDocument('指南/入门.md', ['指南']), true)
  assert.equal(affectsDocument('指南/子目录/入门.md', ['指南/子目录']), true)
})

test('同名前缀不算祖先：指南-old 不是 指南 的子路径', () => {
  assert.equal(affectsDocument('指南/入门.md', ['指南-old']), false)
})

test('末段相似但不是同一篇：入门.md 与 入门2.md 互不影响', () => {
  assert.equal(affectsDocument('指南/入门.md', ['指南/入门2.md']), false)
})

test('Windows 路径：大小写与分隔符差异仍判为同一篇', () => {
  assert.equal(affectsDocument('Guide/Intro.md', ['guide\\intro.md']), true)
})

test('平台没给文件名（空批次 / 空串）：保守判为全部受影响', () => {
  assert.equal(affectsDocument('指南/入门.md', []), true)
  assert.equal(affectsDocument('指南/入门.md', ['']), true)
})

test('批次里混有无关路径：只要有命中就算受影响', () => {
  assert.equal(affectsDocument('指南/入门.md', ['图片/a.png', '指南/入门.md']), true)
})

/* ---------- affectsTree：要不要重扫目录树 ---------- */

test('新建 Markdown 文件：树要重扫', () => {
  assert.equal(affectsTree(['指南/新增.md']), true)
  assert.equal(affectsTree(['新增.md']), true)
})

test('新建目录（无扩展名）：树要重扫', () => {
  assert.equal(affectsTree(['指南/新目录']), true)
})

test('图片 / 附件写入：树里本来没有它，不必重扫', () => {
  assert.equal(affectsTree(['assets/图.png']), false)
  assert.equal(affectsTree(['指南/数据.json']), false)
  assert.equal(affectsTree(['a.png', 'b.jpg']), false)
})

test('docs.config.yaml 决定树结构：要重扫', () => {
  assert.equal(affectsTree(['docs.config.yaml']), true)
})

test('平台没给文件名：无法判断，保守重扫', () => {
  assert.equal(affectsTree([]), true)
  assert.equal(affectsTree(['']), true)
})

/* ---------- isContentRelPath：监视器的排除口径 ---------- */

test('.git / node_modules 里的写入不算内容变化（git status 会刷这些）', () => {
  assert.equal(isContentRelPath('.git/index'), false)
  assert.equal(isContentRelPath('.git/refs/heads/main'), false)
  assert.equal(isContentRelPath('node_modules/vue/index.js'), false)
})

test('深层的素材/产物目录同样排除', () => {
  assert.equal(isContentRelPath('docs/node_modules/x/y.md'), false)
  assert.equal(isContentRelPath('docs/assets/图.png'), false)
})

test('普通文档与目录算内容变化', () => {
  assert.equal(isContentRelPath('指南/入门.md'), true)
  assert.equal(isContentRelPath('指南'), true)
})

test('点开头的文件是合法文档，不能按「点开头目录」排除', () => {
  assert.equal(isContentRelPath('.draft.md'), true)
  assert.equal(isContentRelPath('指南/.hidden.md'), true)
  // 但点开头目录下的内容仍要排除
  assert.equal(isContentRelPath('.obsidian/workspace.json'), false)
})

test('平台没给文件名（空串）：保守上报', () => {
  assert.equal(isContentRelPath(''), true)
})
