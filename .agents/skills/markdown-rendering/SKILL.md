---
name: markdown-rendering
description: 改 Markdown 渲染管线、代码高亮、mermaid、锚点、iframe 内嵌、正文排版时使用。
---

# Markdown 渲染管线

## 结论

- **浏览器端零编译渲染**是产品根基：服务端只给 md 原文，渲染全部发生在客户端。禁止改成构建期预渲染（会破坏「改完刷新即见」）。
- 管线入口 `packages/renderer-core/src/markdown.ts`：markdown-it + anchor + container + 术语块规则；高亮在同包 `highlight.ts`（shiki 懒加载）；mermaid 在同包 `mermaid.ts`（按需加载）。
- 原生 HTML 原样透传（`html: true`）。相对 `src` 的 `<iframe>` 由同包 `iframe-assets.ts` 在 `md.render` 之后统一补资产前缀——这是「在 md 里嵌一个本地 html 图解」的正常路径。

## 修改时必须守住

| 约束                                                  | 原因                       |
| ----------------------------------------------------- | -------------------------- |
| 高亮语言按需注册，不整包引入 shiki 全语言             | 包体与首屏                 |
| mermaid 只在页面出现 ` ```mermaid ` 时动态 import     | 同上                       |
| 锚点 id 与标题文本解耦：中文标题也要稳定              | 分享链接可复制             |
| 渲染失败降级为纯文本 + 错误提示条，不白屏             | 单篇坏文档不能拖垮站点     |
| 文档切换时销毁上一个实例（mermaid 缩放、高亮 worker） | 防内存泄漏                 |
| iframe 前缀归一放在 `md.render` 之后，不写成单条规则  | 块级/内联/raw 片段都要覆盖 |

## 常见坑

- `html: true` 是刻意开的：作者用 `<details>`、`<iframe>` 这类原生标签表达布局是合法写法。不要顺手关掉。
- 内联 `<script>` 仍被 CSP 的 `script-src 'self'` 拦死——这是安全边界，不是缺陷。要交互就写独立 `.html` + `<iframe sandbox="allow-scripts">`。
- iframe 的相对 `src` 会被解析到渲染产物目录（`docvi://app/…`）而 404，必须走 `rewriteIframeSrc`；新增标签（`<video src>`、`<img src>` 之外的）优先复用同一份归一逻辑。
- 相对链接与图片走 `urlPrefix`（分享页补 `/s/<id>` 段）；链接归一化在 `resolveLink`，编码只发生一次。

## 相关

- `docs/engineering/内容写法.md`（四种表达通道的选型）
- `docs/architecture/adr/0006-native-markdown-first.md`

## 变更触发

- 换渲染器 / 升高亮方案 / 改 HTML 放行策略 → 先写 ADR（被否方案必填），再同步本 skill 与 `docs/engineering/目录结构.md`。
