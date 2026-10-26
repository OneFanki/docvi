# 介绍页（GitHub Pages）

`site/` 是一份**无构建步骤的静态页**：纯 HTML + CSS，截图与图标在发布时从仓库里的
单一来源拷进来。改文案直接改 `index.html`，不需要装依赖、不需要打包。

## 本地看

```bash
node scripts/build-site.mjs          # 组装到 site-build/（截图与图标拷一份）
npx serve site-build                 # 或任意静态服务器
```

`site/index.html` 直接双击打开也能看，只是图片路径指向 `./screenshots/` 与
`./assets/`，那两份目录只在组装后存在——所以正式预览走上面的两步。

## 发布

**前置条件：仓库必须先启用 Pages**（Settings → Pages → Source 选 **GitHub Actions**）。
私有仓库 + 免费套餐不支持 Pages；未启用时工作流只会组装页面并留下一条提示，
不会失败——这样平时 push 不会出现误导性的红叉。

`.github/workflows/pages.yml` 在 `site/`、`docs/screenshots/` 或 `docs/assets/` 变更时
自动部署。它做三件事：

1. 把 `docs/screenshots/*.png` 拷到 `site/screenshots/`；
2. 把 `docs/assets/logo.svg` 拷成 `site/assets/favicon.svg`；
3. 把 `index.html` 里的 `__VERSION__` 替换成根 `package.json` 的版本号。

## 为什么截图不放两份

截图的事实源只有一个：`docs/screenshots/`，由 `pnpm screenshots` 生成（见
`scripts/capture-screenshots.mjs`）。介绍页与 README 引用同一批文件，
发布时机械复制——所以不存在「README 更新了、介绍页还是旧图」的情况。

## 维护约定

- 新增区块先在 `index.html` 里加，再回 README 补一小节（README 是索引，介绍页是展开）。
- 新增截图：在 `capture-screenshots.mjs` 的 `SHOTS` 里登记，跑一次生成，
  然后同时被 README 与介绍页引用。`scripts/readme-assets.test.mjs` 会核对
  「README 引用的图都存在」「磁盘上的图都被引用」「图都能由脚本重新生成」。
