---
name: plugin-development
description: 新增、修改、打包或发布插件包（plugin.json / 主题令牌 / docs）时使用。
---

# 插件包开发

## 结论

- 一个插件包 = 一个目录，最小结构：`plugin.json`（清单）+ `docs/SKILL.md`（用法文档）。
- **现在唯一有消费方的贡献点是主题**（`contributes.themes`）：一份 `--dv-*` 变量表，
  装好即出现在设置页的主题网格。组件贡献点已随组件系统删除（2026-11-24），没有加载器。
- 第三方包独立仓发布，通过 `plugins/market.json` 登记；不进本 workspace。

## 清单必填（`plugin.json`）

`name` / `displayName` / `version` / `apiVersion` / `entry` / `docs`。校验在
`packages/plugin-runtime/src/manifest.ts`，缺字段即失败。

主题贡献的形状：

```json
"contributes": {
  "themes": [
    { "id": "sea", "title": { "zh": "海岬" }, "appearance": "dark", "tokens": "themes/sea.json" }
  ]
}
```

`tokens` 指向包内 JSON，键必须是 `--dv-*`，值必须是单一颜色（净化规则在
`@docvi/shared` 的 `sanitizeThemeTokens`）。三层变量都要覆盖到——只写 UI 层会拼出
「浅色窗口 + 深色正文」这种半截外观。

## 开发步骤

1. 新建目录，写 `plugin.json`（`name` 用 kebab-case、与市场清单一致）。
2. 写主题令牌文件：`--dv-ui-*`（窗口）、`--dv-doc-*`（正文）、`--dv-ed-*`（编辑器）。
3. 写 `docs/SKILL.md`：这是插件在 MCP `get_plugin_docs` 里返回的全文，写清用法与限制。
4. 本地验证：把包目录放到 `<userData>/plugins/<name>/<version>/`，重启应用，在插件面板
   确认已启用、主题出现在设置页。

## 禁止

- 打包 Vue 副本（运行时必须 external，双实例会导致响应式失效）。
- 访问宿主全局、import 壳内部模块、假设 DOM 结构。
- 在 `dist/` 里手改产物（构建生成物，改动会被覆盖）。
- 往主题令牌里写非 `--dv-*` 变量或复合值（`position:fixed` 这类整页覆盖会被净化掉）。

## 相关

- `docs/design/平台插件化与 AI 分发.md`（插件系统现状）
- `docs/architecture/组件协议.md`（组件为何退役）
- `apps/desktop/src/renderer/src/lib/plugin-themes.ts`（主题加载实现）

## 变更触发

- 清单必填字段、主题令牌契约、资产协议变化 → 同步本 skill 与 `packages/plugin-runtime` 的校验。
