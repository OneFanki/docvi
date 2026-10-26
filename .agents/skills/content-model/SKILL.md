---
name: content-model
description: 改 docs.config.yaml、目录树生成、搜索索引、扫描规则、内容根零污染相关逻辑时使用。
---

# 内容模型（配置 → 树 → 索引）

## 结论

- **单一实现**：配置解析、目录扫描、树/索引生成全部在 `scripts/lib/docs-core.mjs`（零 Node 依赖，IO 由调用方注入）。容器、CLI、桌面、viewer 都消费同一份，禁止另写第二套扫描逻辑。
- **零污染**：聚合模式生成物只写 `.docvi/`；任何宿主都不得向用户内容目录写文件。
- **树外可访问 ≠ 不进树**：`sidebar` 只决定树的根节点；不在 sidebar 的目录仍可打开、可被搜索；`exclude` 才真正排除。
- **`可访问` 与 `进树` 是两件事**，这是刻意设计，不要「修正」。

## 关键规则

| 规则          | 口径                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 配置文件名    | `docs.config.yaml`（常量 `DOCS_CONFIG_FILENAME`）                                                                       |
| 落地页        | `index.md` / `索引.md` / `README.md`（`INDEX_BASENAMES`，按序取第一个）                                                 |
| 排序          | 默认中文 locale + 数字前缀自然序；frontmatter `order` 覆盖（小在前）；目录取自身落地页的 order                          |
| 隐藏/跳过目录 | `.` 前缀、`node_modules`、`dist`、`.git`（`isHiddenDirName` / `isSkippableDirName`）                                    |
| 版本指纹      | tree 与 search-index 的 `version` 必须一致才可配套使用（`contentFingerprint`）                                          |
| 缺配置        | 站点**报错并给最小模板**（`minimalConfigTemplate`），绝不静默扫描；桌面本地工作区与容器部署允许 autoscan 并展示明示提示 |
| 索引产物      | `tree.json` + `search-index.json`，单文件原子写                                                                         |

## 典型修改点

- 新增配置字段：`loadDocsConfig` 归一化 → `buildDocsSidebar` / `buildDocsTree` 消费 → 渲染层类型（`packages/shared/src/ipc.ts` 的 `TreeNode`）与宿主适配（`lib/web-host.ts` 的树转换）→ 文档 `README.md` 配置示例 → 单测。
- 改扫描规则：同时改 `scripts/lib/docs-core.mjs` 与 `scripts/*.test.mjs` 的契约断言，并确认容器与桌面两条链路仍走同一入口。

## 禁止

- 在 `deployer/`、`apps/`、`packages/` 里复制扫描 / 建树 / 建索引逻辑。
- 把 `staticDirs`、`exclude` 的判定散落到多个文件。
- 用 `fs` 直接读写内容根绕过注入的 IO 适配器（会破坏本地与容器两种来源的复用）。

## 变更触发

- `scripts/lib/docs-core.mjs` 的导出或规则变化 → 同步本 skill、`docs/engineering/目录结构.md`、`README.md` 配置节。
