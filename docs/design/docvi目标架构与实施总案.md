---
title: docvi 目标架构与实施总案
---

# docvi 目标架构与实施总案

> 状态：设计稿（待拍板）｜ 负责人：Fanki ｜ 创建：2026-10-21 ｜ 更新：2026-10-24（宿主模型修订）
>
> **2026-10-24 宿主模型修订**：本文提到的「deployer / viewer 冻结」已不成立——单文件 viewer 与旧壳
> 已删除；容器 deployer 是**在役的第二种宿主**，伺服 `apps/desktop/dist-web`，与桌面共用同一份渲染层。
> 两种宿主的能力差异只由 `window.docvi` 的提供方决定（preload / `lib/web-host.ts`），
> 渲染层不得按宿主分叉 UI。其余设计内容仍然有效。
>
> 本文是 docs-studio → docvi 重构的唯一设计文档：产品定位、仓库形态、进程模型、渲染与编辑内核、插件体系、UI 规范、旧功能迁移映射与验收口径。实现态细节在代码与 ADR，本文不重复。

## 一、决策摘要

**一句话**：docvi 是一个以「读」为第一能力的本地 Markdown 文档工作台——把任意 Markdown 目录变成排版精致、可交互、可扩展的文档应用；写文档是紧随其后的第二能力。

**已拍板的关键决策**：

| 编号 | 决策       | 结论                                                                          |
| ---- | ---------- | ----------------------------------------------------------------------------- |
| D1   | 桌面载体   | Electron 单载体，沿用现有工程经验，不引入第二运行时                           |
| D2   | UI 框架    | Vue 3 + Pinia + reka-ui + lucide，chrome 全面 Vue 化，废弃手写 DOM            |
| D3   | 编辑器内核 | CodeMirror 6，不做 Monaco                                                     |
| D4   | 编辑形态   | 阅读 / 实时预览（Live Preview）/ 源码 三种模式；Markdown 原文是唯一事实源     |
| D5   | 产品优先级 | 阅读 > 编辑 > 工作流能力（git / MCP / 分享）                                  |
| D6   | 插件模型   | 三层：呈现插件（渲染进程）、服务插件（独立进程）、贡献点（纯声明）            |
| D7   | 插件底座   | 自研轻量容器（约 300 行），不引入 Cordis                                      |
| D8   | 宿主策略   | app 为唯一完整宿主；web 复用渲染核心、独立最小 chrome；deployer / viewer 冻结 |
| D9   | 仓库策略   | 单仓 `main` 主线持续迭代，不维护平行分叉                                      |
| D10  | 工程门禁   | ESLint + Prettier（不用 Biome 作为唯一格式化器）+ vitest + 自定义 verify      |

**为什么不用 Monaco**：Monaco 的排版模型是「全局固定行高 + 代码视觉」，文档所需的标题/图片/表格/组件块等可变高度内容只能塞进 ViewZone，而 ViewZone 在 Monaco 长期是二等能力（点击命中、位置、API 均不完整）。VS Code 自己的 Markdown 预览也不是 Monaco 渲染的，而是独立 webview。CM6 默认零样式、支持块级 Widget 与装饰，是 Obsidian Live Preview 的技术基础。

**为什么不用 Cordis**：Cordis 解决的是「服务之间的依赖与生命周期」，而 Electron 的窗口、菜单、协议、托盘、自动更新都是命令式宿主生命周期，硬塞进 context 树只多一层无收益的中间层；渲染层已有 Vue 响应式，再叠一套依赖追踪是双重心智模型。自研容器可拿到八成收益而不绑框架，M3 再评估是否需要外部方案。

---

## 二、产品定位与边界

### 2.1 定位

**「读文档最好的桌面应用」是主定位，「写文档」是第二能力。**

现有的差异化资产全部在阅读侧：零编译渲染、术语块与正文排版、深色对比度模型、24 个通用组件、表关系图、多标签、文档内查找、主题 token。这些是装三个 VS Code 扩展也拼不出来的。

### 2.2 能力分层

| 层        | 内容                                                                   | 优先级                 |
| --------- | ---------------------------------------------------------------------- | ---------------------- |
| L1 阅读   | 打开目录、树、大纲、正文排版、组件渲染、主题、搜索、多标签、文档内查找 | 最高，构成壁垒         |
| L2 编辑   | 实时预览、源码模式、保存与冲突、格式化、草稿恢复                       | 高，但不做富文本编辑器 |
| L3 工作流 | git、MCP、临时分享、索引、AI 集成                                      | 中，全部插件化         |
| L4 发布   | 静态导出、web 阅读页                                                   | 低，次级宿主           |

### 2.3 明确不做

- **不做代码编辑器**：没有 IntelliSense、LSP、调试器、终端。代码块只是高亮展示。
- **不做富文本编辑器**：不追求合并单元格、图文环绕、自由布局这类 Markdown 表达不了的排版。需要时通过「结构化块 + 插件」提供专用编辑器。
- **不做在线协作**：不引入账号体系、不引入服务端存储。
- **不做移动端**（第一版）。
- **deployer 容器与单文件 viewer 冻结**：不进入新架构，代码保留在冻结目录，不再跟随重构。

---

## 三、命名与标识（一次改到位）

产品名 **docvi · 页间**。英文负责唯一性与可读性，中文负责气质与记忆度，二者意会不直译（对齐 Ensemble · 同台 的做法）。

| 项               | 值                                                             | 说明                                                      |
| ---------------- | -------------------------------------------------------------- | --------------------------------------------------------- |
| 产品名           | `docvi`                                                        | 全小写；标题栏显示 `docvi`，品牌场景可写作 `docvi · 页间` |
| npm scope        | `@docvi/*`                                                     | 已核实可用（org 不存在）                                  |
| appId            | `app.docvi`                                                    | electron-builder 的 `appId`                               |
| productName      | `docvi`                                                        | 安装包与快捷方式名                                        |
| 数据目录         | `%APPDATA%/docvi`（mac `~/Library/Application Support/docvi`） | 从旧 `@docs-studio/desktop` 一次性迁移需用户确认          |
| 自定义协议       | `docvi://`                                                     | 静态资源、插件资源统一走该协议，不用 `file://`            |
| workspace 元数据 | 用户目录内**不写任何文件**                                     | 索引与缓存全部放数据目录                                  |
| 内容配置         | `docs.config.yaml`                                             | 内容协议名，与产品名解耦，保持不变                        |
| 组件标签         | `<at-kind>`                                                    | 内容协议前缀，保持不变（156 篇存量文档依赖）              |
| CSS 变量前缀     | `--dv-*`                                                       | 旧 `--at-*` 全量替换（无外部主题依赖，可安全更名）        |
| 本地存储键       | `docvi.*`                                                      | 例：`docvi.tabs.v1`、`docvi.locale`、`docvi.theme`        |
| IPC 通道前缀     | `docvi:`                                                       | 例：`docvi:workspace:add`                                 |
| CLI / 命令       | `docvi`                                                        | 单文件打开、`--service` 无界面档                          |

**防御性注册清单**（一次做完，成本很低）：

- npm：发布 `docvi` 占位包 + 创建 `@docvi` 组织；同时占 `docvy`、`docvee`（听觉变体）。
- 域名：`docvi.md`（主）、`docvi.app`、`docvi.dev`、`docvi.io`。
- GitHub：`<org>/docvi`（开源时确定）。

**命名风险（已核查）**：Pearl Abyss 的《DokeV》是同名读音相近的游戏，仍处开发中（目标 2028–2029），未发布、未取消。它与本产品品类不同（游戏 vs 生产力工具），拼写也不同（DokeV / docvi，5 个字母中 2 个不同），读音上英文报道存在 doh-KEV 与 doh-KAYV 两种读法而 docvi 为 DOC-vee，重音与元音均不同。判断：**不构成实质冲突**，但 DokeV 若在 2028 年后成为大作，搜索侧可能出现少量噪声。不阻塞命名。

