---
name: docs-plugin-base
description: docvi 通用组件包——写 Markdown 文档时插入流程图、状态机、代码走读、表设计、接口清单、合并单元格表格等 24 个视图。当你要为 docvi 文档站撰写或修改 Markdown 内容，或用户要求这些交互组件时使用。
---

# docvi 通用组件包（docs-plugin-base）

把 Markdown 目录变成可浏览/可搜索/可交互文档站（docvi 桌面应用 / 容器站点）的组件写法。
**24 个组件在一切宿主通用**（平台预设包，任何内容根都能用）。

## 用法（30 秒版）

1. 数据放页面 frontmatter 的 `components` 段（YAML），键名任意；
2. 每项用 `kind` 选组件（组件名的 kebab-case，如 `StateFlow` → `state-flow`），其余键与组件 props 同名、原样透传；
3. 正文用 `<at-kind data-key="键"></at-kind>` 引用——**必须闭合标签**、零 import、零 script。

```markdown
---
title: 订单状态机设计
components:
  orderFlow:
    kind: state-flow
    title: 订单状态机
    current: paid
    states:
      - { id: created, label: 已创建, kind: start }
      - { id: paid, label: 已支付 }
      - { id: done, label: 已完成, kind: end }
    transitions:
      - { from: created, to: paid, label: 支付成功 }
      - { from: paid, to: done, label: 完成 }
---

# 订单状态机设计

正文正常写 Markdown。组件在正文流中的位置直接引用：

<at-state-flow data-key="orderFlow"></at-state-flow>
```

## 硬规则（违反会解析失败或渲染成占位提示）

- `kind` = 下表组件名的 kebab-case；标签 = `at-` + `kind`；
- 标签必须闭合：`<at-xxx data-key="k"></at-xxx>`；`data-key` 指向 `components` 段的键，键不存在时原位显示占位提示（不白屏）；
- YAML 里含 `[]` `{}` `,` `:` 的标量**必须加引号**：`type: "decimal(10,2)"`——不加引号解析失败；
- 组件不包大段 Markdown：正文在组件之间流动，组件之间写正常 Markdown；
- 不要写颜色/主题样式（组件自动适配明暗），不要写 script。

## 组件速查（24 个）

| kind               | 用途                                                                       | 关键字段                                            |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------- |
| `tutorial-shell`   | 教程页页眉：课程名 + 第几步/共几步 + 学习目标（不渲染 H1）                 | `courseTitle` `step` `stepTotal` `goals`            |
| `flow-diagram`     | 有序流程（节点 + 带标注连线，点节点下钻）                                  | `nodes` `edges` `title`                             |
| `file-tree`        | 教学目录树 + 职责说明（可折叠）                                            | `data` `title`                                      |
| `call-tree`        | 调用树：谁调了谁（可折叠）                                                 | `data` `title`                                      |
| `code-walkthrough` | 分步代码讲解：行号 + 每步高亮 + 上一步/下一步                              | `code` `steps` `language` `filename` `source`       |
| `code-block`       | 普通代码块 + 文件名 + 出处徽标 + 一键复制                                  | `code` `filename` `source` `language` `lineNumbers` |
| `decision-card`    | 关键设计决策（决策 + 原因 + 证据；`kind: why/avoid`）                      | `decisions` `title`                                 |
| `checklist`        | 验收/自检清单（勾选 + 进度 + localStorage 记忆，用 `storageKey` 隔离）     | `items` `title` `storageKey`                        |
| `next-up`          | 下一步阅读卡（多目标 + 徽标）                                              | `items` `title`                                     |
| `api-contract`     | 模块输入/输出契约与不变量（教学向）                                        | `inputs` `outputs` `invariants` `title`             |
| `endpoint-list`    | HTTP 接口清单：默认折叠点击展开；支持非 HTTP（WS/EVENT/INTERNAL）          | `endpoints` `title`                                 |
| `table-tabs`       | 表设计：一表一页签（字段全量放这里）                                       | `tables` `relations` `title`                        |
| `table-graph`      | 表关系图：关键字段 + 外键连线（概览用）                                    | `tables` `relations` `title`                        |
| `evidence-note`    | 教学片段 ↔ 真实项目快照的证据关联卡                                        | `source` `snapshot` `teachingScope`                 |
| `debug-table`      | 按症状筛选的故障排查表                                                     | `rows` `filters` `severity`                         |
| `diff-view`        | 演进/重构 diff 视图（+/- 着色、统计、复制）                                | `diff` `title` `filename` `source`                  |
| `html-embed`       | 单文件 HTML 图解内嵌（sandbox iframe，零外部请求）                         | `html` `title` `height` `source`                    |
| `state-flow`       | 状态机流转图（分层布局 + 贝塞尔连线，`current` 高亮）                      | `states` `transitions` `current` `title`            |
| `message-flow`     | 可步进消息时序图（泳道 + 单步高亮）                                        | `participants` `messages` `title`                   |
| `metric-row`       | 指标卡组（数值 + 变化 + 语义色）                                           | `items` `title`                                     |
| `timeline`         | 竖向时间轴（时间 + 标题 + 状态色）                                         | `items` `title`                                     |
| `merged-table`     | **结构化块**：合并单元格表格（`::: merged` 里写 YAML，不走 components 段） | `title` `columns` `caption` `rows`                  |

