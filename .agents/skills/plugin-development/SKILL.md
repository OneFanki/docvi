---
name: plugin-development
description: 新增、修改、打包或发布插件包（plugin.json / dist / docs / examples）时使用。
---

# 插件包开发

## 结论

- 一个插件包 = 一个目录，最小结构：`plugin.json`（清单）+ `src/index.ts`（入口，导出 `activate`）+ `dist/`（预构建 ESM + CSS）+ `docs/SKILL.md`（给 AI 与人的用法文档）+ `examples/`（可选示例 md）。
- 构建统一走 `scripts/build-plugins.mjs`：ESM 单入口、`external: ['vue']`、产物 `dist/index.js` + `dist/style.css`。第三方包在作者 CI 产出同样形态。
- 预设包放 `plugins/<name>/`；第三方包独立仓发布，不进本 workspace。

## 必填清单（`plugin.json`）

`name` / `displayName` / `version` / `apiVersion` / `entry` / `docs` / `components[]`（非空，每项含 `kind`、`title`、`description`）。构建期校验，缺一即失败。

## 开发步骤

1. 复制 `plugins/base` 的结构，改 `plugin.json` 的 name/displayName/components。
2. 写组件（Vue SFC），只依赖 `vue`；样式自包含，类名带包内前缀（如 `at-` 之外的独立前缀），不污染全局。
3. `src/index.ts` 维护 KINDS 表，逐项 `registerKind`。
4. 写 `docs/SKILL.md`：何时用、数据格式、最小示例、禁止项。
5. 写 `examples/*.md` 并在清单里挂 `example` 路径。
6. `pnpm build:plugins` + `pnpm test`（一致性 / 产物约束 / 示例存在性）。

## 禁止

- 打包 Vue 副本（必须 external，否则双实例导致响应式失效）。
- 访问宿主全局、import 壳内部模块、假设 DOM 结构。
- 在 `dist/` 里手改产物（构建生成物，改动会被覆盖）。
- 组件静默吞掉数据错误（必须给可见空态 / 错误态）。

## 相关

- `docs/design/平台插件化与 AI 分发.md`（协议与分发）
- `docs/architecture/组件协议.md`（消费者侧写法）
- `plugins/base/docs/SKILL.md`（活样例）

## 变更触发

- 构建脚本、清单必填字段、产物形态变化 → 同步本 skill + `plugin-development` 相关测试 + 插件作者文档。
