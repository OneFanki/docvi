# docvi AGENTS

> 本文件只保留每次任务都必须看到的约束。详细规范按任务读取，禁止无关任务一次性加载全部文档。
> 体量上限：15KB 软限 / 20KB 硬限（`pnpm docs:check` 强制）。

## 项目介绍

docvi 把任意 Markdown 目录变成**可浏览 / 可搜索 / 可交互**的文档站。一份渲染层服务两种宿主：

| 宿主     | 入口           | 说明                                                        |
| -------- | -------------- | ----------------------------------------------------------- |
| 桌面应用 | `apps/desktop` | 本地工作区浏览 + 编辑 + git + 本地服务（MCP / 分享 / 插件） |
| 容器站点 | `deployer/`    | git 仓库编排 + 索引队列 + 多仓门户，对外提供 MCP 与临时分享 |

**零编译渲染**是产品根基：md 原文直出、浏览器端渲染，改完刷新即见，没有构建等待。

**单载体**：桌面与容器共用 `apps/desktop` 的同一份 UI 源码，宿主差异只在 `window.docvi` 由谁提供（Electron preload / 浏览器 HTTP 适配层 `lib/web-host.ts`）。禁止为容器另写一套界面。

## 规则优先级

- 用户当前明确要求 > 数据正确性、权限安全性、现有架构边界 > 局部便利。
- 本文件中的「必须 / 禁止」是**硬约束**；「默认 / 优先」是一般策略，存在充分理由时可调整，但必须说明理由。

## 开发命令

- 安装依赖：`pnpm install`
- 桌面开发：`pnpm docvi:dev`（Electron + Vite 热更新）
- 桌面构建 / 打包：`pnpm docvi:build` / `pnpm docvi:dist`
- 容器版前端产物：`pnpm docvi:build:web`（→ `apps/desktop/dist-web`，deployer 伺服它）
- 全量校验：`pnpm verify`（非 fail-fast，一次暴露全部欠账）
- 单项：`pnpm typecheck` / `pnpm docvi:typecheck` / `pnpm test` / `pnpm docs:check` / `pnpm skills:check` / `pnpm scan:open-source`
- 容器部署器：`cd deployer && pnpm test`；本地起服务见 `README.md`

## 强制约束

### 架构边界

- **依赖方向只能单向**：渲染进程（纯 web）只经 preload 白名单访问宿主，禁止 `node:` / `electron`；主进程不得 import 渲染层；服务进程（`apps/desktop/src/service`）不得 import 窗口层。由 `scripts/check-boundaries.mjs` 守护。
- **宿主差异只有一个收口处**：`window.docvi`（契约在 `packages/shared/src/ipc.ts`）。桌面由 preload 提供，容器由 `lib/web-host.ts` 提供；渲染层问 `hostKind` 决定入口显隐，禁止在各组件里探测「方法是否存在」。
- **服务只有一份实现**：MCP、临时分享、检索语料的协议逻辑只允许存在于 `packages/server`；deployer 与 app 必须复用，禁止各自实现一套。
- **插件包零宿主依赖**：只允许 `vue` 作为 peerDependency；禁止访问 `window` 上的宿主全局、禁止 import 壳内部模块。
- **前端保留路由必须在 deployer 放行**：平台以 `/_` 为运维页命名空间，凡以 `/_` 开头的 SPA 路由
  （如 `/_/preview/…`）不登记就会被 404 兜底拦下；渲染层漏登记则会落进内容加载分支（点入口没反应）。
- **同一份 `index.html` 跨路径深度复用时，相对资产必须给显式基准**：`/s/<id>/` 这类前缀路由下
  相对资产会被解析到前缀里，服务端回落 HTML → 模块脚本拿到 `text/html` → 白屏。
  分享路由回落的入口必须注入 `<base href="/">`（并注意 `<base>` 只对其后的元素生效）。
