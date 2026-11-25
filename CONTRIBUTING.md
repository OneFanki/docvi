# 参与贡献

感谢你愿意参与 docvi。本文只写「怎么做才不会被门禁挡住」，设计取舍看 `docs/`。

## 环境

| 要求    | 版本    | 说明                                                                 |
| ------- | ------- | -------------------------------------------------------------------- |
| Node.js | ≥ 22.18 | 测试直接跑 `.ts` 源码，依赖 Node 原生类型剥离                        |
| pnpm    | 12.10.1 | 根 `package.json` 的 `packageManager` 已钉住，`corepack enable` 即可 |

```bash
pnpm install
pnpm docvi:dev     # Electron + Vite 热更新
pnpm verify        # 提交前必须全绿
```

`pnpm install` 的 `postinstall` 会补齐 Electron 二进制。Electron 42 起不再自带安装脚本，
而 `electron-vite` 不会自己下载（只会报 `Electron uninstall`），所以这一步是必需的。
网络需要代理时先设好 `HTTPS_PROXY`，钩子会自动接上。

## 提交前

`pnpm verify` 是一个非 fail-fast 的全量门禁，一次跑完 14 项并统一报告。它包含格式、lint、
类型、构建、单测、端到端回归、文案、文档链接、技能索引、依赖方向与开源敏感内容扫描。**任何一项红了都
不要提交**——这些检查在 CI 上同样会跑。

只想跑单项时：

```bash
pnpm format        # 写回格式
pnpm lint
pnpm docvi:typecheck
pnpm test
pnpm verify:app    # 真实 Electron 跑一遍核心交互（需先 docvi:build）
```

## 提交信息

用 Conventional Commits，中文描述：

```
feat(desktop): 选区工具栏补行前缀与删除线
fix(editor): 修选区层吞掉点击导致光标落错行
docs(版本): 补开源前的许可与仓库地址
```

- 类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf` / `build`
- 作用域用目录或包名：`desktop` / `editor` / `renderer-core` / `server` / `plugins` / `scripts` / `docs`
- 一个提交只做一件事。格式化与功能改动分开提交，review 时能看清哪个是噪音。

`commitlint` 会在提交时校验格式。

## 代码约定

硬约束集中在 `AGENTS.md`，这里只列最容易踩的几条：

1. **依赖方向单向**：渲染进程只经 preload 白名单访问宿主，禁止 import `node:` / `electron`；
   主进程不得 import 渲染层；服务进程不得 import 窗口层。由 `pnpm check:boundaries` 守护。
2. **宿主差异只有一个收口处**：`window.docvi`（契约在 `packages/shared/src/ipc.ts`）。
   由 preload 提供，渲染层不许探测「某个方法存不存在」来决定行为。
3. **服务只有一份实现**：MCP、临时分享、检索语料的协议逻辑只存在于 `packages/server`，
   桌面服务进程必须复用，不许各写一套。
4. **插件包零宿主依赖**：只允许 `vue` 作为 peerDependency，禁止访问宿主全局。
5. **视觉常量只在 token 里定义**：圆角走 `--dv-ui-radius-*`，动效走 `--dv-ui-dur-*`。
   新增样式不要写字面量时长与圆角——散落值正是「看起来不精致」的源头。

## 改插件或主题

本仓不维护插件源码（见 ADR-0007）：插件由第三方独立分发，本仓只有 `plugins/market.json` 这份清单。

- 清单条目字段见 [docs/plugin-market.md](docs/plugin-market.md)；
- 宿主侧只校验 manifest（`packages/plugin-runtime/src/manifest.ts`）与读主题 token，
  当前**没有 entry 加载器**——声明了 `entry` 的插件在 1.0 不会被执行；
- 改主题令牌走 `packages/renderer-core/src/styles/theme.css`，新增内置主题还要登记
  `apps/desktop/src/renderer/src/lib/theme-options.ts`。

## 改文档

`pnpm docs:check` 校验 `docs/` 与根 `AGENTS.md` / `SKILLS-INDEX.md` 的相对链接是否指向真实
文件。新增设计文档放在 `docs/design/`，架构决策放 `docs/architecture/adr/`——**新决策必须写
ADR**，不允许只留在讨论与代码注释里。

## 报告问题

- 缺陷：说明版本、操作系统、复现步骤与期望行为；能附截图或控制台输出最好。
- 安全漏洞：**不要开公开 issue**，见 [SECURITY.md](SECURITY.md)。

## 许可

提交即表示你同意以 [MIT](LICENSE) 许可发布你的贡献。
