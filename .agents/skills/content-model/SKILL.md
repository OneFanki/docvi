---
name: content-model
description: 改 docs.config.yaml、目录树生成、搜索索引、扫描规则、内容根零污染相关逻辑时使用。
---

# 内容模型（配置 → 树 → 索引）

## 结论

- **两处实现，各有归属**（1.0 起没有「唯一实现」，别再照旧描述）：
  - **产品侧（用户在应用里看到的那棵树）**：`apps/desktop/src/main/config.ts` 解析 `docs.config.yaml`，`content.ts` 扫描目录建树。这是唯一影响界面的实现。
  - **索引/校验脚本侧**：`scripts/lib/docs-core.mjs`（零 Node 依赖，IO 由调用方注入）——只被 `build-docs-index` / `docs-config` / `scan-docs` / `check-links` 使用，桌面产品**不 import 它**，只沿用同一套扫描口径。
    改规则时两边都要看，否则「脚本里的树」与「应用里的树」会悄悄分叉。
- **零污染**：聚合模式生成物只写 `.docvi/`；任何宿主都不得向用户内容目录写文件。
- **树外可访问 ≠ 不进树**：`sidebar` 只决定树的根节点；不在 sidebar 的目录仍可打开、可被搜索；`exclude` 才真正排除。
- **`可访问` 与 `进树` 是两件事**，这是刻意设计，不要「修正」。

## 关键规则

| 规则          | 口径                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 配置文件名    | `docs.config.yaml`（常量 `DOCS_CONFIG_FILENAME`）                                                                                 |
| 落地页        | `index.md` / `索引.md` / `README.md`（`INDEX_BASENAMES`，按序取第一个）                                                           |
| 排序          | 默认中文 locale + 数字前缀自然序；frontmatter `order` 覆盖（小在前）；目录取自身落地页的 order                                    |
| 隐藏/跳过目录 | `.` 前缀、`node_modules`、`dist`、`.git`（`isHiddenDirName` / `isSkippableDirName`）                                              |
| 版本指纹      | tree 与 search-index 的 `version` 必须一致才可配套使用（`contentFingerprint`）                                                    |
| 缺配置        | **桌面工作区自动扫描**（`content.ts` 无 `sidebar` 时按目录递归）并展示明示提示；脚本侧（`minimalConfigTemplate`）报错并给最小模板 |
| 索引产物      | `tree.json` + `search-index.json`，单文件原子写                                                                                   |

## 典型修改点

- 新增配置字段：先确认**产品侧**是否消费它（`apps/desktop/src/main/config.ts` 目前只读 `title` / `description` / `sidebar`，`exclude` / `staticDirs` / `nav` / `deadLinks` 只有脚本侧在用）；再同步 `packages/shared/src/ipc.ts` 的 `TreeNode`、`docs/engineering/` 说明与单测。
- 改扫描规则：产品侧改 `apps/desktop/src/main/content.ts`（`pnpm verify:app` 会验树是否真的渲染出来）；脚本侧改 `scripts/lib/docs-core.mjs` + `scripts/*.test.mjs`。两边口径要一致。

## 禁止

- 在 `packages/` 里再复制一套扫描 / 建树 / 建索引逻辑（`apps/desktop/src/main` 已有的那份是产品实现，不是重复）。
- 把 `staticDirs`、`exclude` 的判定散落到多个文件。
- 在 `docs-core.mjs` 里直接用 `fs`：它必须保持零 Node 依赖，IO 由调用方注入。

## 变更触发

- `scripts/lib/docs-core.mjs` 的导出或规则变化 → 同步本 skill、`docs/engineering/目录结构.md`、`README.md` 配置节。