---

## 四、仓库与包边界

### 4.1 目录形态

```
apps/
  desktop/                 # Electron 主进程 + preload + 唯一完整 renderer
    src/main/
    src/preload/
    src/renderer/
  web/                     # 次级阅读端（L4，最后做；复用 renderer-core）
packages/
  shared/                  # 类型、zod schema、IPC 契约（无运行时依赖）
  renderer-core/           # markdown 管线、组件注册表、主题 token、大纲、索引构建
  content/                 # ContentPort 接口 + ipc / http 两实现
  editor/                  # CM6 封装、Live Preview 状态机、块级 Widget
  plugin-api/              # 插件协议类型（可对外发布，零实现）
  plugin-runtime/          # manifest 校验、加载、容器、信任分级
  ui/                      # 基础控件（Button/Dialog/Menu/Tree/Toast…）
plugins/
  base/                    # 24 个通用组件（必装）
  audio/                   # 3 个音频组件（可选安装，公开包）
courses/                   # 示例内容根
docs/                      # 设计文档与 ADR
scripts/                   # 构建、门禁、图标
```

### 4.2 依赖方向（硬约束）

```
                    apps/desktop
                   ↗     ↑      ↖
        plugin-runtime  ui   content
             ↓         ↓       ↓
        plugin-api  renderer-core
                   ↗
              editor

shared ← 所有包（只被依赖，不依赖任何包）
```

规则：

1. `renderer-core` **禁止** import `electron` / `node:*` / `content`，必须能在纯浏览器跑（web 复用前提），由 `boundaries:check` 守护。
2. `editor` 依赖 `renderer-core`（复用组件注册表渲染块级组件），反之禁止。
3. `plugin-api` 只有类型与常量，无运行时依赖。
4. `plugins/*` 只允许 `vue` 作为 peerDependency + `plugin-api` 类型。
5. `apps/web` 只允许依赖 `renderer-core` + `content` + `ui`，禁止 import `apps/desktop` 与 `plugin-runtime` 的 Node 侧。

### 4.3 为什么不再「一份壳服务四宿主」

旧壳把「站点 / app / viewer / 分享」四种宿主平权，每个 UI 决策都要问「另外三个怎么办」——这是 app 端被拖累的根源。新架构反过来：**app 是产品本体，web 是复用渲染核心的另一个入口**。内容渲染与窗口 chrome 彻底分开，chrome 只为 app 设计。

---

## 五、进程模型

### 5.1 职责划分

| 进程                               | 职责                                                                                                                                                                | 生命周期     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| main                               | 窗口、原生菜单、托盘、自启动、文件对话框、单实例锁、文件关联、协议注册、自动更新、全局快捷键、设置与最近打开、**文件系统访问**、workspace worker 管理、服务进程托管 | 随 app       |
| preload                            | contextBridge 白名单桥；`webUtils.getPathForFile` 取拖放真实路径；订阅事件                                                                                          | 随窗口       |
| renderer                           | Vue 应用、CM6 编辑器、组件渲染、插件 UI 宿主；**无 Node 权限**                                                                                                      | 随窗口       |
| workspace worker（worker_threads） | 目录扫描、搜索索引构建、文件监听、增量更新；不阻塞主进程事件循环                                                                                                    | 随 workspace |
| service（utilityProcess）          | 本地 HTTP：MCP 端点、临时分享代理；git 操作；可 `--service` 无窗口独立运行                                                                                          | 可跨窗口存活 |

**为什么把索引放 worker、服务放独立进程**：两者生命周期不同。索引随 workspace 打开/关闭，放 worker 避免阻塞主进程；MCP 与分享需要在窗口关闭后继续可用，必须是独立进程。

### 5.2 IPC 契约

```ts
// packages/shared/src/ipc.ts
export const IPC = {
  workspaceList: 'docvi:workspace:list',
  workspaceAdd: 'docvi:workspace:add',
  treeList: 'docvi:tree:list',
  docRead: 'docvi:doc:read',
  docWrite: 'docvi:doc:write',
  docExternalChanged: 'docvi:doc:external-changed',
  searchQuery: 'docvi:search:query',
  findInPage: 'docvi:find',
  findInPageStop: 'docvi:find:stop',
  // …
} as const

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } }
```

规则：

- 每个通道的入参与出参都有 zod schema，主进程入口统一校验，不信任渲染进程输入。
- 统一 `Result` 信封，异常不跨进程抛（避免 Electron 把 Error 序列化成不可读字符串）。
- 文件读取有大小上限（单文档 20MB），超限返回明确错误码而不是把内存打满。
- 事件推送用单向 `webContents.send`，preload 暴露 `onXxx(cb) => unsubscribe`，禁止常驻监听不释放。

### 5.3 自定义协议

`docvi://` 注册为 standard + secure scheme（`protocol.registerSchemesAsPrivileged` 于 `app.ready` 前）：

| 路径                              | 内容                                                |
| --------------------------------- | --------------------------------------------------- |
| `docvi://app/*`                   | 生产环境渲染产物（dev 走 Vite server）              |
| `docvi://plugin/<id>/<version>/*` | 插件产物（只读，来自 resources 或数据目录 plugins） |
| `docvi://asset/<workspaceId>/*`   | 文档内图片等资产（经主进程做路径校验后伺服）        |

**为什么不用 `file://`**：模块脚本在 `file://` 下受 CORS 与 MIME 限制，且无法做 CSP 与路径收敛。自定义协议可统一做 CSP、路径穿越校验、插件资源隔离。

CSP（生产）：

```
default-src 'self';
script-src 'self' docvi:;
style-src 'self' 'unsafe-inline' docvi:;
img-src 'self' data: blob: docvi:;
font-src 'self' docvi:;
connect-src 'self' docvi:;
```

`connect-src` 默认不含外网：呈现插件不能自行发起网络请求（AI/更新等能力必须走服务插件）。

---

## 六、渲染核心 renderer-core

### 6.1 管线

```
Markdown 原文
  → frontmatter 解析（yaml）
  → markdown-it（raw HTML 关闭，按文档显式开启并 sanitize）
      ├─ 基础：anchor / table / strikethrough / task list
      ├─ 自有规则：术语块 at_term_blocks、颜色增强 code_inline、容器语法
      └─ 插件贡献：markdownSyntax 扩展（按 info string 或自定义 token 注册）
  → 组件占位（<at-kind data-key> → 查 frontmatter components 段）
  → Vue 渲染（h() + 组件注册表）
  → 后处理：Shiki 高亮（按需语言）、Mermaid（按需加载）、图片尺寸
```

**性能约束**：

- Shiki 使用细粒度包 + 按需加载语言，禁止全量语言包进主 chunk（旧实现的主要体积来源）。
- Mermaid 只在文档含 ```mermaid 时动态 import。
- 组件按 kind 懒加载：首屏只加载当前文档用到的组件包。

### 6.2 组件注册表（Vue 原生）

旧架构：插件产物 export Vue 组件 → `defineCustomElement` 包装 → `<at-kind>` 自定义元素 → 壳用 `vue-shim` + import map 保证单 Vue 实例。

新架构分两路：

- **内置插件（base / audio）**：构建期打包进 renderer，直接 `h(component, props)`，无自定义元素、无 shim。
- **外部插件**：运行时动态 import。`docvi://app/vue-runtime.js` 作为独立入口导出宿主 Vue，插件加载前注入 import map `{"vue": "docvi://app/vue-runtime.js"}`，保证单实例。

这样内置路径零开销，外部路径保留兼容性。

### 6.3 ContentPort

```ts
export interface ContentPort {
  listTree(): Promise<TreeNode[]>
  readDoc(path: string): Promise<{ text: string; mtime: number; size: number }>
  writeDoc(path: string, text: string): Promise<{ mtime: number }>
  readAsset(path: string): Promise<ArrayBuffer>
  watch(onChange: (events: FsEvent[]) => void): () => void
}
```

