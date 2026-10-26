# 项目设计文档

> 本目录存放 docvi 自身的设计说明（面向 AI 与维护者）。
> 产品定位、自研壳迁移决策、内容根协议等完整决策见
> `docs/design/平台自研壳与多宿主迁移.md` 与
> `docs/design/文档平台部署与多仓库管理.md`，本目录只记录**落到代码上的约定**。

## 仓库结构

```text
apps/desktop/          # 唯一渲染层 + 桌面宿主（Electron）
├── src/main/          # 主进程：窗口 / 托盘 / IPC / git / 文件操作 / 服务托管
├── src/preload/       # contextBridge 白名单桥（window.docvi）
├── src/renderer/src/  # Vue 3 UI（App.vue + components/ + stores/ + lib/）
├── src/service/       # 服务进程：MCP / 临时分享 / 检索语料（可独立运行）
└── vite.web.config.ts # 容器版产物 dist-web（纯静态 + 同源 HTTP）
packages/
├── shared/            # 进程间契约：IPC 通道 / DocviApi / 设置 / 类型
├── renderer-core/     # Markdown 管线：渲染、插件块扫描、高亮、mermaid、主题样式
├── editor/            # CodeMirror 6（Live Preview / 源码 / 分屏）
├── plugin-api/        # 插件协议类型
├── plugin-runtime/    # 插件清单校验与容器
└── server/            # 服务层（纯 Node）：MCP / 分享 / 语料 / HTTP 原语
plugins/base/          # 通用组件包（协议 v1：plugin.json + src/ + docs/SKILL.md；产物 dist/）
courses/               # 平台自带示例内容根（含 docs.config.yaml）
deployer/              # 容器化部署器（git 编排 + 索引刷新队列 + 站点服务）
scripts/
├── docs-config.mjs    # docs.config.yaml 解析与归一化 / 目标判定 / 聚合合并
├── scan-docs.mjs      # 目录树扫描（递归 + 图标标记 + 排序）
├── build-docs-index.mjs # 索引生成器（tree.json + search-index.json，唯一实现）
├── check-links.mjs    # 死链报告
└── dev/web-shot.mjs   # 容器版验收截图（headless Edge + CDP）
docs/architecture/     # 本文档 + 组件协议.md（完整 props）
```

## 运行方式

两种宿主共用同一份渲染层，差别只在 `window.docvi` 由谁提供：

- **桌面**：`pnpm docvi:dev`（Electron + Vite 热更新）；preload 提供 `window.docvi`。
- **容器**：`docker compose up`；浏览器里由 `lib/web-host.ts` 把 deployer 的 HTTP 协议接成
  同一套 `window.docvi`，`lib/web-router.ts` 负责 `/<仓库>/<文档>` 的 SPA 路由。

内容根下的 `docs.config.yaml` 决定树根节点（`sidebar`）、排除项（`exclude`）、静态目录（`staticDirs`）、
顶部导航（`nav`）与死链策略（`deadLinks`）；**平台侧缺配置一律失败并给模板，绝不静默扫描**。

内容服务协议（桌面走 IPC，容器走 HTTP；两端同一份协议语义）：

| 端点                         | 语义                                                 |
| ---------------------------- | ---------------------------------------------------- |
| `GET /api/portal`            | 仓库清单（容器门户与分支选择器的数据源）             |
| `GET /api/tree`              | 目录树清单（tree.json 形态，含 version/title/roots） |
| `GET /api/search-index`      | 搜索索引（minisearch 导出，容器直接查询）            |
| `GET /docs/<slug>/<path>.md` | 文档原文（含 frontmatter，渲染在客户端；防穿越）     |
| `GET /*`                     | 站点资产 → 内容根静态文件 → history fallback         |

约定：

- 内容根静态资产（图片等）在容器里由 `/<仓库>/…` 前缀伺服，渲染时通过 `urlPrefix` 补段；
- staticDirs（自包含 HTML）由内容服务直出，不渲染不进树。

## 目录树（`scan-docs.mjs`）