- **复用 CodeMirror `EditorState` 必须同时重配扩展**：state 里装的是**旧配置**，
  回调型扩展（斜杠/选区上报、表格与图片入口、onChange）全是旧组件实例的闭包，
  切视图后它们写进已销毁实例的 ref，界面毫无反应且日志零报错。
  统一走 `state.update({ effects: StateEffect.reconfigure.of(extensions) }).state`
  （保留文档/选区/history，只换扩展）。

### 安全

- 服务默认只绑 `127.0.0.1`；局域网访问必须显式开关。
- `POST /control/stop` 仅回环地址可调，非回环一律 403。
- 临时分享只暴露**显式登记**的路径；解析后必须 `realpath` 再做共享根判定（防符号链接逃逸）。
- OPS_TOKEN 未配置 = 运维面整体关闭，不是「空口令放行」。
- git 凭证只写入数据卷内的 0600 临时文件，不进入镜像层、不落日志。
- **测试与脚本禁止触碰真实用户数据目录**：凡读写 `%APPDATA%` / `userData` / `~` 的函数，
  路径必须可注入；单测一律传临时目录，禁止依赖默认值。迁移类函数必须自带
  「源与目标相同/互为父子 → 拒绝移动」防御（2026-10-19 曾因此搬走用户 shares.json）。
- **禁止把被保护的具体词写进仓库**：门禁、测试、脚本的用词检查一律写成
  **白名单**（只列允许出现的域名/路径/标识）或**形态正则**（如 `(内部|公司)\s*版`），
  绝不内联真实公司名、内部仓库地址、私有分支名、本机端口等字面量。把清单写进代码
  等于把要保护的对象抄在门牌上——仓库一旦公开，防御清单本身就是泄露源
  （2026-10-26 实测踩到：开源扫描测试里内联了托管商域名与内部分版本的说法）。
  需要逐词黑名单时，只放在 `.scan-deny.local`（已 gitignore，随机器走、不入仓）。
- **公开文档禁止出现本机环境细节**：代理端口、个人目录路径、内网地址一律写成占位符
  （`127.0.0.1:<port>`、`C:\Users\Public`），具体值由使用者按自己环境填。

### 内容与进程

- **端口上的服务必须验指纹再复用**：探活不能只看状态码或 `ok` 字段——同一端口可能住着上一版本的同名服务。只认能力指纹（`service` + `api` 版本）匹配的服务；不匹配按「已占用」处理并自动换端口，否则新端点会静默 404。只有 `ECONNREFUSED` 才算端口空闲。
- **内容根零污染**：聚合模式的所有生成物只写 `.docvi/`；禁止向用户内容目录写任何文件。
- **只杀自己起的进程**：判断归属看命令行参数（`--data-dir` 指向 app 数据目录 = 用户的；指向临时目录 = 测试的）。禁止 `taskkill /IM` 这类按名杀。
- 无头浏览器测试必须唯一端口 + 唯一临时 profile，且同一命令块末尾无条件清理；会话结束前全局巡检。
- 临时产物一律放 `.temp/`（已 gitignore），禁止放进 `docs/`。

### 文档与测试

- **文档不得只追加，改一次压缩一次**：过时信息当场删除、重复合并、同一结论只留一个详细版本。
- 测试断言行为契约与不变量（输入→输出、边界、协议兼容）；**禁止**写「源码里必须出现某字符串」式的变更检测器测试。
- 修复缺陷先查 `docs/engineering/踩坑库.md`，修完当场补条目（含日期）；代价高的坑升级为本文件硬约束。

### 协作

- **单仓主线**：只维护本仓 `main`，不维护平行分叉（见 ADR-0004「仓库策略」）。
- 未得到当次明确指令，不得提交或推送；提交与推送是两个独立授权。
- 禁止 `git add -A` / `git add .` / `git commit -a`，只按显式路径暂存本次任务文件。
- 子代理一律禁止 git 写操作。
- 单载体规则：桌面能力只允许一处实现（`apps/desktop/src/main` + `packages/server` 服务层）；禁止再引入第二个桌面运行时——两套载体必然漂移，这是删除 Tauri 与旧 Electron 宿主的直接教训。
- 预设插件源码留在仓库 `plugins/`；服务层只认 `<包名>/<版本>/` 视图，由 `scripts/assemble-plugins.mjs` 生成（勿手改产物）。