- app 实现：IPC 转发到主进程；web 实现：HTTP。
- 路径安全：normalize → 拒绝 `..` → `realpath` 后判定仍在 workspace 根内（防符号链接逃逸），与旧分享路由同一套判据。
- 缓存：树按 mtime 失效；文档按 `(path, mtime)` 缓存；切换标签不重复解析。

### 6.4 主题 token 单一体系（2026-10-23 收敛）

**一个主题 = 一整套变量**，同时决定窗口 chrome、文档渲染、编辑器语法色和组件角色色。
没有独立的「深/浅」维度：`paper` / `graphite` 只是内置的两套主题，一套浅一套深，
不是两套相互正交的开关。理由与 VS Code / WebStorm 一致——编辑区与阅读区的明暗
必须和外壳同步，否则切换主题会得到「白壳黑编辑器」这种半截效果。

| 层     | 前缀         | 内容                                                     | 谁能改   |
| ------ | ------------ | -------------------------------------------------------- | -------- |
| UI     | `--dv-ui-*`  | 窗口底色、表面、发丝线、文字、强调色、圆角、阴影、动效   | 主题插件 |
| 文档   | `--dv-doc-*` | 文档底色/表面/边框/文字/强调、代码底、图形画布、排版尺度 | 主题插件 |
| 编辑器 | `--dv-ed-*`  | CM6 底色、行号、选区、光标、语法高亮色                   | 主题插件 |
| 组件   | `--dv-c-*`   | 文档层的角色投影，插件组件只依赖它                       | 只读派生 |

选择器只有一套：全部挂在 `:root[data-theme='<主题 id>']` 上。`.doc-surface` 不再有
`data-doc-theme`，编辑器不再有 `data-editor-theme`；导出 HTML 也写同一个 `data-theme`。
历史 `--at-*` 变量仍作为 `.doc-surface` 内的别名存在，指向 `--dv-c-*`，供未迁移的组件包使用。

插件主题协议相应简化：`contributes.themes[]` 只需要 `{ id, title, appearance, tokens }`，
原本的 `targets` 字段被删除——一个主题要么整套提供，要么不提供。

**局部覆盖靠 `data-appearance` 继承**：插件主题允许只声明自己关心的变量（例如只给
正文换一套配色，窗口与编辑器沿用内置外观）。为了不让这种情况拼出「浅色正文 + 深色
窗口」的半截外观，每组主题选择器都额外挂了同明暗的基底分支：

```css
:root,
:root[data-theme='graphite'],
:root[data-appearance='dark'] {
  /* 深色整套 */
}

:root[data-theme='paper'],
:root[data-appearance='light'] {
  /* 浅色整套，排在后以覆盖深色 */
}
```

渲染层每次解析主题时把明暗写进 `documentElement.dataset.appearance`，因此插件没声明的
变量从同明暗的内置主题继承，而不是一律落到 `:root` 的深色默认。这个属性也是主进程
唯一需要的主题信息，见下一段。

`appearance: 'light' | 'dark'` 有两个消费者：一是上面的继承基底，二是窗口 chrome。
Windows 的 `titleBarOverlay` 由系统原生绘制，不读页面 CSS，主进程只能拿到明暗这个
粗粒度信息。渲染层在切换主题时通过 `docvi:window:appearance` 把解析后的明暗推给主进程，
由主进程调 `setTitleBarOverlay`（`color` 取 `--dv-ui-bg`，`symbolColor` 取 `--dv-ui-text`）。
启动时的初值由主进程读设置里的主题 id 推断，避免首帧闪一下深色按钮。

内置主题：

| 主题       | 外观 | 底色      | 正文                            | 强调             |
| ---------- | ---- | --------- | ------------------------------- | ---------------- |
| `paper`    | 浅色 | `#f7f4ee` | `#1f1d19`                       | 赭石 `#833d20`   |
| `graphite` | 深色 | `#14161a` | `#c9c6bf`（标题更亮 `#e8e5de`） | 暖琥珀 `#d9a05b` |

实测对比度（已用 WCAG 公式计算，非估算）：

| 组合                 | 比值    |
| -------------------- | ------- |
| paper 正文 / 底色    | 15.33:1 |
| paper 强调 / 底色    | 7.21:1  |
| graphite 正文 / 底色 | 10.62:1 |
| graphite 标题 / 底色 | 14.40:1 |
| graphite 强调 / 底色 | 7.87:1  |
| 白字 / paper 强调底  | 7.91:1  |

对比度门禁：正文/背景 ≥ 7:1（AAA），次要文字与强调色 ≥ 4.5:1，`theme:check` 在 CI 计算并硬失败。

### 6.5 排版规范（内容层默认值）

| 项           | 值                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 正文 measure | 68ch（可选 56 / 68 / 80 / 全宽）                                                                                                           |
| 正文行高     | 1.8                                                                                                                                        |
| 标题行高     | 1.3                                                                                                                                        |
| 标题梯度     | h1 32 / h2 24 / h3 20 · 650 / h4 17 · 600 / h5 15 · 650 + 字距 / h6 14 · 650 + 更大字距                                                    |
| 段间距       | 0.95em                                                                                                                                     |
| 字体栈       | 正文中西文混排：Latin 字体在前、CJK 字体紧随、generic 垫底；等宽栈**必须把 CJK 无衬线体排在 generic monospace 之前**（否则中文回落到宋体） |
| 术语块       | 左侧 3px 竖线 + 术语行 + 行距 1.85（沿用现有规则与 48 字上限）                                                                             |

### 6.6 大纲与索引

- 大纲：从渲染后的 heading 提取，仅 h2–h4（h1 是文档标题），滚动高亮当前节。
- 搜索索引：worker 内构建 minisearch（标题权重 3、标题路径 2、正文 1），字段含 `path/title/headings/body`；文件变更 300ms 防抖增量更新；索引缓存到数据目录。
- 命令面板（⌘K）合并四类结果：文档、标题、命令、设置项。

---

## 七、编辑器

### 7.1 三种模式

| 模式         | 实现          | 说明                                                                                            |
| ------------ | ------------- | ----------------------------------------------------------------------------------------------- |
| 阅读（默认） | renderer-core | **不挂载 CM6**，零编辑器开销；文档内查找用 `webContents.findInPage`（原生高亮、循环、自动滚动） |
| 实时预览     | CM6 + 装饰层  | 光标所在行显示源码，其余渲染成品（Obsidian Live Preview 模型）                                  |
| 源码         | CM6 原样      | 关闭装饰扩展，纯文本编辑                                                                        |

模式是**视图状态**，不改变文档格式。任何模式写出的都是同一份 Markdown。

### 7.2 CM6 扩展清单

| 扩展                               | 作用                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| `@codemirror/lang-markdown`        | 语法树、frontmatter                                              |
| `@codemirror/commands` / `history` | 编辑命令、撤销栈                                                 |
| `@codemirror/search`               | 编辑模式内 ⌘F                                                    |
| 自定义 `Decoration`                | 标题字号、加粗/斜体/行内代码、链接、列表符号、引用、分割线       |
| `WidgetType`                       | 图片、表格、代码块（Shiki）、Mermaid、组件块、frontmatter 折叠卡 |
| `StateField` + `RangeSetBuilder`   | 装饰状态，只在文档或视口变化时重建                               |
| `EditorView.lineWrapping`          | 软换行（文档必须）                                               |

### 7.3 Live Preview 状态机

规则必须显式，否则会出现闪烁、光标跳动、IME 错位：

