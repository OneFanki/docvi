/**
 * 斜杠插入规划的回归测试。
 *
 * 富组件插入要同时改文件头（frontmatter）与正文引用。位置算错会把
 * `<at-*>` 引用塞进 YAML 里——那是**静默的数据损坏**，肉眼很难发现，
 * 只有再打开文件时才会看到一片解析错误。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { planInsert, collectComponentKeys, componentInsertion, insertedBlockRange } =
  await import('../apps/desktop/src/renderer/src/lib/insert-plan.ts')

const plainItem = {
  id: 'table',
  label: '表格',
  hint: '',
  group: 'markdown',
  keywords: '',
  render: () => ({ text: 'TABLE', cursorOffset: 2 }),
}

const richItem = {
  id: 'component-timeline',
  label: '时间线',
  hint: '',
  group: 'component',
  keywords: '',
  render: ctx => ({
    text: `<at-timeline data-key="${ctx.usedKeys[0] ?? 'x'}"></at-timeline>`,
    cursorOffset: 0,
  }),
}

test('标准项：原地替换斜杠区间，光标落在 block 内偏移', () => {
  const doc = '# t\n\n/表'
  const plan = planInsert(doc, plainItem, 4, 6, null)
  assert.equal(plan.changes.length, 1)
  assert.deepEqual(plan.changes[0], { from: 4, to: 6, insert: 'TABLE' })
  assert.equal(plan.caretAfter, 4 + 2)
})

test('无文件头时插入富组件：新建 frontmatter 并把引用写在头之后', () => {
  const doc = '/time'
  const plan = planInsert(doc, richItem, 0, 5, '  timeline:\n    kind: timeline\n')
  assert.equal(plan.changes.length, 2)
  const [header, body] = plan.changes
  assert.equal(header.from, 0)
  assert.ok(header.insert.startsWith('---\ncomponents:\n'))
  assert.deepEqual(body, { from: 0, to: 5, insert: '<at-timeline data-key="x"></at-timeline>' })
  // 光标坐标要跳过新增的文件头，否则会落进 YAML
  assert.ok(plan.caretAfter >= header.insert.length)
})

test('已有 components 段：新条目插在该段下，不重开一节', () => {
  const doc = '---\ncomponents:\n  a:\n    kind: x\ntitle: t\n---\n\n/ti'
  const insertion = componentInsertion(doc, '  b:\n    kind: y\n')
  const before = doc.slice(0, insertion.at)
  const after = doc.slice(insertion.at)
  assert.ok(before.endsWith('components:\n'))
  assert.equal(insertion.insert, '  b:\n    kind: y\n')
  assert.ok(after.startsWith('  a:\n    kind: x\ntitle: t'))
  // 结果必须仍是合法 YAML 层级：新键与既有键同级、都在 components 下
  const text = before + insertion.insert + after
  assert.ok(text.includes('components:\n  b:\n    kind: y\n  a:\n    kind: x\n'))
})

test('有文件头但无 components 段：整段补在 frontmatter 末尾', () => {
  const doc = '---\ntitle: t\n---\n\nbody'
  const insertion = componentInsertion(doc, '  b:\n    kind: y\n')
  const text = doc.slice(0, insertion.at) + insertion.insert + doc.slice(insertion.at)
  assert.ok(text.includes('title: t\ncomponents:\n  b:\n    kind: y\n---'))
})

test('CRLF 文档插入时沿用 CRLF', () => {
  const doc = '---\r\ntitle: t\r\n---\r\n\r\nbody'
  const insertion = componentInsertion(doc, '  b:\n    kind: y\n')
  assert.ok(!/[^\r]\n/.test(insertion.insert), '插入片段里出现了裸 LF')
})

test('collectComponentKeys 只认 components 段内的两级键', () => {
  const doc = '---\ncomponents:\n  a:\n    kind: x\n  b:\n    kind: y\ntitle: t\n---\n'
  assert.deepEqual(collectComponentKeys(doc), ['a', 'b'])
  assert.deepEqual(collectComponentKeys('没有文件头'), [])
})

/* ---------- 斜杠菜单的结构与标记 ---------- */

const menu = await import('../apps/desktop/src/renderer/src/lib/insert-menu.ts')

test('第一行是基础 Markdown，其余每行一个增强组件', () => {
  const markdown = menu.INSERT_ITEMS.filter(item => item.group === 'markdown')
  const components = menu.INSERT_ITEMS.filter(item => item.group === 'component')
  assert.ok(markdown.length >= 5, '第一行基础 Markdown 项不应过少')
  assert.ok(components.length >= 3, '增强组件不应过少')
  // 分组顺序决定菜单结构：基础项必须排在最前（同组内保持声明顺序）
  const firstComponent = menu.INSERT_ITEMS.findIndex(item => item.group === 'component')
  const lastMarkdown = menu.INSERT_ITEMS.map(i => i.group).lastIndexOf('markdown')
  assert.ok(lastMarkdown < firstComponent, '基础 Markdown 必须全部排在组件之前')
})

