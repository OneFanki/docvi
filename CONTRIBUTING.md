# 参与贡献

感谢你愿意参与 docvi。本文只写「怎么做才不会被门禁挡住」，设计取舍看 `docs/`。

## 环境

| 要求    | 版本         | 说明                                                                 |
| ------- | ------------ | -------------------------------------------------------------------- |
| Node.js | ≥ 22.18      | 测试直接跑 `.ts` 源码，依赖 Node 原生类型剥离                        |
| pnpm    | 12.10.1      | 根 `package.json` 的 `packageManager` 已钉住，`corepack enable` 即可 |
| git     | 任意近期版本 | 桌面端的仓库管理走系统 `git` CLI                                     |

```bash
pnpm install
pnpm docvi:dev     # Electron + Vite 热更新
pnpm verify        # 提交前必须全绿
```

## 提交前

`pnpm verify` 是一个非 fail-fast 的全量门禁，一次跑完 15 项并统一报告。它包含格式、lint、
类型、构建、单测、文案、文档链接、技能索引、依赖方向与开源敏感内容扫描。**任何一项红了都
不要提交**——这些检查在 CI 上同样会跑。

只想跑单项时：

```bash
pnpm format        # 写回格式
pnpm lint
pnpm typecheck && pnpm docvi:typecheck
pnpm test
```

## 提交信息

用 Conventional Commits，中文描述：

```
feat(desktop): 选区工具栏补行前缀与删除线
fix(editor): 修选区层吞掉点击导致光标落错行
docs(版本): 补开源前的许可与仓库地址
```

- 类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf` / `build`
- 作用域用目录或包名：`desktop` / `editor` / `renderer-core` / `deployer` / `plugins` / `scripts`
- 一个提交只做一件事。格式化与功能改动分开提交，review 时能看清哪个是噪音。

`commitlint` 会在提交时校验格式。

## 代码约定

硬约束集中在 `AGENTS.md`，这里只列最容易踩的几条：

1. **依赖方向单向**：渲染进程只经 preload 白名单访问宿主，禁止 import `node:` / `electron`；
   主进程不得 import 渲染层；服务进程不得 import 窗口层。由 `pnpm check:boundaries` 守护。
2. **宿主差异只有一个收口处**：`window.docvi`（契约在 `packages/shared/src/ipc.ts`）。
   桌面由 preload 提供，容器由 `renderer/src/lib/web-host.ts` 提供。**禁止**在组件里探测
   「某个方法存不存在」来决定行为——问 `hostKind` 与能力表。
3. **服务只有一份实现**：MCP、临时分享、检索语料只存在于 `packages/server`，deployer 与
   桌面服务进程必须复用，不许各写一套。
4. **插件包零宿主依赖**：只允许 `vue` 作为 peerDependency，禁止访问宿主全局。
5. **视觉常量只在 token 里定义**：圆角走 `--dv-ui-radius-*`，动效走 `--dv-ui-dur-*`。
   新增样式不要写字面量时长与圆角——散落值正是「看起来不精致」的源头。

## 改组件或插件

1. 组件源码在 `plugins/base/src/components/`（通用）或 `plugins/audio/src/components/`（场景包）；
2. 同时在四个地方登记，缺一个门禁就红：`plugin.json` 的 `components[]`、`src/index.ts` 的
   `KINDS` 表、`examples/` 下的示例文件、`courses/component-showcase` 的清单与演示章节；
3. `plugins/base/docs/SKILL.md` 要补该组件的语法与字段说明；
4. `pnpm test` 里的 `component-showcase.test.mjs` 会核对清单与演示是否齐全。

## 改文档

`pnpm docs:check` 校验 `docs/` 与根 `AGENTS.md` / `SKILLS-INDEX.md` 的相对链接是否指向真实
文件。新增设计文档放在 `docs/design/`，架构决策放 `docs/architecture/adr/`——**新决策必须写
ADR**，不允许只留在讨论与代码注释里。

## 报告问题

- 缺陷：说明版本、操作系统、复现步骤与期望行为；能附截图或控制台输出最好。
- 安全漏洞：**不要开公开 issue**，见 [SECURITY.md](SECURITY.md)。

## 许可

提交即表示你同意以 [MIT](LICENSE) 许可发布你的贡献。
