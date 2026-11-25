import { computed, reactive } from 'vue'

import { planInsert, type InsertItem, type InsertPlan } from './insert-plan.ts'

/**
 * 斜杠插入文件：把「要插入什么」和「插进去长什么样」收在一处。
 *
 * 只收标准 Markdown：产物在任何编辑器里都能打开。交互式图解走正文里的
 * `<iframe src="./x.html" sandbox="allow-scripts">`（见 docs/engineering/内容写法.md），
 * 那是作者手写的一段 HTML，不占斜杠菜单。
 *
 * 纯文本变更的计算在 insert-plan.ts（那里不依赖 Vue，可被 node 测试直接引用）。
 */

export type { InsertItem, InsertContext } from './insert-plan'

/** 把「选中某个插入项」翻译成一次事务的文本变更（纯函数见 insert-plan.ts） */
export function buildInsertPlan(
  doc: string,
  item: InsertItem,
  from: number,
  to: number,
): InsertPlan {
  return planInsert(doc, item, from, to)
}

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
    // 不预填「待办项」：用户要的是空格子直接写自己的事，先删再写是纯多余动作。
    // 光标落在方框之后，敲字即是这一项的内容。
    render: () => ({ text: '- [ ] \n', cursorOffset: 6 }),
  },
  {
    id: 'hr',
    label: '分割线',
    group: 'markdown',
    keywords: 'hr divider 分割线 分隔',
    // 紧贴上一行文字会变成 setext 标题下划线，必须独立成块
    needsBlankBefore: true,
    render: () => ({ text: '---\n' }),
  },
  {
    id: 'image',
    label: '图片',
    group: 'markdown',
    keywords: 'image img 图片 粘贴 拖拽',
    // 插入的是打开图片弹窗的占位块：可视化选择文件 / 本地路径 / 网络地址
    form: true,
    render: () => ({ text: '![]()\n', cursorOffset: 2 }),
  },
]

export const INSERT_ITEMS: InsertItem[] = [...MARKDOWN_ITEMS]

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

/**
 * 分组展示用。
 *
 * 现在只剩标准 Markdown 一组，但菜单仍按「组 → 项」渲染：将来若要加回第二类
 * 插入物（比如模板片段），只在这里加一组即可，组件与样式不用改结构。
 */
export function groupItems(items: InsertItem[]): Array<{
  group: 'markdown'
  title: string
  items: InsertItem[]
}> {
  return [{ group: 'markdown', title: '标准 Markdown', items }]
}

export const slashState = computed(() => ({
  open: slashMenu.open,
  query: slashMenu.query,
}))
