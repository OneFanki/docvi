---
name: deployer-ops
description: 改容器部署器、运维 API、git 编排、索引刷新队列、Docker 打包时使用。
---

# 容器部署器（deployer）

## 结论

- 单容器 = git 仓库编排 + 索引刷新队列 + 运维 API + 壳站点 + MCP + 临时分享。
- **门户即仓库选择页**；白名单分支自动拉取 / 刷新索引，detached 工作树 + `reset --hard`，以云端为准。
- 内容变更毫秒级生效：壳每请求直读挂载分支的工作树（md 原文）与发布目录（tree.json / search-index.json），失败时旧版持续在线。

## 关键边界

| 项        | 口径                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------- |
| 运维面    | `/_/` 前缀；`OPS_TOKEN` 未配置 = 整体关闭（不是空口令放行），Bearer 校验                                       |
| 凭证      | 写入数据卷内临时文件（0600），用完即删；不进镜像层、不落日志                                                   |
| 分支      | 白名单匹配（`branchInWhitelist`），detached 工作树，禁止在用户内容仓留生成物                                   |
| 索引写    | 发布目录内单文件原子写（先写临时名再 rename）                                                                  |
| MCP       | `POST /mcp`，JSON-RPC 2.0 最小子集；协议版本白名单；请求体上限 256KiB；检索范围 = 各仓默认分支工作树（5s TTL） |
| 预留 slug | `docs` / `api` / `assets` / `_` / `s` / `mcp`（仓库 slug 不得占用）                                            |
| 分享      | `/s/<id>/`，只服务显式登记路径；目录分享现场扫描限深 16                                                        |

## 常见改动路径

- 新增运维 API：`deployer/src/httpd.mjs` 路由 + `portal.mjs` 运维页 + `test/httpd` 相关测试。
- 改索引刷新：`builder.mjs`（队列）→ `store.mjs`（发布目录）→ `scripts/build-docs-index.mjs`（索引生成，复用 `scripts/lib/docs-core.mjs`）。
- 改 MCP：只改 `packages/server/src/mcp.mjs`（协议与工具面）+ `corpus.mjs`（检索），两端共用；容器侧只在 `httpd.mjs` 注入取数回调（`refreshMcpScopes` 管检索范围）。禁止任一侧另起一份协议实现。

## 禁止

- 在 deployer 内复制扫描 / 建树 / 建索引逻辑（必须复用 `docs-core`）。
- 把 OPS_TOKEN、git 凭证写进镜像、日志或响应体。
- 直接对用户仓库工作区 `git checkout` 残留分支（只允许 detached + reset）。

## 相关

- `docs/design/文档平台部署与多仓库管理.md`
- `docs/design/平台临时分享.md`
- `README.md`「部署器」节

## 变更触发

- 路由、环境变量、数据目录布局变化 → 同步本 skill + `.env.example` + `docs/design/文档平台部署与多仓库管理.md`。