扫描规则与产出的节点形态：

| 情况                                                 | 产出                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| 目录有落地页（`index.md` → `索引.md` → `README.md`） | `text` 带 `data-kind="doc"` 图标标记 + `link`（可跳转、可选中）      |
| 目录无落地页                                         | `text` 带 `data-kind="group"` 图标标记、无 `link`（点击只展开/收起） |
| 普通文档                                             | `text` 带 `data-kind="leaf"` 占位（不显示图标，保证文字左对齐）      |

要点：

- 图标不是 HTML 元素而是**标记占位**：树节点渲染时按类型给 `dir` / `doc` 与是否有 `landing`
  决定图标组件，颜色取 `currentColor`，自动跟随 hover/选中态。
- 排序：`(frontmatter order 升序, 名称自然序)`；目录的排序键取它自己的落地页。
- 折叠：顶层默认展开（`collapsed: false`），嵌套目录默认折叠；展开态箭头朝下、折叠态朝右。
- 落地页文件不再重复出现为子节点。
- **父节点（有落地页的目录）本身可选中**：打开其落地页时整行高亮，与叶子文档同一套 is-active；
  纯分组不参与高亮，仅祖先链文字加深（has-active）。

## 样式分层

三处各管一层，互不重复：

- `packages/renderer-core/src/styles/theme.css`：design token（`--dv-*`），UI 与文档主题的唯一色彩来源；
  插件主题只覆盖变量，因此天然跟随明暗与自定义主题。
- `packages/renderer-core/src/styles/doc.css`：正文排版（标题梯度 / 表格 / custom-block /
  代码块 shiki 双主题 / 引用块 / mermaid 容器）。
- `apps/desktop/src/renderer/src/styles/base.css`：窗口级 reset 与滚动条，最后加载、可覆盖前两者。

**加载顺序有依赖，不能乱**：theme.css → doc.css → base.css。
新增视觉常量只允许写进 token（圆角 `--dv-ui-radius-*`、动效 `--dv-ui-dur-*` + `--dv-ui-ease`），
散落的字面量正是「观感不精致」的源头。

## 组件协议

所有交互组件：

- 只消费 `--at-*` token（不写死颜色/圆角/阴影），明暗模式由 `.dark` 覆盖；
- **声明式数据驱动**：frontmatter `components` 段 + 正文 `<at-组件名 data-key="键">`，
  由渲染层按 kind 查注册表点亮（业务零 JS）；组件定义来自预设包 `plugins/base`，
  随渲染层一起构建（协议 v1，见 `docs/design/平台插件化与 AI 分发.md`）；
- 数据由作者静态定义，不读本机真实文件、不依赖本机路径；
- 类型定义随组件包（`plugins/base/src/components/types.ts`）。

**完整 props 与数据协议见 [组件协议.md](组件协议.md)，每个组件的活用法见演示内容
`courses/component-showcase`——首页「内建组件清单」汇总全部通用组件与演示入口。**

当前**通用**组件（24 个，不绑定业务域）：

