# 项目设计文档

> 本目录存放 docvi 自身的设计说明（面向 AI 与维护者）。
> 产品定位与架构决策见 `docs/architecture/adr/`，本目录只记录**落到代码上的约定**。

## 仓库结构

```text
apps/desktop/          # 唯一渲染层 + 桌面宿主（Electron）
├── src/main/          # 主进程：窗口 / 托盘 / IPC / 文件操作 / 服务托管
├── src/preload/       # contextBridge 白名单桥（window.docvi）
├── src/renderer/src/  # Vue 3 UI（App.vue + components/ + stores/ + lib/）
└── src/service/       # 服务进程：MCP / 临时分享 / 检索语料（可独立运行）
packages/
├── shared/            # 进程间契约：IPC 通道 / DocviApi / 设置 / 类型
├── renderer-core/     # Markdown 管线：渲染、高亮、mermaid、主题样式
├── editor/            # CodeMirror 6（Live Preview / 源码 / 分屏）
├── plugin-api/        # 插件协议类型
├── plugin-runtime/    # 插件清单校验
└── server/            # 服务层（纯 Node）：MCP / 分享 / 语料
plugins/               # 插件市场清单（market.json）
scripts/
├── docs-config.mjs    # docs.config.yaml 解析与归一化 / 目标判定 / 聚合合并
├── scan-docs.mjs      # 目录树扫描（递归 + 图标标记 + 排序）
├── build-docs-index.mjs # 索引生成器（tree.json + search-index.json，唯一实现）
├── check-links.mjs    # 死链报告
└── verify-app.mjs     # 端到端回归（拉起真实 Electron）
docs/architecture/     # 本文档 + ADR + 组件协议退役说明
```

## 运行方式

唯一形态是桌面应用：`pnpm docvi:dev`（Electron + Vite 热更新），
preload 提供 `window.docvi`。

内容根下的 `docs.config.yaml` 决定树根节点（`sidebar`）、排除项（`exclude`）、静态目录（`staticDirs`）、
顶部导航（`nav`）与死链策略（`deadLinks`）；**平台侧缺配置一律失败并给模板，绝不静默扫描**。

内容服务协议（桌面走 IPC；渲染层不直接读盘）：

| 端点                       | 语义                                                     |
| -------------------------- | -------------------------------------------------------- |
| `workspaceList`            | 工作区清单（侧栏树顶部的一级节点）                       |
| `docsTree`                 | 目录树清单（tree.json 形态，含 version/title/roots）     |
| `docsSearchIndex`          | 搜索索引（minisearch 导出）                              |
| `docRead` / `docWrite`     | 文档原文读写（含 frontmatter，渲染在客户端；防穿越）     |
| `docvi://asset/<id>/<rel>` | 内容根静态资产（图片等），按登记根伺服并做 realpath 校验 |

约定：

- 静态资产一律走 `docvi://asset/` 协议，主进程对该路径做「规范化 + realpath + 普通文件」
  三重判定，软链接不能逃出登记根；
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

## 组件系统（已退役）

2026-11-24 起，声明式组件系统（`<at-*>` + frontmatter `components` 段）已从产品中
删除，两个内置组件包一并移除。原因与迁移对照见
[组件协议.md](组件协议.md)。

现在的表达通道只有两样，都是通用格式：

- **标准 Markdown**：GFM 表格 / 任务清单、\`\`\`mermaid 围栏、`::: tip` 容器、原生 HTML；
- **交互式图解**：独立 `.html` 文件 + 正文里的 `<iframe src="./x.html" sandbox="allow-scripts">`。

写法规范见 [内容写法](../engineering/内容写法.md)。

## 写教程内容

教程不需要任何特殊配置——把章节按 `01-`/`02-` 命名放进目录，树里就有序展开；需要
「这一节有落地页」就给目录放 `index.md`（或 `索引.md`）。

1. 目录里放 `index.md` 作为该主题主页（可选，但放了目录节点就可点击）；
2. 章节 Markdown 头部用 H1 作标题（树里显示的就是它），正文按固定阅读顺序：整体认知 →
   主流程 → 分层与模块职责 → 目录 → 核心实现 → 契约 → 省略 → 下一步；
3. 要讲代码走读时，直接在正文里写代码块 + 分步说明段落——不再有代码走读组件；
4. 预览：`pnpm docvi:dev`。

## 已验证

- `pnpm verify` 全链通过（格式 / lint / 类型 / 构建 / 单测 / 文案 / 文档 / 依赖方向 / 敏感内容）；
- `pnpm verify:iframe` 端到端通过：md 里的原生 `<iframe>` 能加载本地 html 并执行脚本；
- 明暗切换、主题切换、切标签位置恢复实测。
