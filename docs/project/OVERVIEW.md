# docvi 项目总览

> 面向新加入的开发者与 AI：5 分钟了解这是一套什么系统、由哪些部分组成、边界在哪。
> 当前架构决策见 [docvi 目标架构与实施总案](../design/docvi目标架构与实施总案.md)。

## 一句话

把任意 Markdown 目录变成**可浏览、可搜索、可交互**的文档站；一份渲染层服务两种宿主，协议统一、零编译渲染。

## 两种宿主，一份渲染层

```
                  ┌────────────────────────────────────┐
                  │  apps/desktop（渲染进程，Vue 3）    │
                  │  界面 / 编辑 / 阅读 / 组件渲染      │
                  └───────────────┬────────────────────┘
                                  │ window.docvi（唯一契约）
              ┌───────────────────┴───────────────────┐
              │                                       │
      Electron preload                        lib/web-host.ts
      （IPC → 主进程 / 本地磁盘）              （HTTP → deployer）
              │                                       │
        桌面应用                                 容器站点
        apps/desktop                            deployer/
```

- **桌面应用**：本地工作区浏览 + 编辑 + git + 本地服务（MCP / 分享 / 插件）。
- **容器站点**：多仓库编排、索引刷新队列、运维 API、门户；读者面只读。

宿主差异只有一个收口处：`window.docvi`。桌面由 preload 提供，容器由 `web-host.ts` 把
deployer 的 HTTP 协议接成同一形状；渲染层按 `hostKind` 决定入口显隐。

## 核心不变量

1. **零编译渲染**：md 原文直出，浏览器端渲染；改完刷新即见。
2. **宿主差异只经 `window.docvi`**：渲染层不出现「桌面 / 容器」的实现分支。
3. **服务只有一份实现**：MCP / 分享 / 检索语料在 `packages/server`，容器与桌面复用。
4. **内容根零污染**：生成物只写 `.docvi/`。
5. **插件协议 v1 向后兼容**：`plugin.json` + ESM 入口 + `docs/SKILL.md`，作者零宿主依赖。

## 目录速览

```
apps/desktop/        唯一渲染层 + 桌面宿主（主进程 / preload / 渲染 / 服务进程）
packages/shared/     跨进程契约（IPC 通道 / DocviApi / 类型）
packages/renderer-core/  Markdown 管线与主题样式
packages/editor/     CodeMirror 6 编辑器
packages/plugin-*/   插件协议与运行时
packages/server/     服务层（纯 Node：MCP / 分享 / 语料）
deployer/            容器部署器
scripts/             构建、索引、门禁
courses/             示例内容根
plugins/             预设插件包源码
```

## 技术栈

| 层     | 技术                                                                       |
| ------ | -------------------------------------------------------------------------- |
| 渲染层 | Vue 3 + Pinia、markdown-it、shiki、mermaid、minisearch、CodeMirror 6       |
| 服务   | Node ≥ 20、手写 HTTP、JSON-RPC 2.0（MCP 最小子集）                         |
| 桌面   | Electron（utilityProcess 托管服务进程）                                    |
| 容器   | Docker、git 镜像仓 + detached worktree                                     |
| 门禁   | Node 内置 test runner、自研 verify / check-docs / check-skills、commitlint |

## 进一步阅读

- 架构决策：[ADR 目录](../architecture/adr/README.md)
- 目录与依赖规则：[目录结构](../engineering/目录结构.md)
- 组件协议：[组件协议](../architecture/组件协议.md)
- 文档治理：[文档规范](../engineering/文档规范.md) / [文档模板](../engineering/文档模板.md)
- 踩坑记录：[踩坑库](../engineering/踩坑库.md)
- 目标架构：[docvi 目标架构与实施总案](../design/docvi目标架构与实施总案.md)