| 组件                | 用途                                                              | 关键 props                                                  |
| ------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `<TutorialShell>`   | 页内壳：标题 + 第几步/共几步 + 学习目标                           | `courseTitle` `step` `stepTotal` `goals`                    |
| `<FileTree>`        | 静态教学目录树 + 职责说明                                         | `data` `title`                                              |
| `<CallTree>`        | 调用树：函数调函数的层层展开                                      | `data` `title`                                              |
| `<CodeWalkthrough>` | 代码片段：行号 + 分步高亮 + 上一步/下一步                         | `code` `steps` `language` `title` `filename` `source`       |
| `<FlowDiagram>`     | 有序业务流程（节点 + 带标注连线）                                 | `nodes` `edges` `title`                                     |
| `<CodeBlock>`       | 代码块：文件名 + 出处徽标 + 复制                                  | `code` `filename` `source` `title` `language` `lineNumbers` |
| `<DecisionCard>`    | 关键设计决策（决策 + 原因 + 证据）                                | `decisions` `title`                                         |
| `<Checklist>`       | 验收 / 自检清单（可勾选、记忆进度）                               | `items` `title` `storageKey`                                |
| `<NextUp>`          | 下一步阅读卡                                                      | `items` `title`                                             |
| `<ApiContract>`     | 模块输入 / 输出契约与不变量                                       | `inputs` `outputs` `title`                                  |
| `<EndpointList>`    | HTTP 接口清单：默认折叠 + 按需展开契约详情（方法筛选 / 退役标记） | `endpoints` `title`                                         |
| `<TableGraph>`      | 表关系图：分层表卡 + 外键连线                                     | `tables` `relations` `title`                                |
| `<TableTabs>`       | 表设计唯一组件：一表一页签（限高 + 全屏）+ 表间关系脚注           | `tables` `relations` `title`                                |
| `<EvidenceNote>`    | 教学片段 ↔ 项目快照的证据关联卡                                   | `source` `snapshot` `teachingScope`                         |
| `<DebugTable>`      | 按症状筛选的故障排查表                                            | `rows` `title`                                              |
| `<DiffView>`        | 只保留讲清变化行的 diff                                           | `diff` `title` `filename` `source`                          |
| `<HtmlEmbed>`       | 自包含单文件 HTML 图解（sandbox iframe）                          | `src`/`html` `title` `height`                               |
| `<StateFlow>`       | 状态机视图（状态卡 + 出边）                                       | `states` `transitions` `current` `title`                    |
| `<MessageFlow>`     | 可步进消息时序图                                                  | `participants` `messages` `title`                           |
| `<MetricRow>`       | 指标卡组（数值 + 变化 + 语义色）                                  | `items` `title`                                             |
| `<Timeline>`        | 竖向时间轴                                                        | `items` `title`                                             |
| `<ChangeList>`      | 本次改动清单：编号 + 说明 + 涉及模块徽标（新增/变更/移除）        | `items` `title`                                             |
| `<RiskList>`        | 已知风险：严重度 + 影响 + 处置（已处理 / 待独立处理）             | `items` `title`                                             |
| `<MergedTable>`     | 合并单元格表格（`:merged` 容器内写 YAML，Markdown 仍是事实源）    | `columns` `rows` `title` `caption`                          |

## 写教程内容

教程不需要任何特殊配置——把章节按 `01-`/`02-` 命名放进目录，树里就有序展开；需要"这一节有落地页"就给目录放
`index.md`（或 `索引.md`）。

1. 目录里放 `index.md` 作为该主题主页（可选，但放了目录节点就可点击）；
2. 章节 Markdown 头部用 H1 作标题（树里显示的就是它），正文按固定阅读顺序：整体认知 → 主流程 →
   分层与模块职责 → 目录 → 核心实现 → 契约 → 省略 → 下一步；
3. 需要代码讲解时：把代码作为字符串放进 frontmatter `components` 数据（旧 `?raw` 引入可用
   `scripts/migrate-declarative.mjs` 一次性迁移），标签写 `<at-code-walkthrough data-key="…">`，
   **steps 的行号必须与代码字符串的实际行号一致**（改代码后同步改）；
4. 预览：`pnpm docvi:dev`（桌面）或起容器站点（见 `README.md`）。

## 组件演进（待办）

- `<FileTree>`/`<FlowDiagram>` 支持从 JSON/YAML 文件读取（data loader）；
- 音频/示例类 live demo 组件；

## 已验证

- `pnpm verify` 全链通过（格式 / lint / 组件与 app 类型 / 构建 / 单测 / 文案 / 文档 / 依赖方向 / 敏感内容）；
- 容器站点实测：headless Edge 走「首页 → 进仓库 → 切文档 → 浏览器后退 → 深链刷新 → 命令面板」，零控制台错误；
- deployer 端到端：本地仓添加 → 索引刷新 → 挂载 → 站点服务 → 内容变更刷新即见（AC5）；
- 布局/侧栏/正文档位与老站逐像素对账（同视口实测）；移动端抽屉、明暗切换、聚合模式实测。
