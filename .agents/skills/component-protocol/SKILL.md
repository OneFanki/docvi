---
name: component-protocol
description: 改 at-* 声明式协议、frontmatter components 段、组件运行时或组件数据协议时使用。
---

# 组件声明式协议（v1 / v1.1）

## 结论

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

## 禁止

- 组件内直接读 frontmatter / 路由 / 宿主全局；一切输入走 props（由桥接层注入）。
- 在 `<at-*>` 标签里写行内 JSON（数据只放 frontmatter，正文保持可读）。
- 让 `kind` 参与翻译（kind 是标识符，永不本地化）。

## 变更触发

- 任何协议字段语义变化 → 同步本 skill + `docs/architecture/组件协议.md` + 插件包文档，并评估是否需要 ADR。