1. **光标行展开**：光标所在的行显示原始 Markdown；离开后恢复渲染。跨行选区时，选区覆盖的所有行都保持源码态。
2. **IME 冻结**：`compositionstart` → 暂停装饰重建；`compositionend` → 下一帧恢复。中文输入法组合期间**绝不**修改装饰。
3. **视口窗口化**：只对可见范围 ±2000px 构建装饰，长文档不做全量。
4. **块级组件不参与选区**：组件 Widget 在编辑态默认显示为「已渲染但不可编辑」的卡片，点击卡片进入该段的源码行；不允许在 Widget 内部直接编辑（避免两套状态冲突）。
5. **表格**：块内默认渲染为只读表格；块右上角「编辑表格」打开网格编辑器（改格子 / 加删行列 / 循环对齐），保存时序列化成**标准 Markdown 原文**写回同一区间。不做单元格内直接编辑（需要自定义选区映射）；也不在原生表格里提供合并单元格——那是 `::: merged` 富组件的能力，混进来会让人误以为原生表格也能合并。
6. **性能**：装饰重建在 `requestAnimationFrame` 内合并；`ResizeObserver` 触发 `requestMeasure()` 时做节流。
7. **解析器唯一**：实时预览与阅读态读 frontmatter 必须调同一个 `readFrontmatter`（`renderer-core`）。曾经为了「编辑态快一点」在 `editor` 包里写过一份手写 YAML 迷你解析器，只认标量、丢掉数组，结果所有带数组数据的富组件（流程/时间线/清单…）在编辑态全部渲染成空壳——**这是本类 bug 的唯一来源，不允许再出现第二份解析**。
8. **frontmatter 折叠成一行芯片**：文档顶部的 YAML 是元数据，不是正文。编辑态默认折叠为单行「frontmatter」芯片，点击展开；阅读态不渲染。用户写正文时不该被十几行 YAML 顶到屏幕外，也大概率看不懂那些键。

### 7.3.1 可视化编辑（三层，逐步落地）

目标：用户不必背 Markdown 语法，但**产物仍是标准 Markdown**——可视化只是原文之上的一层外壳，任何时刻关掉它都能回到干净源码。据此分三层：

| 层  | 内容                                       | 状态                                                             |
| --- | ------------------------------------------ | ---------------------------------------------------------------- |
| 1   | 斜杠插入菜单、选区气泡、原生表格网格编辑器 | 已实现                                                           |
| 2   | 富组件的表单式属性编辑（流程/时间线/清单） | 待定：先看第一层的实际使用手感                                   |
| 3   | 画布式编辑（流程图拖拽、合并表格拖选合并） | 待定：成本高，且组件数据在 YAML 里，必须先证明第二层的表单不够用 |

第一层的三条纪律：

- **插入前就区分类型**：菜单分「标准 Markdown / 富组件」两组并写明产物性质。事后再用颜色标注是补救，用户在做选择的那一刻才需要知道。
- **富组件插入是一次事务**：frontmatter 声明与正文 `<at-*>` 引用必须在同一事务里落盘。分两步写会让 Ctrl+Z 留下孤儿声明；光标位置要按文件头增长量修正，否则引用会写进 YAML。
- **浮层只在实时预览出现**：源码模式的承诺是「所见即文件」，任何浮层都会破坏这个承诺；`:::` 容器块在编辑态也必须走与阅读态同一条渲染管线，否则同一个块在两处长得不一样。
- **源码模式要能数出缩进**：行首空白是 Markdown 语法的一部分（列表嵌套、代码块、引用续行），但正文用比例字体，一段留白无法判断是缩进还是行号间隙。三条措施并用：行号槽与正文之间画可见分界线、正文左内边距收窄到 14px、行首每个空格/制表符画一个淡点（`leading-whitespace.ts`，只在源码模式挂载，实时预览 0 个点）。

### 7.4 组件 Widget 的 Vue 生命周期

```ts
class VueWidget extends WidgetType {
  eq(other) {
    return other.kind === this.kind && other.hash === this.hash
  } // 避免重建
  toDOM(view) {
    /* 创建挂载点 */
  }
  destroy(dom) {
    /* app.unmount()，清理 ResizeObserver */
  }
}
```

三条硬约束：

- `eq()` 必须比较「kind + 数据 hash」，否则每次滚动都重建组件（内存泄漏与闪烁）。
- `destroy()` 必须 `unmount()` Vue 实例并断开观察器。
- 高度变化通过 `ResizeObserver` → `view.requestMeasure()`，不允许直接改 DOM 尺寸。

### 7.5 保存与冲突

- 保存：写临时文件 + rename（原子替换），保留原文件权限。
- 外部变更：主进程 `fs.watch` 推送；若缓冲区无修改 → 静默重载；有修改 → 冲突对话框（保留我的 / 重新加载 / 查看差异）。
- 草稿：未保存缓冲每 5 秒写数据目录 `drafts/`，崩溃后恢复提示；正常保存后删除。
- 自动保存：默认关闭，设置项可开（仅在文档已有文件路径时）。

### 7.6 文档内格式化（与仓库代码格式化区分）

- **仓库代码**：ESLint + Prettier，CI 与提交钩子执行（见第十一节）。
- **文档内容**：只格式化 frontmatter YAML 与代码块；**禁止**默认重排正文段落与表格对齐——那会破坏作者手写的排版，违背「Markdown 原文是事实源」。

---

## 八、插件系统

### 8.1 三层模型

| 层             | 运行位置                   | 能做什么                                    | 信任                                       |
| -------------- | -------------------------- | ------------------------------------------- | ------------------------------------------ |
| A 呈现插件     | renderer                   | 组件、主题、Markdown 语法扩展、贡献点声明   | 安装时提示；受 CSP 限制（无外网、无 Node） |
| B 沙箱服务插件 | 独立 worker/utilityProcess | 受限 API 的 Node 能力（显式授权目录、网络） | 安装时逐项授权                             |
| C 受信服务插件 | service 进程               | 完整 Node（git、MCP、AI、同步）             | 安装时红色警告 + 手动确认                  |

**诚实声明**：A 层插件是代码，运行在渲染进程内，能操作 DOM 与本地存储。CSP 能阻断外联与 Node 逃逸，但不能阻止它破坏页面本身。因此「安装即信任」，市场侧后续引入签名与审核。

### 8.2 贡献点

| 贡献点           | 层  | 说明                                           |
| ---------------- | --- | ---------------------------------------------- |
| `components`     | A   | kind + Vue 组件 + 示例 + 本地化元数据          |
| `themes`         | A   | token 集合 + 外观 + 可选资产                   |
| `markdownSyntax` | A   | 解析扩展（fence info / 自定义容器 / 行内规则） |
| `commands`       | A/C | 命令 id + 标题 + 快捷键                        |
| `menus`          | A/C | 标题栏 / 状态栏 / 右键 / 命令面板              |
| `settings`       | A/C | 配置项 schema（zod）                           |
| `panels`         | A   | 侧栏 / 底部面板                                |
| `services`       | C   | 长驻服务（git / mcp / share / ai）             |

**合并单元格表格**落点：`markdownSyntax` 提供 `table kind=merged` 围栏块 → 插件同时贡献「渲染器 + 网格编辑器面板」。Markdown 仍是事实源，结构化数据以 YAML 形式写在围栏块内。这是「Markdown 表达不了的排版交给结构化块」这一原则的样板。

### 8.3 manifest

```json
{
  "name": "base",
  "displayName": { "zh": "通用组件包", "en": "General Components" },
  "version": "1.0.0",
  "apiVersion": "1",
  "trust": "presentation",
  "renderer": "./dist/index.js",
  "styles": ["./dist/style.css"],
  "contributes": {
    "components": [
      {
        "kind": "flow-diagram",
        "title": { "zh": "流程图", "en": "Flow Diagram" },
        "description": { "zh": "…", "en": "…" },
        "example": "examples/flow-diagram.md"
      }
    ],
    "themes": [{ "id": "paper", "appearance": "light", "tokens": "themes/paper.json" }],
    "commands": [{ "id": "docvi.doc.toggleMode", "title": { "zh": "切换模式" } }]
  }
}
```

