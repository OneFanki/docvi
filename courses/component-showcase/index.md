# 内建组件清单

平台内建 **24 个通用组件**（不绑定任何业务域，任何内容根可直接用），已在主题里全局注册——Markdown 正文直接写标签即可，无需 import。本页只回答三个问题：**有哪些组件、各自干什么、演示在哪**。

- 完整 props 与数据协议：仓库 `docs/architecture/组件协议.md`（内容撰写会话以它 + 本页 + 演示章节为活参考）
- 源码：`plugins/base/src/components/`，每个组件文件顶部 JSDoc 有用法摘要

## 组件一览

| 组件 | 用途 | 关键 props | 演示 |
| --- | --- | --- | --- |
| `<TutorialShell>` | 页内壳：课程名 + 第几步/共几步 + 学习目标 | `courseTitle` `step` `stepTotal` `goals` | 各章页首 |
| `<FlowDiagram>` | 有序业务流程（节点 + 带标注连线，点节点下钻） | `nodes` `edges` `title` | [01 章](chapters/01-主流程与目录) |
| `<FileTree>` | 静态教学目录树 + 职责说明（可折叠） | `data` `title` | [01 章](chapters/01-主流程与目录) |
| `<CallTree>` | 调用树：函数调函数的层层展开（可折叠） | `data` `title` | [01 章](chapters/01-主流程与目录) |
| `<CodeWalkthrough>` | 代码片段：行号 + 分步高亮 + 上一步/下一步 | `code` `steps` `language` `filename` `source` | [01 章](chapters/01-主流程与目录) |
| `<CodeBlock>` | 代码块：文件名 + 出处徽标 + 一键复制 | `code` `filename` `source` `language` `lineNumbers` | [02 章](chapters/02-讲解与自检) |
| `<DecisionCard>` | 关键设计决策（决策 + 原因 + 证据） | `decisions` `title` | [02 章](chapters/02-讲解与自检) |
| `<ChangeList>` | 本次改动清单：编号 + 说明 + 涉及模块徽标（可标新增 / 变更 / 移除） | `items` `title` | [02 章](chapters/02-讲解与自检) |
| `<RiskList>` | 已知风险：严重度 + 影响 + 当前处置（区分已处理 / 待独立处理） | `items` `title` | [02 章](chapters/02-讲解与自检) |
| `::: merged` | 合并单元格表格（结构化块：YAML 描述 rowspan/colspan，不走 components 段） | `title` `columns` `caption` `rows` | [03 章](chapters/03-契约与数据模型) |
| `<Checklist>` | 验收 / 自检清单（可勾选、进度条、localStorage 记忆） | `items` `title` `storageKey` | [02 章](chapters/02-讲解与自检) |
| `<NextUp>` | 下一步阅读卡（多目标，带徽标） | `items` `title` | [02 章](chapters/02-讲解与自检) |
| `<ApiContract>` | 模块输入 / 输出契约与不变量 | `inputs` `outputs` `invariants` `title` | [03 章](chapters/03-契约与数据模型) |
| `<EndpointList>` | HTTP 接口清单：默认折叠（方法 / 路径 / 职责 / 门槛），点击展开契约详情；含方法筛选与退役标记 | `endpoints` `title` | [03 章](chapters/03-契约与数据模型) |
| `<TableGraph>` | 表关系图：分层表卡（关键字段）+ 外键连线，悬停高亮链路（替代会绞线的 mermaid erDiagram） | `tables` `relations` `title` | [03 章](chapters/03-契约与数据模型) |
| `<TableTabs>` | 表设计：一表一页签（限高 + 全屏）+ 表间关系脚注 | `tables` `relations` `title` | [03 章](chapters/03-契约与数据模型) |
| `<EvidenceNote>` | 教学片段 ↔ 项目快照的证据关联卡 | `source` `snapshot` `teachingScope` | [03 章](chapters/03-契约与数据模型) |
| `<DebugTable>` | 按症状筛选的故障排查表（tag / 严重级别维度） | `rows` `filters` `severity` | [03 章](chapters/03-契约与数据模型) |
| `<DiffView>` | 演进 / 重构视图：只保留讲清变化行的 diff（+/− 着色、增删统计） | `diff` `title` `filename` `source` | [04 章](chapters/04-演进与图解) |
| `<HtmlEmbed>` | 自包含单文件 HTML 图解（sandbox iframe，零外部请求） | `html` / `src` `title` `height` | [04 章](chapters/04-演进与图解) |
| `<StateFlow>` | 状态机视图：状态卡 + 每个状态的出边（可高亮当前） | `states` `transitions` `current` `title` | [05 章](chapters/05-状态时序与指标) |
| `<MessageFlow>` | 可步进消息时序图（参与者泳道 + 单步高亮） | `participants` `messages` `title` | [05 章](chapters/05-状态时序与指标) |
| `<MetricRow>` | 指标卡组（数值 + 变化 + 语义色） | `items` `title` | [05 章](chapters/05-状态时序与指标) |
| `<Timeline>` | 竖向时间轴（时间 + 标题 + 状态色） | `items` `title` | [05 章](chapters/05-状态时序与指标) |

## 通用约定

- **全局注册**：正文直接写 `<at-组件名 data-key="键"></at-组件名>`；组件不包大段 Markdown。
- 页面数据放 frontmatter 的 `components` 段（`kind` 决定组件、其余键与组件 props 同名）；代码 / 片段以字符串承载在数据里。
- 样式只消费 `--at-*` token，明暗模式自动适配。
- 必填点：`CodeWalkthrough` 漏 `steps`、`ApiContract` 漏 `outputs` 会在渲染层报缺参。

## 演示章节

| 章节 | 覆盖组件 |
| --- | --- |
| [01 · 主流程与目录](chapters/01-主流程与目录) | FlowDiagram / FileTree / CallTree / CodeWalkthrough |
| [02 · 讲解与自检](chapters/02-讲解与自检) | CodeBlock / DecisionCard / Checklist / NextUp |
| [03 · 契约、数据模型与证据](chapters/03-契约与数据模型) | ApiContract / EndpointList / TableGraph / TableTabs / EvidenceNote / DebugTable |
| [04 · 演进与图解](chapters/04-演进与图解) | DiffView / HtmlEmbed |
| [05 · 状态、时序与指标](chapters/05-状态时序与指标) | StateFlow / MessageFlow / MetricRow / Timeline |

## 怎么打开本页

```bash
cd docvi   # 平台仓库
pnpm docvi:dev        # 缺省内容根 courses/，左侧树「内建组件」
```

本页属于平台自带内容根（`courses/`）——内容根换成业务仓或知识库时不出现在树里。写内容时的用法：本页选组件 → 对应演示章节复制 frontmatter 数据段与标签 → 替换成自己的数据。
