---
name: markdown-rendering
description: 改 Markdown 渲染管线、代码高亮、mermaid、锚点、正文排版时使用。
---

# Markdown 渲染管线

## 结论

- **浏览器端零编译渲染**是产品根基：服务端只给 md 原文，渲染全部发生在客户端。禁止改成构建期预渲染（会破坏「改完刷新即见」）。
- 管线入口 `packages/renderer-core/src/markdown.ts`：markdown-it + anchor + container + 术语块规则；高亮在同包 `highlight.ts`（shiki 懒加载）；mermaid 在同包 `mermaid.ts`（按需加载）。
- 文档内 `<at-*>` 标签由 `components.ts` 接管，数据来自 frontmatter `components` 段；**渲染层不直接实例化组件**。

## 修改时必须守住

| 约束                                                  | 原因                   |
| ----------------------------------------------------- | ---------------------- |
| 高亮语言按需注册，不整包引入 shiki 全语言             | 包体与首屏             |
| mermaid 只在页面出现 ```mermaid 时动态 import         | 同上                   |
| 锚点 id 与标题文本解耦：中文标题也要稳定              | 分享链接可复制         |
| 渲染失败降级为纯文本 + 错误提示条，不白屏             | 单篇坏文档不能拖垮站点 |
| 文档切换时销毁上一个实例（mermaid 缩放、高亮 worker） | 防内存泄漏             |

## 常见坑

- markdown-it 的 `html: true` 会放行原始 HTML；`HtmlEmbed` 组件是**显式**的受控入口，不要顺手把全局 html 关掉或开大。
- 代码块内出现 `<at-...>` 文本时不能被组件桥接管（桥只处理顶层节点，改选择器时注意）。
- 相对链接与图片走 `urlPrefix`（容器版补 `/<仓库>` 段，分享页补 `/s/<id>` 段）；链接归一化在 `resolveLink`，编码只发生一次。

## 相关

- `docs/design/平台自研壳与多宿主迁移.md`
- 组件协议：`docs/architecture/组件协议.md`

## 变更触发

- 换渲染器 / 升高亮方案 / 改组件挂载方式 → 先写 ADR（被否方案必填），再同步本 skill 与 `docs/engineering/目录结构.md`。
