# docvi 项目总览

> 面向新加入的开发者与 AI：5 分钟了解这是一套什么系统、由哪些部分组成、边界在哪。
> 当前架构决策见 [docvi 目标架构与实施总案](../design/docvi目标架构与实施总案.md)。

## 一句话

把任意 Markdown 目录变成**可浏览、可搜索**的文档应用；桌面是唯一产品形态，Markdown 原文直出、浏览器端渲染。

## 单一宿主

```
┌──────────────────────────────────────────┐
│  apps/desktop/src/renderer（Vue 3）       │
│  界面 / 编辑 / 阅读                       │
└──────────────────┬───────────────────────┘
                   │ window.docvi（唯一契约）
          Electron preload
                   │  IPC
        ┌──────────┴──────────┐
        │                     │
   主进程（本地磁盘 /     服务进程
   窗口 / 系统集成）      （MCP / 临时分享 / 语料）
```

1.0 起只剩桌面一种形态：容器版、git 集成、自研组件系统全部移除
（背景见 [ADR-0007](../architecture/adr/0007-desktop-only-and-plain-markdown.md)）。

## 核心不变量

1. **零编译渲染**：md 原文直出，浏览器端渲染；改完刷新即见，没有构建等待。
2. **表达通道只有通用格式**：标准 Markdown（GFM / mermaid / `::: tip` 容器）+ 原生 HTML
   （交互式图解走 `<iframe sandbox="allow-scripts">`）。禁止重新引入自研声明式组件——
   那会让文档只在 docvi 里可读。
3. **宿主差异只经 `window.docvi`**：渲染层不出现宿主实现分支，也不探测「方法是否存在」。
4. **服务只有一份实现**：MCP / 分享 / 检索语料在 `packages/server`，桌面服务进程复用。
5. **内容根零污染**：生成物只写 `.docvi/`。
6. **插件协议向后兼容**：`plugin.json` + ESM 入口 + `docs/SKILL.md`，作者零宿主依赖。

## 目录速览

```
apps/desktop/        唯一渲染层 + 桌面宿主（主进程 / preload / 渲染 / 服务进程）
packages/shared/     跨进程契约（IPC 通道 / DocviApi / 类型）
packages/renderer-core/  Markdown 管线与主题样式
packages/editor/     CodeMirror 6 编辑器
packages/plugin-*/   插件协议与运行时
packages/server/     服务层（纯 Node：MCP / 分享 / 语料）
scripts/             构建、索引、门禁
plugins/             插件市场清单
```

## 技术栈

| 层     | 技术                                                                     |
| ------ | ------------------------------------------------------------------------ |
| 渲染层 | Vue 3 + Pinia、markdown-it、shiki、mermaid、minisearch、CodeMirror 6     |
| 服务   | Node ≥ 22.18、手写 HTTP、JSON-RPC 2.0（MCP 最小子集）                    |
| 桌面   | Electron 45（utilityProcess 托管服务进程）                               |
| 门禁   | Node 内置 test runner、自研 verify / verify-app / check-docs、commitlint |

## 进一步阅读

- 架构决策：[ADR 目录](../architecture/adr/README.md)
- 目录与依赖规则：[目录结构](../engineering/目录结构.md)
- 内容写法：[内容写法](../engineering/内容写法.md)
- 文档治理：[文档规范](../engineering/文档规范.md) / [文档模板](../engineering/文档模板.md)
- 踩坑记录：[踩坑库](../engineering/踩坑库.md)