规则：`apiVersion` 主版本不匹配拒载；`kind` 全局可重名但「活跃实现唯一」（沿用旧同名切换语义）；manifest 校验失败给出可读错误，不静默跳过。

主题条目只需要 `id` / `title` / `appearance` / `tokens` 四个字段：`tokens` 描述一整套主题，
不再有「只改文档层」或「只改编辑器层」的局部主题（`targets` 字段已于 2026-10-23 删除）。
一个主题插件可以声明任意多套主题，用户在主题选择器里看到的是扁平列表，带一个明暗标记点。

### 8.4 加载与生命周期

自研容器（`packages/plugin-runtime`）：

```ts
interface PluginContext {
  pluginId: string
  version: string
  config: unknown // 按 schema 校验后注入
  log: Logger
  register(contribution): Disposable
  inject<T>(serviceId: string): T // 服务插件之间
  on(event, handler): Disposable
}

container.register(id, factory, { deps })
await container.activateAll() // 拓扑排序，依赖缺失则跳过并报错
await container.disposeAll() // 逆序销毁
```

- 激活失败不阻塞其他插件（错误隔离 + 面板可见）。
- 开发态支持热重载（dispose 后带 cache-bust 重新 import）。
- 所有资源（命令、菜单、快捷键、样式）通过 `Disposable` 反注册，禁止残留。

### 8.5 安装与更新

- 第一版：从文件夹安装 / 从 zip 安装（`resources/plugins` 为内置，数据目录 `plugins/` 为用户安装）。
- 版本目录 `<id>/<version>/`，清单校验后原子切换。
- **安装与更新永不静默执行代码**：先解析 manifest，展示贡献点与信任等级，用户确认后落位。
- 不引入自动更新插件（避免供应链风险），由用户显式更新。

---

## 九、UI 设计系统

### 9.1 窗口骨架

```
┌──────────────────────────────────────────────────────────────────┐
│ 44px 标题栏   docvi · 工作区名         文档标题/面包屑   ⌘K  ─ □ ✕ │
├────┬──────────────┬────────────────────────────┬────────────────┤
│56px│ 260px 文档树  │        文档画布             │ 240px 大纲      │
│图标│ （可折叠）     │   measure 68ch（可调）      │ （可折叠）      │
│栏  │              │                            │                │
├────┴──────────────┴────────────────────────────┴────────────────┤
│ 24px 状态栏   路径 · 字数/阅读时间 · 保存态 · 服务 · 分支          │
└──────────────────────────────────────────────────────────────────┘
```

- **标签条 36px**：仅在打开 ≥2 个文档时出现（单标签不占位，避免布局跳动，沿用旧教训）。
- **左图标栏**：库 / 搜索 / 插件 / 设置，四项固定，不做可配置（降低认知成本）。
- **大纲**：文档含 ≥2 个 h2–h4 时才显示；否则自动让位。
- **Zen 模式**：⌘⇧F，左右栏全部收起，正文居中，状态栏保留。

### 9.2 三个视图

| 视图          | 布局                                 | 说明                                                        |
| ------------- | ------------------------------------ | ----------------------------------------------------------- |
| 库（Library） | 图标栏 + 工作区卡片网格 + 最近打开   | 空状态引导「添加目录」；卡片含名称/路径/文档数/最近打开时间 |
| 阅读          | 树 + 画布 + 大纲                     | 默认视图；打开工作区即进入最近文档                          |
| 编辑          | 同阅读 + 编辑器工具条 + 状态栏行列号 | 工具条只在编辑模式出现，阅读模式零工具条                    |

设置是**整页**（不是弹窗），左侧分类 + 右侧表单，与 IDE 习惯一致。

### 9.3 视觉规范

| 项         | 值                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 圆角       | `--dv-ui-radius-sm` 5 / `md` 7 / `lg` 9（比旧版更紧，工具感）                                               |
| 边框       | 1px 发丝线；不用重阴影，浮层用 1px 线 + 极浅投影                                                            |
| 表面层次   | bg → surface-1 → surface-2 三级，最大明度差 6%                                                              |
| 动效       | `--dv-ui-dur-1` 120ms / `dur-2` 180ms / `ease` cubic-bezier(0.2, 0, 0.13, 1)；尊重 `prefers-reduced-motion` |
| 焦点       | 全局 `:focus-visible` 2px 强调色环 + 2px 间隙，不允许浏览器默认方框                                         |
| 图标       | lucide，16px 默认、14px 紧凑；线性 stroke 1.6                                                               |
| 强调色用量 | 只用于选中、焦点、主按钮、当前项；正文内不出现强调色块                                                      |

### 9.4 基础控件清单（`packages/ui`）

Button（primary/secondary/ghost/danger × sm/md/lg）、IconButton、Input、Textarea、Select、Checkbox、Radio、Switch、Segmented、Slider、Dialog、Sheet、Menu、ContextMenu、Tooltip、Popover、Toast、Banner、EmptyState、Badge、Kbd、Spinner、Progress、Tree、Tabs、SplitPane、ScrollArea。

基于 reka-ui 的无样式原语封装，保证键盘导航、焦点陷阱、ARIA 正确。

### 9.5 快捷键（默认，可改）

⚠️ 下表的**实际实现**以 `apps/desktop/src/renderer/src/lib/shortcuts.ts` 为准（应用内 Ctrl+/ 打开帮助面板，内容来自同一份表）。规划与落地不一致的以代码为准，下表已按 S6 落地状态校正。

| 键                                | 动作                                                | 状态                               |
| --------------------------------- | --------------------------------------------------- | ---------------------------------- |
| ⌘K / Ctrl+K                       | 命令面板 + 全文搜索                                 | 已实现                             |
| ⌘F / Ctrl+F                       | 文档内查找（阅读态 CSS Highlight，编辑态 CM6 搜索） | 已实现                             |
| ⌘S / Ctrl+S                       | 保存                                                | 已实现                             |
| ⌘E / Ctrl+E                       | 切换阅读 / 实时预览                                 | 已实现                             |
| ⌘/ / Ctrl+/                       | 快捷键帮助                                          | 已实现                             |
| ⌘O / Ctrl+O                       | 打开单个文件                                        | 已实现                             |
| ⌘W / Ctrl+W                       | 关闭当前标签                                        | 已实现                             |
| ⌘Tab / ⌘⇧Tab                      | 下一个 / 上一个标签                                 | 已实现                             |
| ⌘⇧L                               | 切换整体主题（三维度一起）                          | 已实现                             |
| ⌘B / ⌘I（编辑态）                 | 加粗 / 斜体（同键取消）                             | 已实现                             |
| ←→ / Home / End（标签条、目录树） | 标签与树内导航                                      | 已实现                             |
| ⌘P                                | 快速打开文档                                        | 未实现（命令面板已覆盖，暂不单列） |
| ⌘⇧E                               | 切换实时预览 / 源码                                 | 未实现（状态栏可切换）             |
| ⌘⇧F / ⌘B / ⌘⇧O / ⌘,               | Zen / 侧栏 / 大纲 / 设置                            | 未实现（侧栏固定、无 Zen）         |

---

## 十、旧功能迁移映射（全量对齐）