test('表格声明支持表单编辑，富组件一律没有', () => {
  const table = menu.INSERT_ITEMS.find(item => item.id === 'table')
  assert.ok(table, '缺少表格插入项')
  assert.equal(table.form, true, '表格有网格编辑器，必须标记 form: true')

  for (const item of menu.INSERT_ITEMS.filter(i => i.group === 'component')) {
    assert.notEqual(item.form, true, `增强组件 ${item.label} 目前没有表单编辑，不应标 form`)
  }
})

test('每个增强组件都有说明文案，供条目标题右侧展示', () => {
  for (const item of menu.INSERT_ITEMS.filter(i => i.group === 'component')) {
    assert.ok(item.hint && item.hint.length > 0, `组件 ${item.label} 缺少 hint`)
  }
})

test('insertedBlockRange：区间不含结尾换行，回写不会把表格与下一段粘连', () => {
  /*
   * 实测缺陷：斜杠插入表格后直接打开网格编辑器，保存时用 `to: from + 插入长度`
   * 整段替换。插入文本以换行结尾，而 serializeTable 的产物不带换行——回写后
   * 表格最后一行会和后面那段文字并成一行，Markdown 结构当场坏掉。
   */
  const doc = '正文\n\n/table\n'
  const tableItem = {
    id: 'table',
    label: '表格',
    group: 'markdown',
    keywords: '',
    render: () => ({ text: '| a | b |\n| --- | --- |\n|  |  |\n', cursorOffset: 2 }),
  }
  const plan = planInsert(doc, tableItem, 4, 10, null)
  const range = insertedBlockRange(plan)
  assert.ok(range, '标准项也要能算出行内块区间')
  assert.equal(range.text, '| a | b |\n| --- | --- |\n|  |  |', '区间文本必须是去掉结尾换行的原文')
  assert.equal(range.to - range.from, range.text.length)
  // 区间落在新文档里，且右边界正好是插入块最后一行的行尾
  const applied = '正文\n\n' + plan.changes.at(-1).insert
  assert.equal(applied.slice(range.from, range.to), range.text)
  assert.equal(applied[range.to], '\n', '右边界之后应当还是换行，而不是下一段的正文')
})

test('insertedBlockRange：富组件插入时，区间要跨过新写入的文件头', () => {
  const plan = planInsert('正文\n', richItem, 3, 3, 'timeline:\n  kind: timeline')
  const range = insertedBlockRange(plan)
  assert.ok(range)
  // 拼接出应用变更后的新文档，区间必须正好落在 <at-*> 引用上
  const fmInsert = plan.changes[0].insert
  const next = fmInsert + '正文\n' + plan.changes[1].insert
  assert.equal(next.slice(range.from, range.to), range.text)
  assert.match(range.text, /^<at-timeline/)
})

/* ---------- 块独立性（分割线不能贴上一行） ---------- */

test('分割线紧贴上一行文字时自动补空行', () => {
  const doc = '# 标题\n正文\n/hr'
  const hrItem = {
    id: 'hr',
    label: '分割线',
    group: 'markdown',
    keywords: '',
    needsBlankBefore: true,
    render: () => ({ text: '---\n' }),
  }
  const plan = planInsert(doc, hrItem, 7, 10, null)
  assert.equal(plan.changes.length, 1)
  assert.equal(plan.changes[0]?.insert, '\n---\n')
})

test('前面已经是空行时不重复补', () => {
  const doc = '# 标题\n\n/hr'
  const hrItem = {
    id: 'hr',
    label: '分割线',
    group: 'markdown',
    keywords: '',
    needsBlankBefore: true,
    render: () => ({ text: '---\n' }),
  }
  const plan = planInsert(doc, hrItem, 6, 9, null)
  assert.equal(plan.changes[0]?.insert, '---\n')
})

test('文档开头插入分割线不补空行', () => {
  const doc = '/hr'
  const hrItem = {
    id: 'hr',
    label: '分割线',
    group: 'markdown',
    keywords: '',
    needsBlankBefore: true,
    render: () => ({ text: '---\n' }),
  }
  const plan = planInsert(doc, hrItem, 0, 3, null)
  assert.equal(plan.changes[0]?.insert, '---\n')
})

test('补的空行不计入块区间（否则回写会粘连上一行）', () => {
  const hrItem = {
    id: 'hr',
    label: '分割线',
    group: 'markdown',
    keywords: '',
    needsBlankBefore: true,
    render: () => ({ text: '---\n' }),
  }
  const doc = '正文\n/hr'
  const plan = planInsert(doc, hrItem, 3, 6, null)
  const range = insertedBlockRange(plan)
  assert.ok(range)
  assert.equal(range.text, '---')
  // 区间起点必须在补出来的空行之后
  assert.equal(range.from, 3 + 1)
})

test('不需要独立成块的项不加空行', () => {
  const doc = '正文\n/表'
  const plan = planInsert(doc, plainItem, 3, 5, null)
  assert.equal(plan.changes[0]?.insert, 'TABLE')
})
