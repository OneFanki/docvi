---
name: component-protocol
description: 改 at-* 声明式协议、frontmatter components 段、组件运行时或组件数据协议时使用。
---

# 组件声明式协议（v1 / v1.1）

## 结论

- **默认写通用 Markdown**（ADR-0006）：GFM 表格 / 任务清单、```mermaid 围栏、`::: tip` 容器。自定义组件是「只有 docvi 能渲染」的可选项，不是首选。
- **业务零 JS**：作者只在 frontmatter 写 `components` 段 + 正文写 `<at-组件名 data-key="键">`，数据经 `data-key` 关联。禁止要求文档作者写脚本。
- **运行时分层**：`packages/renderer-core` 负责扫描结构化块与挂载点（`plugin-blocks.ts` / `components.ts`）；`apps/desktop/src/renderer/src/lib/component-registry.ts` 按 kind 建注册表；插件包只导出组件定义（`plugins/*/src/index.ts`）。
- **协议 v1 向后兼容**：字段只增不删；v1.1 新增的本地化字段（`LocalizedText`）与 `example` 均为可选。

## 协议要点

| 项       | 口径                                                                      |
| -------- | ------------------------------------------------------------------------- |
| 组件标签 | `<at-<kind> data-key="...">`，kind 全小写 kebab-case                      |
| 数据来源 | 文档 frontmatter `components: { <key>: {...} }`                           |
| 清单     | `plugin.json` 的 `components[]`（kind / title / description，均可本地化） |
| 宿主 API | `activate(host)` → `host.registerKind(kind, component, meta)`             |
| API 版本 | `plugin.json.apiVersion` 与宿主大版本不匹配 → 拒载并提示                  |
| 停用     | `disabledComponents[]` 由宿主拦截为 no-op，不报错                         |
| 空数据   | 组件必须渲染明确的空态，不得抛异常拖垮整页                                |

## 修改协议时的同步面（缺一即错）

1. `packages/plugin-api/src/index.ts`（协议类型）
2. `packages/renderer-core/src/components.ts` + `apps/desktop/src/renderer/src/lib/component-registry.ts`（挂载与注册）
3. `plugins/*/src/index.ts` 的 KINDS 表与 `plugin.json` 的 `components[]`（两处逐项一致，`scripts/plugins.test.mjs` 守护）
4. `docs/architecture/组件协议.md`（作者文档）
5. `courses/component-showcase`（活样例，必须能打开）
6. 插件包 `docs/SKILL.md`（MCP `get_plugin_docs` 的数据源）

## 表达方式选型（mermaid / 原生语法 vs 自定义组件）

**默认用通用写法，组件是带代价的可选项**（ADR-0006）。判据只有一条：这段内容离开 docvi 之后还要不要能读。

| 内容形态                                   | 用什么                                    | 理由                                     |
| ------------------------------------------ | ----------------------------------------- | ---------------------------------------- |
| 流程 / 时序 / 状态机 / 表关系 / 任意拓扑   | ```mermaid 围栏                           | 外部标准语法，GitHub、飞书、VS Code 都认 |
| 表格、清单、步骤、术语                     | GFM 表格 / 任务清单 / 加粗段首            | 原生语法，退化后仍完整                   |
| 提示、警告、折叠                           | `::: tip` 等容器 / `details`              | 退化后是普通引用块，语义仍在             |
| 需要交互（点选、步进高亮、字段级连线锚定） | 自定义组件                                | 原生语法给不了，**但只有 docvi 能渲染**  |
| 需要任意的图形 / 动效（画板级）            | HTML 岛（独立 `.html` 文件 + `src` 引用） | 独立文件本身可移植，双击就能看           |

**自定义组件的可移植性代价（选它之前必须知道）**：数据放 frontmatter `components` 段、正文写 `<at-kind data-key="键">`。
标签离开 docvi / 本平台后是裸文本——GitHub、飞书、语雀、VS Code 预览全部无法渲染，语义直接丢失。
因此：

- 写普通文档**不用**组件，用户的诉求通常是「写清楚」，不是「要交互」；
- 用户明确要求交互式视图、或续写已经在用该写法的存量文档时才用；
- 用了就主动告知这个限制，不要默默把文档锁进单一工具。

mermaid 的观感与交互由宿主统一负责：配色走 `--dv-mermaid-*` 派生变量（跟随文档主题，插件主题包可覆盖），hover 联动由 `packages/renderer-core/src/mermaid-hover.ts` 注入——作者写裸 mermaid fence 即可，不需要装饰。

## 禁止

- 组件内直接读 frontmatter / 路由 / 宿主全局；一切输入走 props（由桥接层注入）。
- 在 `<at-*>` 标签里写行内 JSON（数据只放 frontmatter，正文保持可读）。
- 让 `kind` 参与翻译（kind 是标识符，永不本地化）。

## 变更触发

- 任何协议字段语义变化 → 同步本 skill + `docs/architecture/组件协议.md` + 插件包文档，并评估是否需要 ADR。
- 升级 mermaid 依赖 → 先跑 `scripts/dev/probe-mermaid-shape.mjs` 核对 SVG id 约定，再核对 `mermaid-hover.ts` 的解析器。