| #   | 旧功能                                  | 旧落点                          | 新落点                    | 对齐判据                                 |
| --- | --------------------------------------- | ------------------------------- | ------------------------- | ---------------------------------------- |
| 1   | Markdown 渲染（GFM、表格、任务列表）    | shell/render/markdown.ts        | renderer-core             | 同一文档渲染结果一致（DOM 结构快照对比） |
| 2   | 术语块 / 步骤标题 / 设问标题            | markdown core 规则              | renderer-core             | 700 处存量文档抽样 30 篇，块级结构一致   |
| 3   | 行内代码颜色增强                        | code_inline 规则                | renderer-core             | 颜色字面量全部识别，非颜色不受影响       |
| 4   | Shiki 高亮                              | shell/render/highlight.ts       | renderer-core             | 代码块高亮与语言按需加载                 |
| 5   | Mermaid                                 | shell/render/mermaid.ts         | renderer-core             | 图表渲染 + 缩放拖拽                      |
| 6   | 24 个通用组件                           | plugins/base（custom elements） | plugins/base（Vue 原生）  | 24 个示例全部渲染，交互可用              |
| 7   | 3 个音频组件                            | plugins/audio                   | plugins/audio（可选插件） | 3 个示例渲染                             |
| 8   | 组件示例预览                            | `/_/preview/:name/:kind`        | 插件面板内预览            | 每个 kind 可预览                         |
| 9   | 目录树 / 落地页 / 文件夹图标            | shell/host                      | apps/desktop 侧栏         | 三种节点状态一致                         |
| 10  | 工作区（添加/探测/多仓/持久化）         | workspace-store                 | 主进程 + Pinia            | 添加目录、探测子目录、列表持久化         |
| 11  | 最近打开                                | host/recent-files               | 主进程设置 + 库视图       | 上限 40（旧版 24，按小写路径去重）       |
| 12  | 多标签（根标签钉住、复用、滚动恢复）    | tabs.ts                         | 新 TabStore + Pinia       | 旧 8 项单测语义全过                      |
| 13  | 单文件打开（拖放/命令行/关联/二次启动） | desktop + shell                 | 主进程 + preload          | 四条入口落到同一标签，只读单文件         |
| 14  | 文档内查找                              | webContents.findInPage          | 阅读态沿用；编辑态 CM6    | 计数、循环、Esc 关闭                     |
| 15  | 全局搜索                                | minisearch                      | worker 索引 + 命令面板    | 5000 文档索引 < 3s，查询 < 50ms          |
| 16  | 大纲                                    | 右侧目录                        | 大纲面板                  | 滚动联动、点击跳转                       |
| 17  | 内容宽度 / 侧栏折叠                     | 视图控制                        | 顶部/状态栏控件 + 持久化  | 4 档宽度、折叠状态记忆                   |
| 18  | 深浅主题                                | tokens.css                      | 主题系统 paper/graphite   | 对比度门禁通过                           |
| 19  | 中英 i18n（245 条）                     | i18n-en                         | 同结构迁移                | 键完整性检查、无回退遗漏                 |
| 20  | 插件面板（安装/启停/同名切换）          | host/plugin-panel               | 插件面板                  | 安装、禁用、冲突切换                     |
| 21  | 本地服务（MCP/分享/端口/自启动/托盘）   | packages/server + desktop       | service 进程 + 服务插件   | MCP 六工具、分享链接、局域网开关         |
| 22  | 临时分享（文件/目录）                   | shares                          | 服务插件                  | 链接可用、停用即失效                     |
| 23  | git（克隆/分支/工作树/状态）            | desktop/git                     | 受信服务插件              | 克隆、切分支、状态显示                   |
| 24  | 自绘窗口 chrome / 标题栏 / 状态栏       | app-chrome.css                  | apps/desktop              | 拖拽区、窗口按钮、状态栏信息             |
| 25  | `.md` 文件关联 / 拖放                   | electron-builder + preload      | 同左（新 appId）          | 安装后双击打开                           |
| 26  | 托盘 / 自启动                           | main                            | main                      | 关闭到托盘、开机启动                     |
| 27  | 全屏组件（表图/表页签）                 | fullscreen.ts                   | 新全屏容器                | 无裁切、无吸底                           |
| 28  | 图组件缩放拖拽                          | useZoomPan                      | 沿用                      | 缩放文字不糊、连线不错位                 |
| 29  | 静态导出 / 单文件 viewer                | build:viewer                    | **冻结**                  | 不纳入本轮                               |
| 30  | 容器部署器 deployer                     | deployer/                       | **冻结**                  | 不纳入本轮                               |

**对齐口径**：1–28 全部通过即视为「功能对齐」；29–30 明确不在本轮范围，代码保留但不随新架构维护。
截至 2026-10-22：**1–28 全部对齐**（#8 组件示例预览、#17 侧栏折叠持久化、#10 工作区子目录探测、
#20 组件级启停、#23 git 托管工作区均于 2026-10-22 补齐，明细见 11.1）。

---

## 十一、实施顺序（连续推进，不设中断点）

一次性推进到功能对齐，阶段之间只做验收不停工。

### S0 地基（约 1–1.5 周）

1. 新目录骨架 + electron-vite 三段配置 + TS strict + ESLint/Prettier + vitest + CI 矩阵。
2. 身份改造：包名、appId、窗口标题、数据目录、`docvi://` 协议、图标。
3. `packages/ui` 基础控件首批（Button/Input/Dialog/Menu/Tooltip/Toast/Tree/EmptyState）。
4. 主进程窗口骨架：标题栏、图标栏、侧栏、状态栏（静态）。
5. `shared` IPC 契约 + `content` ContentPort（IPC 实现）+ workspace 注册表。
6. 空状态与「添加目录」流程。

**验收**：启动 → 添加目录 → 树渲染 → 点击打开纯 Markdown 文本（无组件）。

### S1 阅读内核（约 1.5–2 周）

1. 迁移 markdown 管线（含术语块、颜色增强、容器）。
2. Shiki 按需加载 + Mermaid 懒加载。
3. 组件注册表 + 24 个 base 组件 Vue 化迁移。
4. 主题系统（paper/graphite）+ 内容排版 token。
5. 大纲、内容宽度、Zen 模式、滚动恢复。
6. 阅读态文档内查找（原生 findInPage）。

**验收**：`courses/` 全量渲染，23 组件示例可用；抽 5 篇长文档对比旧版无排版退化。

### S2 工作区与导航（约 1 周）

1. 多标签（根标签钉住、同源复用、切换保滚动）。
2. 最近打开、库视图、工作区切换。
3. 单文件打开四入口（拖放/命令行/关联/二次启动）。
4. 搜索索引（worker）+ 命令面板。

**验收**：旧标签状态机 8 项测试语义全过；四入口均可打开单文件。

### S3 编辑器（约 1.5–2 周）

1. CM6 集成 + 实时预览装饰 + 源码模式。
2. 块级 Widget：图片、表格、代码块、Mermaid、组件卡片。
3. 保存（原子写）、外部变更冲突、草稿恢复。
4. 编辑态查找、格式化命令（frontmatter/代码块）。
5. IME 与滚动抖动专项测试。

**验收**：含 3 个组件块 + 1 张表的文档可流畅编辑；200KB 文档输入延迟 p95 < 16ms；中文输入无重复字符。

### S4 插件体系（约 1.5–2 周）

1. manifest 校验 + 容器（注册/注入/激活/销毁/热重载）。
2. 三层信任模型 + 安装确认流程。
3. 插件面板（列表、详情、启停、同名切换、示例预览）。
4. 主题插件 + Markdown 语法扩展插件各做一个样例。
5. 合并单元格表格插件（结构化块样板）。

**验收**：安装第三方主题与组件包；禁用后资源完全卸载；语法扩展可按文档启用。

### S5 服务与工作流（约 1 周）

1. service 进程（utilityProcess / `--service`）+ 托盘 + 自启动。
2. MCP 端点（六工具：插件四件套 + `search_docs` / `read_doc`；协议与检索层沉在 `packages/server`，两端共用）。
3. 临时分享（文件/目录）+ 局域网开关。
4. git 受信插件（克隆、分支、状态）。

**验收**：MCP 客户端可连；分享链接可访问；分支切换后内容刷新。

### S6 打磨与发布（约 1 周）

1. 全量 i18n、可访问性、快捷键、错误态、空状态。
2. 性能专项（启动、树、长文档、内存）。
3. 打包三平台 + 自动更新通道。
4. 开源资产（LICENSE/CONTRIBUTING/SECURITY/CI/release）。

**验收**：`pnpm verify` 全绿；三平台安装包产出；验收清单 100%。