## 合并单元格表格（`::: merged`）

唯一**不走 frontmatter + 标签**的组件：原生 Markdown 表达不了合并单元格，所以
数据放在围栏块里的 YAML，渲染成带 `rowspan` / `colspan` 的表格。Markdown 仍是
事实源——没用插件的阅读器也能看懂这段 YAML。

```markdown
::: merged
title: 发布节奏
columns: [阶段, 负责人, 状态]
caption: 阶段跨多行时用 rowspan 合并。
rows:

- [{ cell: 设计, rowspan: 2 }, 张三, 已完成]
- [李四, 进行中]
- [{ cell: 开发, rowspan: 2, head: true }, 王五, 已完成]
- [{ cell: 联调, colspan: 2 }, 未开始]
  :::
```

字段：`title`（可选，表格标题）· `columns`（可选，列名数组；缺省按最宽行推断）·
`caption`（可选，脚注）· `rows`（必填，行数组）。

单元格两种形态：标量（普通单元格），或对象
`{ cell, rowspan?, colspan?, align?, head? }`（`rowspan`/`colspan` 大于 1 才生效，
会被行数截断；`align` 为 `left|center|right`；`head` 渲染为 `th`）。

注意：起止标记都在行首（最多 3 个空格缩进），结束标记不带文字；容器内是 YAML
不是 Markdown（单元格里写不了粗体/链接）；**`rowspan` 合并后，后续行要跳过被
占住的列**——被合并的那一格在下面几行里不再出现。

## 场景 → 组件选择

- 讲一条主流程 → `flow-diagram`；讲状态怎么流转 → `state-flow`；讲谁调用谁 → `call-tree`；讲一次请求的时序 → `message-flow`；
- 给代码 → 需要分步讲解用 `code-walkthrough`，否则 `code-block`；讲「什么变了」→ `diff-view`；
- 讲表结构（全量字段）→ `table-tabs`；只讲表之间怎么连 → `table-graph`；接口清单 → `endpoint-list`；模块边界契约 → `api-contract`；
- 教学页眉 → `tutorial-shell`；结尾下一步 → `next-up`；验收 → `checklist`；排障 → `debug-table`；指标 → `metric-row`；时间线 → `timeline`。

## 数据形态要点

- `flow-diagram`：`nodes: [{ id, label, note?, kind?: start|step|decision|end }]`，`edges: [{ from, to, label? }]`；
- `state-flow`：`states: [{ id, label, note?, kind?: start|state|end|error }]`，`transitions: [{ from, to, label? }]`；
- `message-flow`：`participants: [{ id, label, note? }]`，`messages: [{ from, to, label, note?, kind?: call|return|async }]`；
- `table-tabs`：`tables: [{ name, cn?, note?, fields: [{ name, cn?, type?, key?, note? }] }]`，`key` 如 `PK`/`UK`/`FK`/`索引`；逐字段填 `cn` 与 `note`，不要裸罗列；
- `code-walkthrough`：`steps: [{ title, lines?: [1] 或 [[3,5]], note? }]`，行号必须与 `code` 实际行号一致（1-based 闭区间）；
- `timeline`：`items: [{ time, title, note?, status?: done|active|todo|warn }]`；
- `metric-row`：`items: [{ label, value, unit?, delta?, trend?: up|down|flat, tone?: good|bad|warn|neutral, note? }]`（方向与语义分开：耗时下降也是 `tone: good`）；
- `checklist`：`items: [字符串 或 { text, hint? }]`；`diff-view`：`diff` 为 unified diff 或手写 +/- 行文本。

## 需要完整 props 时

- 完整组件协议（全部组件的 props 与数据形态逐节详解）：仓库 `docs/architecture/组件协议.md`；
- 平台仓 `courses/component-showcase`：每个组件的活样例（`pnpm docvi:dev` 打开可视化核对）。
