import { computed, reactive } from 'vue'

import {
  collectComponentKeys,
  type InsertItem,
  type InsertPlan,
  planInsert,
} from './insert-plan.ts'

/**
 * 斜杠插入文件：把「要插入什么」和「插进去长什么样」收在一处。
 *
 * 两个分组是有意的：
 *  - **标准 Markdown**：产物是通用的 Markdown 语法，任何编辑器都能打开；
 *  - **富组件**：产物是本应用的声明式组件（frontmatter + `<at-*> 引用`），
 *    只有 docvi 能渲染成卡片。
 *
 * 用户必须在**插入前**就知道自己写的是哪一类。事后再用颜色区分是补救，
 * 而且不可发现——所以菜单本身分组并标注。
 *
 * 纯文本变更的计算在 insert-plan.ts（那里不依赖 Vue，可被 node 测试直接引用）。
 */

export type { InsertItem, InsertContext } from './insert-plan'

/* ---------- 标准 Markdown ---------- */

const heading = (level: number): InsertItem => ({
  id: `heading-${level}`,
  label: `${level} 级标题`,
  group: 'markdown',
  keywords: `heading h${level} 标题`,
  render: () => ({ text: `${'#'.repeat(level)} 标题\n`, cursorOffset: level + 1 }),
})

const MARKDOWN_ITEMS: InsertItem[] = [
  heading(1),
  heading(2),
  heading(3),
  {
    id: 'table',
    label: '表格',
    group: 'markdown',
    keywords: 'table 表格 grid',
    // 原生 Markdown 表格有网格编辑器（TableEditorDialog）：插进去点卡片上的「编辑表格」就能改
    form: true,
    render: () => ({
      text: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n',
      cursorOffset: 2,
    }),
  },
  {
    id: 'code',
    label: '代码块',
    group: 'markdown',
    keywords: 'code fence 代码',
    render: () => ({ text: '```\n\n```\n', cursorOffset: 4 }),
  },
  {
    id: 'quote',
    label: '引用',
    group: 'markdown',
    keywords: 'quote blockquote 引用',
    render: () => ({ text: '> 引用内容\n', cursorOffset: 2 }),
  },
  {
    id: 'list',
    label: '无序列表',
    group: 'markdown',
    keywords: 'bullet list ul 列表',
    render: () => ({ text: '- 列表项\n', cursorOffset: 2 }),
  },
  {
    id: 'ordered',
    label: '有序列表',
    group: 'markdown',
    keywords: 'ordered list ol 有序',
    render: () => ({ text: '1. 列表项\n', cursorOffset: 3 }),
  },
  {
    id: 'task',
    label: '任务清单',
    group: 'markdown',
    keywords: 'task todo checklist 任务 待办',
    render: () => ({ text: '- [ ] 待办项\n', cursorOffset: 6 }),
  },
  {
    id: 'hr',
    label: '分割线',
    group: 'markdown',
    keywords: 'hr divider 分割线 分隔',
    render: () => ({ text: '---\n' }),
  },
  {
    id: 'image',
    label: '图片',
    group: 'markdown',
    keywords: 'image img 图片',
    render: () => ({ text: '![描述](图片路径)\n', cursorOffset: 2 }),
  },
]

/* ---------- 富组件（声明式） ---------- */

interface ComponentSeed {
  kind: string
  label: string
  hint: string
  /**
   * 声明形式：
   *  - `component`（缺省）：frontmatter `components:` + 正文 `<at-kind data-key>`；
   *  - `container`：插件在 manifest 里声明的 `::: name` 容器，数据直接写在块内 YAML，
   *    不占 frontmatter。两者不能混用——渲染管线只认各自那一条路。
   */
  form?: 'component' | 'container'
  /** container 形式的语法名（manifest 里 `markdownSyntax[].name`，与组件 kind 不一定同名） */
  container?: string
  /** frontmatter 里 components 段的初始数据（YAML，按 4 空格缩进）；container 用 body */
  data?: string
  /** container 形式的块体（YAML，按 0 缩进，块标记由渲染器包） */
  body?: string
}

/**
 * 富组件种子数据。
 *
 * 只提供**最小可渲染骨架**：字段取各组件的必填项，其余留空让用户自己补。
 * 写多了反而变成「替用户编内容」，而且字段名写错会静默渲染成空卡片——
 * 这里的 key 必须与 `plugins/base/src/components/types.ts` 一致。
 */