**总量**：约 8–10 周全职投入。阶段之间不停工，但每阶段末必须跑该阶段的验收脚本——**验收是质量门，不是中断点**。

### 11.1 落地进度（S0–S6 截至 2026-10-21）

| 阶段                   | 状态     | 提交                  | 运行时验收              | 备注                                                      |
| ---------------------- | -------- | --------------------- | ----------------------- | --------------------------------------------------------- |
| S0 地基                | 完成     | `f34070f`             | —                       | electron-vite 三段构建、身份改造、IPC 契约                |
| S1 阅读内核 + 三层主题 | 完成     | `b66590d` + `19bd83e` | content 全量渲染        | 零 typecheck 错误、verify 13/13                           |
| S2 工作区与导航        | 完成     | `f251855` + `1408600` | 25/25                   | 多标签、命令面板、全库搜索、四入口、文档内查找            |
| S3 编辑器              | 完成     | `2f00658` + `a4f3dfc` | 19/19                   | CM6 Live Preview、IME 冻结、原子保存、草稿恢复            |
| S4 插件体系            | 完成     | `3fdd6b6`             | 20/20                   | manifest 校验、容器、三层信任、主题即插件、合并单元格表格 |
| S5 服务与工作流        | 完成     | `5dcfd44`             | 服务 26/26 + 桌面 15/15 | MCP 六工具、临时分享、设置页；git 托管工作区见 11.3       |
| S6 打磨与发布          | 部分完成 | `b912bfa`             | 18/18 + i18n 10/10      | 键盘导航、快捷键帮助、i18n、错误/空态；打包与开源资产未做 |

**S5/S6 明确未做**（下一批）：

1. ~~托盘图标、开机自启~~ **已于 2026-10-22 补齐**：`tray.ts` + `autostart.ts`，设置页「启动与常驻」三开关（自启动 / 关闭留托盘 / 日志入口），端口可改并落盘。`--service` 无窗口档的安装器集成仍未做。
2. ~~git 受信服务插件（克隆 / 分支 / 状态）~~ **已于 2026-10-22 补齐**：见 11.3。
3. 自动更新通道、三平台安装包、LICENSE / CONTRIBUTING / SECURITY / CI release 流程。
4. `packages/ui` 控件库：当前控件在各组件内就地实现，抽包留待有第二个宿主（web）时再做，
   避免为抽象而抽象。
5. 主题对比度门禁（`theme:check`）与 secrets 扫描未接入 verify。

**旧功能对齐缺口已清零**（2026-10-22 逐项核查并补齐）：

| #   | 旧功能                       | 补齐方式                                                                                                             |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 10  | 工作区探测子目录             | `probeWorkspace` 扫一层子目录找 `docs.config.yaml`，有候选且父目录不是内容根时弹窗让用户选；「就用所选目录」出口保留 |
| 20  | 组件级启停 / 同名切换        | `PluginState.disabledComponents` 逐 kind 开关，宿主注册表、插件面板与 MCP 快照三处同时生效                           |
| 23  | git（克隆/分支/工作树/状态） | 移植旧宿主 git 服务进新主进程，见 11.3（克隆 / 切分支 / 拉取 / 侧栏状态条全链路）                                    |

另两项同日补齐：

- **#8 组件示例预览**：插件卡片可展开组件清单、点组件就地渲染 `examples/<kind>.md`
  （`ComponentPreview.vue` + `lib/component-registry.ts`）。CDP 实测 base 包 24 个
  组件全部列出、timeline 示例渲染出 5 个条目、audio 示例渲染出 2 个 SVG。
- **#17 侧栏折叠持久化**：`AppSettings.sidebarCollapsed`，首帧即按偏好渲染。
  重启后仍折叠（CDP 实测写链 + 读链）。内容宽度维持两档（旧版同为 `wide-mode`
  两档，「4 档」是计划目标非既成能力，不作缺口计）。

### 11.2 文档导出（2026-10-22 落地）

| 格式     | 产物来源                                  | 状态   |
| -------- | ----------------------------------------- | ------ |
| Markdown | 当前缓冲区原文（含 frontmatter）          | 完成   |
| HTML     | 离屏重新渲染 → 内联样式 + 图片转 data URL | 完成   |
| PDF      | 同一份 HTML 经隐藏窗口 `printToPDF`（A4） | 完成   |
| PNG 截图 | 当前视口截图（不做长图拼接）              | 暂不做 |

三条设计约束：

- **导出与当前模式无关**：三种模式下都可导出，产物一律按「渲染完成的成品」生成，
  不克隆屏幕 DOM（屏幕上那份夹着查找高亮、光标行源码、未加载完的懒图）。
- **HTML/PDF 自包含**：`theme.css` / `doc.css` 以 `?raw` 打进包再内联，插件主题从
  `<style data-plugin-theme>` 读取；图片转 data URL。产物不依赖任何外部文件。
- **富组件要提示**：导出 markdown 时数 frontmatter `components:` + `<at-*>` 引用 +
  `:::` 容器三处，命中就在成功提示里说明「其他编辑器会看到 YAML 声明与标签引用」。
  不做拦截弹窗——用户可能就是要导源文件。

**验证钩子**：`DOCVI_EXPORT_DIR` 环境变量让导出跳过系统保存框直接写指定目录。
系统保存框是 OS 级窗口，CDP 与自动化脚本无法操作；钩子只改落点，不改变产物生成逻辑。

**验收脚本纪律**：运行时验收脚本是**临时产物**（不进仓），每次改动后按当前构建重跑；
进仓的只有不依赖窗口的单元测试（`tests/service/`）。

### 11.3 Git 托管工作区（2026-10-22 落地，#23）

旧版这套模型（平台自持镜像 + 分支工作树）已跑过实仓，这里**移植而不是重写**
（`apps/desktop/src/main/git.mjs`，旧 `packages/desktop/src/git.mjs` 随旧宿主退役）：

| 环节     | 做法                                                                                     |
| -------- | ---------------------------------------------------------------------------------------- |
| 克隆     | `git clone --mirror` 到 `<userData>/git/<名>.git`，再为默认分支建 detached 工作树        |
| 浏览     | `root` 指向 `<userData>/worktrees/<名>/<分支目录>/`，一个分支一棵树，互不干扰            |
| 切分支   | 确保目标分支工作树存在，然后把工作区条目换成新 root（id 由路径派生，因此 id 也随之变化） |
| 拉取     | `fetch --prune` → `rev-list` 数新提交 → `reset --hard refs/heads/<分支>`（云端为准）     |
| 凭证     | 完全继承系统 Git（GCM / SSH）；`GIT_TERMINAL_PROMPT=0` 只禁挂起，不接管认证              |
| 用户目录 | **永不写入**：只读浏览用户已有目录，托管副本全在应用数据目录内                           |

界面三处入口：文档库「克隆仓库」按钮 + 克隆进度对话框（阶段文案 + 百分比 + 未知时的不定进度条）；
工作区卡片的分支徽标与「切换分支 / 拉取更新」；阅读时侧栏顶部的 git 状态条
（分支名 + 拉取按钮，读文档时也能看见自己在哪条分支）。

三条容易被忽略的一致性约束，都在实现里落了口：

- **切分支 = 换工作区**：标签与历史里的 `workspaceId` / `key` / `absolutePath` 由
  `tabs.replaceWorkspace` 原地重写，不关标签重开（否则浏览现场丢失）。当前文档在新分支
  上不存在时退到落地页并提示，而不是留一块空白。
- **拉取后必须重读缓冲区**：工作树被 `reset --hard` 改过，已装载文档不重读的话，
  用户编辑的是旧内容，保存会把云端的新版本覆盖掉。干净缓冲直接采用磁盘内容，
  脏缓冲标冲突交给编辑器提示；云端删掉的文档单独提示。
