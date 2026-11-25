---
title: 平台插件化与 AI 分发
---

# 平台插件化与 AI 分发

> 状态：**设计稿已作废**（2026-11-24）｜ 负责人：Fanki ｜ 创建：2026-10-15
>
> 本文原本描述一套以「声明式组件」为核心的插件化与分发方案。2026-11-24（v1.0.0）
> 组件系统整体删除，本文的主体内容（组件协议、组件贡献点、AI 按组件写作的分发口径）
> 随之失效。删除理由见 [组件协议](../architecture/组件协议.md)。
>
> 下面只保留「如今插件系统还剩什么」，作为现状记录。

## 插件系统现状

插件包仍然存在，协议仍是 `plugin.json`（`packages/plugin-runtime` 的 `readManifest` 负责
校验），安装/启停/卸载走主进程的插件商店（`apps/desktop/src/main/plugin-store.ts`），
第三方来源是远端市场清单（`plugins/market.json`）。

真正可用的贡献点**只剩主题**：

| 贡献点                       | 状态                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `contributes.themes`         | **可用**：整套 `--dv-*` 变量，装好即进设置页的主题网格 |
| `contributes.components`     | 无消费方（组件系统已删）                               |
| `contributes.markdownSyntax` | 无消费方（容器语法已删）                               |
| `contributes.commands`       | 协议字段保留，界面只做计数展示，未接入命令面板         |

第三方插件从来没有过组件加载器：历史上内置组件包走构建期静态 import，第三方只有清单
校验与安装流程。所以 1.0.0 的删除不改变插件系统的既有能力边界。

## AI 分发口径

MCP 服务（`packages/server/src/mcp.mjs`）此前提供 `list_components` / `get_component_docs`
两个工具，用于让外部 AI 按组件写文档。这两个工具已随组件系统删除——现在 AI 只需按
标准 Markdown 写作，写法规范见 [内容写法](../engineering/内容写法.md)。

`list_plugins` / `get_plugin_docs` 仍然可用（了解已装插件与其用法文档），但返回值里不再
有组件清单。

## 关联文档

- [组件协议（已退役）](../architecture/组件协议.md)
- [内容写法](../engineering/内容写法.md)
- [ADR-0006 原生 Markdown 优先](../architecture/adr/0006-native-markdown-first.md)