const COMPONENT_SEEDS: ComponentSeed[] = [
  {
    kind: 'merged-table',
    label: '合并单元格表格',
    hint: '支持行/列合并，比标准表格更强',
    form: 'container',
    container: 'merged',
    body: 'title: 合并单元格表格\ncolumns: [阶段, 负责人, 状态]\nrows:\n- [{ cell: 设计, rowspan: 2 }, 张三, 已完成]\n- [李四, 进行中]\n- [王五, 未开始]\n',
  },
  {
    kind: 'flow-diagram',
    label: '流程图',
    hint: '分层自动布局，支持回边',
    data: '    title: 流程\n    nodes:\n      - { id: start, label: 开始 }\n      - { id: end, label: 结束 }\n    edges:\n      - { from: start, to: end }\n',
  },
  {
    kind: 'timeline',
    label: '时间线',
    hint: '按时间顺序的事件列表',
    data: '    title: 时间线\n    items:\n      - { time: 2026-01-01, title: 事件, note: 说明 }\n',
  },
  {
    kind: 'checklist',
    label: '检查清单',
    hint: '可勾选的自检清单，进度自动记忆',
    data: '    title: 检查清单\n    items:\n      - { text: 待办项 }\n',
  },
  {
    kind: 'decision-card',
    label: '决策卡',
    hint: '决策 / 原因 / 证据',
    data: '    title: 决策\n    decisions:\n      - { decision: 结论, reason: 为什么这样决定 }\n',
  },
  {
    kind: 'metric-row',
    label: '指标行',
    hint: '一排带趋势的关键指标',
    data: '    title: 指标\n    items:\n      - { label: 指标名, value: 0 }\n',
  },
  {
    kind: 'risk-list',
    label: '风险清单',
    hint: '风险 / 影响 / 当前处置',
    data: '    title: 风险\n    items:\n      - { risk: 风险描述, impact: 影响, handling: 当前处置 }\n',
  },
]

function nextKey(kind: string, used: string[]): string {
  const taken = new Set(used)
  if (!taken.has(kind)) return kind
  let index = 2
  while (taken.has(`${kind}-${index}`)) index += 1
  return `${kind}-${index}`
}

const COMPONENT_ITEMS: InsertItem[] = COMPONENT_SEEDS.map(seed => ({
  id: `component-${seed.kind}`,
  label: seed.label,
  hint: seed.hint,
  group: 'component',
  keywords: `component ${seed.kind} 组件`,
  render: ctx => {
    if (seed.form === 'container') {
      // 容器形式的组件不引用 frontmatter，整块数据自带；插入后光标放块体开头
      const open = `::: ${seed.container ?? seed.kind}\n`
      return { text: `${open}${seed.body ?? ''}:::\n`, cursorOffset: open.length }
    }
    const key = nextKey(seed.kind, ctx.usedKeys)
    // 组件数据进 frontmatter，正文只留一行引用——与本仓声明式写法完全一致
    return {
      text: `<at-${seed.kind} data-key="${key}"></at-${seed.kind}>\n`,
      cursorOffset: 0,
    }
  },
}))

/** 组件的 frontmatter 片段（由插入逻辑合并进文件头）；容器形式返回 null */
export function componentFrontmatter(item: InsertItem, usedKeys: string[]): string | null {
  const seed = COMPONENT_SEEDS.find(candidate => `component-${candidate.kind}` === item.id)
  if (!seed || seed.form === 'container') return null
  const key = nextKey(seed.kind, usedKeys)
  return `  ${key}:\n    kind: ${seed.kind}\n${seed.data ?? ''}`
}

/** 把「选中某个插入项」翻译成一次事务的文本变更（纯函数见 insert-plan.ts） */
export function buildInsertPlan(
  doc: string,
  item: InsertItem,
  from: number,
  to: number,
): InsertPlan {
  const usedKeys = collectComponentKeys(doc)
  return planInsert(doc, item, from, to, componentFrontmatter(item, usedKeys))
}

export const INSERT_ITEMS: InsertItem[] = [...MARKDOWN_ITEMS, ...COMPONENT_ITEMS]

/* ---------- 菜单状态（极小响应式容器，编辑器与宿主共用） ---------- */

export const slashMenu = reactive({
  open: false,
  query: '',
  /** 斜杠字符在文档里的区间：选中后整段替换 */
  from: 0,
  to: 0,
})

/**
 * 按 query 过滤并排序。
 *
 * 不能只做子串过滤：中文里「表」同时出现在「表格」和「列表」里，纯过滤会让
 * 用户输入两个键之后仍是四条候选平铺，「表格」未必在第一。这里按命中位置分三档：
 * 名称前缀 → 名称包含 → 仅关键词命中；同档保持声明顺序（标准 Markdown 在前）。
 */
export function filterItems(query: string): InsertItem[] {
  const term = query.trim().toLowerCase()
  if (!term) return INSERT_ITEMS
  const scored: Array<{ item: InsertItem; rank: number; index: number }> = []
  INSERT_ITEMS.forEach((item, index) => {
    const label = item.label.toLowerCase()
    if (label.startsWith(term)) scored.push({ item, rank: 0, index })
    else if (label.includes(term)) scored.push({ item, rank: 1, index })
    else if (item.keywords.toLowerCase().includes(term)) scored.push({ item, rank: 2, index })
  })
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return scored.map(entry => entry.item)
}

/** 分组展示用：把过滤结果按组切开，保持声明顺序 */
export function groupItems(items: InsertItem[]): Array<{
  group: 'markdown' | 'component'
  title: string
  items: InsertItem[]
}> {
  const order: Array<{ group: 'markdown' | 'component'; title: string }> = [
    { group: 'markdown', title: '标准 Markdown' },
    { group: 'component', title: '富组件' },
  ]
  return order
    .map(entry => ({ ...entry, items: items.filter(item => item.group === entry.group) }))
    .filter(entry => entry.items.length > 0)
}

export const slashState = computed(() => ({
  open: slashMenu.open,
  query: slashMenu.query,
}))