- **搜索索引要作废**：索引按工作区缓存，切分支/拉取后 id 或内容变了但缓存不知道，
  必须 `invalidate` 后重建，否则搜索一直回答旧分支的结果。

**运行时验收**（临时 CDP 脚本，真实裸仓库 → 真实应用）：25/25 通过——克隆落点与内容、
分支列表、UI 切分支后侧栏与卡片同步、feature 独有文档可读、远端前进后拉取到 1 个新提交
且内容更新、重复拉取 0 提交、对话框标记当前分支。纯逻辑回归在 `tests/service/git.test.mjs`。

---

## 十二、验收与门禁

### 12.1 `pnpm verify`（非 fail-fast，一次暴露全部欠账）

| #   | 检查               | 内容                                                       |
| --- | ------------------ | ---------------------------------------------------------- |
| 1   | `format:check`     | Prettier 全量（含 `.vue` 模板）                            |
| 2   | `lint`             | ESLint flat config + eslint-plugin-vue（模板规则）         |
| 3   | `typecheck`        | `vue-tsc`（renderer/apps）+ `tsc`（main/preload/packages） |
| 4   | `test`             | vitest 单测 + 集成（DOM 用 happy-dom）                     |
| 5   | `test:e2e`         | Playwright Electron 冒烟（启动/开文档/切标签/查找）        |
| 6   | `build`            | electron-vite 三产物 + 插件构建                            |
| 7   | `content:check`    | frontmatter schema、组件数据、站内链接、示例完整性         |
| 8   | `i18n:check`       | 中英键完整、无孤立键                                       |
| 9   | `boundaries:check` | 依赖方向、renderer-core 无 Node/Electron                   |
| 10  | `theme:check`      | token 白名单、对比度阈值                                   |
| 11  | `licenses:check`   | 第三方许可证清单与 SPDX 校验                               |
| 12  | `secrets:scan`     | gitleaks（CI + 提交钩子）                                  |

**格式化工具选择（已实测）**：Biome 2.5.15 能格式化 `.vue` 的 `<script>`，但**不格式化 `<template>`**（开启 `html.parser.vue` 后仍不变）。因此采用 ESLint + Prettier，Biome 不作为唯一格式化器。

### 12.2 测试策略

- **纯逻辑**：图布局、标签状态机、路径安全、索引、主题对比度、插件容器 → vitest 单测。
- **组件**：23 + 3 个组件的 props 契约与渲染快照 → 组件测试。
- **集成**：IPC 契约、ContentPort、保存冲突 → Node 侧集成测试。
- **E2E**：启动、开目录、开文档、切标签、查找、编辑保存 → Playwright（Windows CI 必跑）。

### 12.3 性能指标（硬性）

| 指标               | 目标                            |
| ------------------ | ------------------------------- |
| 冷启动到可交互     | < 1.5s；热启动 < 800ms          |
| 打开 5000 文件目录 | 树首屏 < 800ms（虚拟滚动）      |
| 打开 200KB 文档    | 首屏 < 400ms                    |
| 输入延迟           | p95 < 16ms（200KB 文档）        |
| 空闲内存           | < 300MB                         |
| 全文搜索           | 5000 文档索引 < 3s；查询 < 50ms |

---

## 十三、风险与未决

| #   | 风险                                   | 影响                                                              | 应对                                                                                                             |
| --- | -------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| R1  | chrome 从手写 DOM 迁 Vue 的工作量      | 约 6600 行重写（`main.ts` 2866 + `host/` 3771），含大量隐式时序锁 | 先迁渲染管线（364 行可整段搬），chrome 按视图重写；`applyingTab` / 渲染代际等状态显式化为 Pinia                  |
| R2  | CM6 Live Preview 复杂度被低估          | 表格、IME、组件块高度是真实工程                                   | S3 前做 2 天技术 spike：表格渲染 + 组件 Widget + IME 三件事各跑通最小样例，不通过则退化为「源码 + 右侧预览」双栏 |
| R3  | 插件 API 过早锁死                      | 生态迁移成本                                                      | `apiVersion` 从第一天存在；公开市场在 API v1 稳定后再开                                                          |
| R4  | 第三方插件安全                         | 供应链风险                                                        | 三层信任 + 安装确认 + CSP + 禁止插件静默更新                                                                     |
| R5  | 性能回退（Shiki/Mermaid/组件全量加载） | 启动慢、内存高                                                    | 按需加载 + 构建期体积预算（主 chunk < 1.5MB gzip）                                                               |
| R6  | macOS 未实机验证                       | 窗口 chrome / 图标 / 快捷差异                                     | CI 覆盖 typecheck/test/build；发布前人工验收                                                                     |
| R7  | 命名 DokeV 噪声                        | 搜索侧少量干扰                                                    | 已评估为低风险；副标题固定为「Markdown 文档工作台」                                                              |
| R8  | 范围蔓延（deployer / viewer / web）    | 拖慢主线                                                          | 明确冻结；web 只在 S6 后启动                                                                                     |

**需要用户拍板但可并行推进的事项**：

1. 开源许可证：建议 MIT（与 Ensemble 一致）。
2. 默认主题强调色：建议 paper 赭石 / graphite 暖琥珀（见 6.4）。
3. 旧应用数据是否迁移：建议提供一次性导入（设置、最近打开、分享登记），不静默迁移。
4. 自动更新通道：GitHub Releases + electron-updater（签名与公证后续补）。

---

## 十四、开源资产清单

参考 `ensemble` 的成熟配置，一次性补齐：

| 文件                               | 内容                                     |
| ---------------------------------- | ---------------------------------------- |
| `LICENSE`                          | MIT                                      |
| `README.md` / `README.en.md`       | 定位、截图、安装、开发、插件说明、非目标 |
| `CONTRIBUTING.md`                  | 开发环境、分支、提交规范、PR 要求        |
| `CODE_OF_CONDUCT.md`               | Contributor Covenant                     |
| `SECURITY.md`                      | 漏洞报告渠道与支持版本                   |
| `.github/workflows/ci.yml`         | 三平台 typecheck + test + build          |
| `.github/workflows/release.yml`    | tag 触发三平台打包与 Release             |
| `.github/workflows/pages.yml`      | 文档站发布                               |
| `.github/ISSUE_TEMPLATE/`          | bug / feature 模板                       |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR 检查清单                              |
| `.github/dependabot.yml`           | npm + actions                            |
| `CHANGELOG.md`                     | Keep a Changelog                         |
| `docs/`                            | 架构、ADR、插件开发指南、主题开发指南    |

**仓库落地方式**：在本仓 `main` 主线完成 S0–S6，功能对齐与门禁全绿后对外发布。

---

## 十五、与旧架构的关键差异（一页速查）

| 维度      | 旧（docs-studio）                      | 新（docvi）                                        |
| --------- | -------------------------------------- | -------------------------------------------------- |
| 宿主      | 四宿主平权，能力表分支                 | app 唯一完整宿主，web 次级复用                     |
| 壳        | 手写 DOM + 字符串模板，2866 行 main.ts | Vue 3 组件 + Pinia                                 |
| 组件      | custom elements + vue-shim             | 内置直接 Vue 渲染，外部保留 shim                   |
| 图标/控件 | 自绘 SVG + 手写 CSS                    | lucide + reka-ui + `packages/ui`                   |
| 编辑      | 无                                     | CM6 实时预览 / 源码 / 阅读                         |
| 主题      | 单一 tokens.css                        | 双层 token + 主题插件                              |
| 插件      | 仅组件包                               | 组件 / 主题 / 语法 / 命令 / 菜单 / 服务            |
| 存储      | localStorage 为主                      | 主进程设置 + 数据目录 + Pinia                      |
| 资源协议  | file:// / http                         | `docvi://` + CSP                                   |
| 门禁      | verify 11 项（含 deployer）            | verify 12 项（去 deployer，增 theme/secrets/perf） |
| 部署器    | 内置维护                               | 冻结                                               |