## 质量要求

- TypeScript 保持 strict；不使用 `any` / `@ts-ignore` / `eslint-disable` 绕过类型与规范。
- 修改公共组件、插件协议或公开接口前，先列出消费者与受影响宿主，说明影响面。
- 架构决策写 ADR 到 `docs/architecture/adr/`（**被否方案必填**）；工程规范未覆盖的结构/流程先标 `[待确认]`，不静默拍板。
- 结构决策不留迁移债：引入新结构必须同步给出旧结构的退役路径并推进收敛。
- 单文件膨胀到明显失配时主动拆分（组件 / 组合式 / 类型 / 样式），禁止在失衡结构上继续打补丁。

## 按任务读取

| 任务                                       | 必读                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 了解项目全貌 / 新人上手                    | `docs/project/OVERVIEW.md`；`README.md`                                                                |
| 改目录结构、加包、跨包引用                 | `docs/engineering/目录结构.md`；`docs/architecture/adr/`                                               |
| 改内容根配置 / 索引生成                    | skill `content-model`；`scripts/lib/docs-core.mjs`                                                     |
| 改容器宿主适配 / SPA 路由                  | `apps/desktop/src/renderer/src/lib/web-host.ts`、`web-router.ts`                                       |
| 改 Markdown 渲染、代码高亮、图示           | skill `markdown-rendering`                                                                             |
| 改组件声明式协议 / `<at-*>` 标签           | skill `component-protocol`；`docs/architecture/组件协议.md`                                            |
| 新增或改插件包                             | skill `plugin-development`；`docs/design/平台插件化与 AI 分发.md`                                      |
| 改容器部署器 / 运维 API                    | skill `deployer-ops`                                                                                   |
| 改 Electron 宿主 / 桌面能力                | `apps/desktop/src/main/`；`docs/design/docvi目标架构与实施总案.md`                                     |
| 改主题令牌 / 新增内置主题                  | `packages/renderer-core/src/styles/theme.css`；`apps/desktop/src/renderer/src/lib/theme-options.ts`    |
| 改插件市场清单 / 安装来源                  | `plugins/market.json`；`apps/desktop/src/main/plugin-market.ts`                                        |
| 改容器读者面能力（分支/运维/MCP/本地预览） | `apps/desktop/src/renderer/src/lib/web-host.ts`、`components/BranchPicker.vue`、`lib/local-preview.ts` |
| 改关于面板 / 检查更新                      | `apps/desktop/src/main/update.ts`、`version.ts`；`components/SettingsView.vue`                         |
| 写功能设计（PRD / 方案）                   | `docs/engineering/文档模板.md`                                                                         |
| 新建或重建 feature 文档                    | `docs/engineering/文档模板.md`、`docs/engineering/文档规范.md`                                         |
| 写契约测试 / 门禁脚本                      | `docs/engineering/契约测试规范.md`                                                                     |
| 遇到报错、现象诡异                         | `docs/engineering/踩坑库.md`                                                                           |
| 新建 / 修改项目 skill                      | `.agents/skills/skill-governance/SKILL.md`                                                             |

## 技能沉淀规范

- 创建、编辑、合并 `.agents/skills/` 下任何 skill 前，**先读 `skill-governance`**（命中即自动加载，约束以它为准）。
- 沉淀门槛、description 规则、能力域归并、维护义务全部以该 skill 为准，本文件不重复。
- 新增 / 删除 / 改名 skill 必须同步 `SKILLS-INDEX.md` 与 `pnpm skills:check`。

## Git 规范

- 提交格式 `type(scope): 中文描述`：`type` 只用英文前缀（`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `build`），`scope` 必填且来自自动发现（`packages/*` 目录名、`deployer` / `shell` / `scripts` / `root` …），subject 必须以中文汉字或全角标点开头，header ≤ 100 字符。
- 由 `commitlint.config.mjs` 强制；提交前 `pnpm verify` 至少跑通本次改动相关项。
