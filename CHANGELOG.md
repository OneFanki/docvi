# 更新日志 / Changelog

每个版本的更新内容写在这里，GitHub Release 的正文由 `.github/workflows/release.yml`
按版本号从这个文件抽取，所以发版时只需要改版本号、日期和这里。

- 准备发版时，把 `## [未发布]` 改成 `## [<版本号>] - <日期>`，再在顶部加一个新的「未发布」小节。
- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。
- 只写**用户能感知的改动**：新功能、行为变化、修复、升级注意事项。内部重构、CI、依赖更新可以合并成一条。
- 中英文都要有：仓库和展示页面向中英两种读者，Release 也一样。
- 缺少对应版本的小节时，发布流程会直接失败——不会发出没有说明的版本。

### 三个层级，别写混

在 `### 中文` / `### English` 下：

1. **摘要**（必须，2–5 条）：每行一条、每条一句，写「用户这次能得到什么」。Release 页面顶部和
   应用内更新提示都用这一段，所以它必须能独立读懂，不引用内部代号、不带链接、不列每个小修复。
2. **`#### 完整变更`**（可选）：详细的逐条变更，给想追溯细节的人看。

### 应用内更新提示

`latest.json` 的 `notes` 是应用「关于」面板显示的那一行，取该版本摘要里最靠前的一条
（太长会被截断显示）。改版本号时一起更新。

## [未发布]

### 中文

### English

## [0.6.1] - 2026-11-09

### 中文

- **后台不再偷偷吃 CPU 了**：以前开着一个大仓库（两千多篇文档），只要有程序往里写文件，docvi 就会把**所有**工作区的搜索索引整个重建一遍——一次十几秒、占满一个核。现在只重建变化的那一个仓库，索引开销降到原来的约七分之一，内存从 350MB 降到 96MB
- **超大仓库自动降级为「按文件名搜索」**：超过 800 篇的文档库不再读全文建索引，按文件名或路径照样能搜到，命令面板底部会说明清楚。搜索还是能用，只是不再为搜不到的正文付十几秒的代价
- **点「下载更新」能看到进度了，点「取消」也真的会停**：以前取消是个空操作——进度条会继续爬到 100%，然后提示成功。现在取消立刻停下，并且不会再偷偷下完
- **开发版与安装版不再互相干扰**：`pnpm docvi:dev` 用独立的数据目录（窗口标题带 `dev` 角标），不会再和已安装的版本抢单实例锁，也不会污染你的工作区列表

#### 完整变更

- **搜索索引改增量（按工作区分片）**：worker 由「只有整库重建」改为 `replace` / `drop` 两个按工作区操作的指令，用 `owned` 记账精确移除旧分片。启动期从 32s 降到 3.1s，单次外部改动从 8.5s 降到 1.2s，索引常驻堆从 354MB 降到 96MB（2506 篇 / 14M 字符实测）
- **语料规模降级**：`collectSearchCorpus` 超过 `MAX_FULLTEXT_DOCS`（800 篇）时只回路径、不读正文，返回 `fullText: false`；控制台面板据此显示「X 仅索引文件名」。阈值判定只看篇数，不额外读盘
- **更新下载的取消真正生效**：`net.request` 的 `abort()` 只在响应头到达前有效，响应一到再 abort 是空操作——body 会继续把 99MB 下完并「成功」返回。现在 abort 同时转发到响应流（`destroy(error)`），实测取消后泄漏 0KB
- **`AbortError` 的 name 修正**：`new Error('AbortError')` 的 `name` 是 `Error`，所有按 name 判断取消的地方都落空，「用户取消」被当成「未知失败」。改用 `Object.assign(new Error(...), { name: 'AbortError' })`
- **渲染层异步出口补齐**：`appUpdateDownload` / `appUpdateInstall` 的 await 补 `try/catch`。此前 IPC 本身 reject 时 `phase` 会永远停在 downloading——界面表现为「0%、点了没反应、取消也没用」
- **资产缺失的原因说清楚**：清单说有新版本但抓不到本平台资产（Release 还在构建）时，原先只回 `status: outdated` 且没有 `asset`，界面只能笼统说「未提供校验值」。新增 `assetMissingReason` 区分「API 取不到资产」与「该平台没有包」
- **开发版数据隔离**：新增 `main/dev-data.ts`，非打包运行落到 `%APPDATA%/docvi-dev`，应用名改为 `docvi dev`（单实例锁不再互顶、标题栏有 `dev` 角标）。判据顺序 `DOCVI_DATA_DIR` > `--user-data-dir` > 开发版隔离 > Electron 默认——前两条必须优先，否则会把测试写进开发者的真实数据目录
- **应用图标小尺寸清晰化**：`logo.mjs` 新增 `LOGO_SVG_COMPACT`（几何不变，只去掉小尺寸画不出来的正文线/渐变/内描边），`build-icons.mjs` 按 `size <= 24` 自动选版本；ICO 补 20/40/96 三档覆盖 Windows 全部 DPI；托盘改用预生成的 32px `tray.png`，去掉 `resize(16)` 的双重重采样
- 新增测试：搜索 worker 分片替换 6 例、语料降级 5 例、开发版数据目录判据 8 例；`scripts/dev/probe-update-download.mjs` 增加「进度可见 + 取消有效」两段真实网络断言

### English

- **docvi no longer burns CPU in the background**: with a large workspace open (a couple thousand documents), any file written by another tool made it rebuild the search index for **every** workspace — ten-plus seconds of a pinned core. Only the changed workspace is rebuilt now: index cost drops to roughly a seventh, memory from 350MB to 96MB
- **Very large workspaces fall back to filename search**: above 800 documents, full text is no longer indexed. Filename and path search still work, and the command palette says so
- **"Download update" shows progress, and "Cancel" actually cancels**: cancelling used to be a no-op — the bar kept climbing to 100% and then reported success. It now stops immediately and no longer keeps downloading behind your back
- **Dev builds no longer collide with the installed app**: `pnpm docvi:dev` uses its own data directory (window title carries a `dev` badge), so it neither competes for the single-instance lock nor pollutes your workspace list

#### Full changes

- **Incremental search index (per-workspace shards)**: the worker went from "rebuild everything" to `replace` / `drop` scoped to one workspace, with an `owned` ledger to discard exactly the old shard. Startup 32s → 3.1s, single external change 8.5s → 1.2s, resident heap 354MB → 96MB (measured on 2506 docs / 14M chars)
- **Corpus size fallback**: `collectSearchCorpus` returns paths only (no bodies, `fullText: false`) above `MAX_FULLTEXT_DOCS` (800). The palette shows "X: filenames only". The threshold is decided from the file count alone, with no extra disk reads
- **Update download cancellation actually works**: `net.request`'s `abort()` only works before response headers arrive; afterwards it is a no-op and the body keeps downloading all 99MB before "succeeding". The abort is now forwarded to the response stream (`destroy(error)`); measured leakage after cancel: 0 bytes
- **`AbortError` name fixed**: `new Error('AbortError')` still has `name === 'Error'`, so every `error.name === 'AbortError'` check missed and a user cancel was reported as an unknown failure
- **Renderer async exits**: `try/catch` added around `appUpdateDownload` / `appUpdateInstall`. When the IPC call itself rejected, `phase` stayed at downloading forever — "0%, nothing happens, cancel does nothing"
- **Missing-asset reason surfaced**: when the manifest announces a version whose per-platform asset is not there yet, `assetMissingReason` now distinguishes "API returned no assets" from "no package for this platform"
- **Dev data isolation**: new `main/dev-data.ts` sends unpackaged runs to `%APPDATA%/docvi-dev` and renames the app to `docvi dev`. Precedence: `DOCVI_DATA_DIR` > `--user-data-dir` > dev isolation > Electron default — the first two must win, or tests would write into the developer's real data directory
- **Sharper icons at small sizes**: `LOGO_SVG_COMPACT` (same geometry, minus detail that cannot resolve below 32px), chosen automatically for `size <= 24`; ICO gained 20/40/96 to cover every Windows DPI step; the tray now loads a pre-rendered 32px `tray.png` instead of `resize(16)` double-resampling
- New tests: 6 search-worker shard cases, 5 corpus-fallback cases, 8 dev-data-dir cases; `scripts/dev/probe-update-download.mjs` gained real-network assertions for visible progress and working cancellation

## [0.6.0] - 2026-11-06

### 中文

- **md 里可以直接引用 HTML 文件了，不用再把整份内容粘进来**：图解文件放在内容根里（比如 `assets/`），frontmatter 用 `src` 指过去即可，文档本身能小一个数量级。实测一篇 64KB 的方案文档缩到 8KB
- **正文里的 `.html` 链接现在能直接打开**：写 `[看示意图](../assets/xx.html)`，点一下就在新窗口里看，交互脚本照常运行
- **HTML 图解终于能正常显示了**：之前内嵌的图解只剩侧栏顶栏、图表全空，新窗口打开后底色透明、按钮没有边框——都没了。新窗口里按 `Ctrl+R` 刷新也不会再白屏

#### 完整变更

- **引用式图解**：`components` 段的 `src` 由渲染管线换算成内容根的资产地址再补宿主前缀，相对路径按文档所在目录解析、`/` 开头按内容根。此前这一步完全没有，`src` 被当成相对当前页，桌面端必然 404——所以这个能力在桌面端其实一直是坏的。阅读态、编辑态实时预览、导出三条链路共用同一份换算规则
- **正文 `.html` / `.htm` 链接**：归一为根相对地址（保留扩展名），点击经沙箱页开新窗口。内容由文档页拉取后投递，沙箱页不许自己发请求——否则图解里的脚本能读到同一工作区内的其它文档。其余带扩展名的资产（图片、PDF）维持原样，不会被当成可打开页面
- **内嵌空白**：应用入口页的 CSP（`script-src 'self'`）会被 `srcdoc` / `data:` / `blob:` 子帧继承，图解的内联脚本被整片拦掉。改为交给独立文档 `embed-sandbox.html` 承载，它自带严格策略、再把内容挂进二级沙箱帧；**没有为此外放宽应用自身的 CSP**
- **新窗口无样式**：覆盖层此前 `Teleport` 到 body 后脱离了文档主题作用域，`--at-*` 角色 token 全部失效，于是底色透明、控件无边框
- **新窗口刷新白屏**：内容只存在于一次投递里，而新窗口的 `opener` 已切断，重载后没人能再投递。沙箱页按 token 把内容存进本窗口的 `sessionStorage`，刷新自恢复；实在没有存量时给一句可读提示，而不是留一块白
- **读不到图解文件时的提示**：从「Failed to fetch」改为提示确认该目录已声明进 `docs.config.yaml` 的 `staticDirs`
- **导出**：图解在导出的 HTML 里回填为 `srcdoc`，照原样呈现（导出文件是独立文档，不受应用 CSP 约束）

### English

- **Markdown can now reference HTML files instead of inlining them**: drop a diagram under the content root (e.g. `assets/`) and point `src` at it — a document that was 64KB shrinks to 8KB
- **`.html` links in the body open properly now**: write `[see diagram](../assets/x.html)` and it opens in a new window with its scripts running
- **Embedded HTML diagrams finally render**: they used to show only the chrome with every chart empty, and the new-window view came up transparent with unstyled buttons. Both are fixed, and `Ctrl+R` in that new window no longer blanks it

#### Full changes

- **Referenced diagrams**: `src` in the `components` block is now resolved by the render pipeline into a content-root asset URL plus the host prefix (relative to the document, or from the content root when it starts with `/`). This step simply did not exist, so `src` was treated as relative to the current page and always 404'd on desktop — the capability had been broken there all along. Reading, live preview and export share one resolver
- **`.html` / `.htm` links** are normalized to root-relative (extension kept) and open through the sandbox page on click. The document page fetches the content and delivers it, because letting the sandbox page fetch would let a diagram's scripts read every other document in the same workspace. Other extensions (images, PDFs) are untouched
- **Blank embeds**: the app shell's CSP (`script-src 'self'`) is inherited by `srcdoc` / `data:` / `blob:` child frames, blocking every inline script in a diagram. Diagrams are now hosted by a separate document, `embed-sandbox.html`, which carries its own strict policy and nests the content in a second sandboxed frame — **without loosening the app's own CSP**
- **Unstyled new window**: the overlay is teleported to `body`, outside the document theme scope, so every `--at-*` role token failed to resolve
- **Refresh blanking the new window**: content exists only in a single delivery, and the new window's `opener` is already severed, so nothing can re-deliver after a reload. The sandbox page now keeps the payload in its own window's `sessionStorage` per token and restores it on load, with a readable message when nothing was saved
- **Read failures** now suggest checking `staticDirs` in `docs.config.yaml` instead of just saying "Failed to fetch"
- **Export**: diagrams are written back as `srcdoc` in exported HTML, where the app CSP does not apply

## [0.5.0] - 2026-11-03

### 中文

- **AI 现在能直接给你写文档了**：MCP 新增写入能力，你说「帮我写篇 XX 的文档」，它就能落笔成 .md 文件，界面随即显示。默认只新建、绝不静默覆盖已有文档；改旧文档要求先读一遍、带上版本戳再写，期间被别人改过会失败并让你重读
- **首次启动会建一个默认文档库**：`文档/docvi`（Windows 的「文档」目录下），AI 没指定位置时写这里。它带「默认工作区」角标、**不可移除**；默认按修改时间排序，刚写的那篇永远在最上面。你确实不想要它时，删掉这个目录即可
- **目录树可以按修改时间排序了**：工具栏新增排序面板（按配置顺序 / 按修改时间，带勾选态，当前用哪种一眼可见），偏好按工作区记住；默认工作区出厂就是 mtime

#### 完整变更

- **默认工作区 = AI 的兜底落笔处**：MCP `instructions` 与 `list_workspaces` 都明确写死优先级「用户明确指定的位置 > 项目规范约定 > 默认工作区」。默认工作区只是「完全没线索时有个地方能写」，不覆盖用户/项目规范给出的位置
- **默认工作区不可移除**：卡片角标标明身份、不显示移除按钮、右键菜单也没有该项；主进程 `workspaceRemove` 对它返回 `E_FORBIDDEN`（防止别的入口绕过界面）。想停用就删目录——拒的只是移除登记
- **目录树排序（工作区级偏好）**：`manual`（frontmatter `order` → 名称自然序，沿用既有口径）与 `mtime`（修改时间倒序，同毫秒回落名称保证稳定）。工具栏面板切换并持久化到 `workspaces.json` 的 `treeSort`；目录始终排在文件之前，两类各自排序
- **MCP 新增两个工具**：`list_workspaces`（可写入范围清单，标出默认落笔处）与 `write_doc`（`path` / `text` / `workspace?` / `mode?` / `baseMtime?`）。桌面端八个工具，容器端七个——容器的工作树是构建副本、没有 commit/push，写进去不会回传仓库，所以**不声明**写工具（工具面 = 宿主能力）
- **写入语义保守优先**：`mode=create` 缺省、只新建；`overwrite` 必须带 `read_doc` 返回的 `baseMtime`（mtime 不匹配报冲突，与编辑器保存同一套判定）；`append` 文件须已存在。只写 `.md` / `.markdown`，路径拒绝绝对路径、`..`、点开头段与扫描排除目录（规则与扫描器共用一份，杜绝「写得进去但树上看不见」）。**不提供删除**
- **写入失败回 `isError: true`**：工具处理器第一次支持错误态。写失败若被当成普通文本，AI 会向用户报告「已写入」而磁盘上什么都没有——这种静默失败比报错难查一个量级
- **目标解析顺序确定不猜**：显式 `workspace` → 容器前缀 → 既有文件唯一命中 → 唯一工作区 → 默认工作区 → 报错让 AI 先 `list_workspaces`
- **内建默认工作区**：`<系统文档>/docvi`，settings 记 `defaultWorkspaceSeeded` 只播种一次。用户删掉后不再重建——那是「不想要」，不是「缺配置」。播种失败只记日志，不阻塞启动
- **服务层抽出三块共享件**：`doc-paths.mjs`（路径规则）、`doc-write.mjs`（写入语义）、`fs-atomic.mjs`（原子写：临时文件 + fsync + rename）。桌面编辑器保存与 MCP 写入共用同一份原子写实现
- **桌面端 MCP 请求体上限 256KB → 2MB**（单篇 1MB + JSON 开销）；容器端仍为 256KB（无写工具）
- **`read_doc` 返回值追加 `mtime`**，AI 据此做覆盖冲突判定

### English

- **AI can now write documents for you**: MCP gained write support, so "write me a doc about X" produces a real .md file that shows up in the app immediately. It only creates by default and never overwrites silently; changing an existing document requires reading it first and passing the version stamp, and fails if someone else changed it meanwhile
- **A default library is created on first launch**: `Documents/docvi`, where AI writes when no location is given. It carries a "Default" badge, **cannot be removed**, and sorts by last modified so the newest file stays on top. Deleting the directory is how you opt out
- **The file tree can sort by last modified**: a toolbar menu with checkmarks switches between documented order and last-modified (so the active mode is always visible), remembered per workspace; the default library ships with last-modified

#### Full changes

- **The default library is AI's fallback landing spot**: both the MCP `instructions` and `list_workspaces` state the priority explicitly — "a location the user named > a location the project conventions define > the default library". It only covers "no clue at all" and never overrides a location the user or the project already specified
- **The default library cannot be removed**: the card carries a badge, shows no remove button, and the context menu omits the item; the main process also answers `E_FORBIDDEN` from `workspaceRemove` so other callers cannot bypass the UI. Deleting the directory is how you opt out — only the registration is protected
- **Tree sorting as a per-workspace preference**: `manual` (frontmatter `order`, then natural name order — the existing behaviour) and `mtime` (newest first, ties broken by name so rescans are stable). A toolbar menu with checkmarks (so the active mode is read rather than inferred) persists it to `treeSort` in `workspaces.json`; directories always precede files, each group sorted on its own
- **Two new MCP tools**: `list_workspaces` (writable scopes, with the default landing spot marked) and `write_doc` (`path` / `text` / `workspace?` / `mode?` / `baseMtime?`). Eight tools on desktop, seven in the container — the container's worktree is a build copy with no commit/push, so writes would never reach the repo, and the tool is therefore **not declared** (tool surface = host capability)
- **Conservative write semantics**: `mode=create` is the default and only creates; `overwrite` requires the `baseMtime` returned by `read_doc` (a mismatch is a conflict — the same check the editor uses); `append` requires an existing file. Only `.md` / `.markdown`; paths reject absolute paths, `..`, dot-leading segments and scan-excluded directories (shared rules with the scanner, so nothing can be written that the tree never shows). **No delete tool**
- **Write failures return `isError: true`**: tool handlers support an error state for the first time. A write failure reported as ordinary text would make the AI tell the user "written" while nothing exists on disk — silent failure is an order of magnitude harder to diagnose than an error
- **Deterministic target resolution**: explicit `workspace` → container prefix → unique existing file → sole workspace → default workspace → error asking the AI to call `list_workspaces`
- **Built-in default workspace**: `<Documents>/docvi`, seeded once via the `defaultWorkspaceSeeded` setting. Deleting it is respected and never recreated — that means "don't want it", not "missing config". Seeding failures are logged, never block startup
- **Three shared modules extracted**: `doc-paths.mjs` (path rules), `doc-write.mjs` (write semantics), `fs-atomic.mjs` (atomic write: temp file + fsync + rename). The editor's save path and MCP writes share one implementation
- **Desktop MCP body limit 256KB → 2MB** (1MB document plus JSON overhead); the container keeps 256KB (no write tool)
- **`read_doc` now returns `mtime`**, which the AI uses for overwrite conflict checks

## [0.4.0] - 2026-11-02

### 中文

- **目录树支持批量操作与拖拽移动**：Ctrl/Shift 多选，右键菜单作用于整个选区，拖到目标目录即移动；新建的空文件夹立刻看得见
- **图表跟随文档主题，悬停可见上下游**：流程图的连线文字与节点配色跟随当前主题；鼠标停在节点或连线上，相关的边、箭头、对端节点与连线文字一起亮起，其余淡出
- **插件市场可以直接安装了**：插件产物由作者自己的仓库自动构建，客户端只负责下载与校验。市场卡片显示作者与 GitHub star 数，点「安装」即可装进来；想上架自己的插件，向清单提一个 PR 就行——规范见 `docs/plugin-market.md`
- **图表全屏后横向居中了**：长流程图以前一进全屏就挤在左边、右侧一大片空白
- **装包变小、启动变快**：安装包 110MB → 100MB；编辑器代码改为按需加载，冷启动少解析约 1.1MB

#### 完整变更

- **目录树批量选中**：Ctrl 加选、Shift 连选、普通点击清空；右键菜单与删除作用于整个选区，同目录内的移动/删除走一次落盘
- **拖拽移动**：落点按「目录 / 文件的父目录 / 空白区域=内容根」判定，跳过了指向自身子孙与同目录的空操作；移动前弹确认框
- **目录树工具栏改为「定位当前文档 / 展开所选 / 全部收起」**：新建与重命名下沉到右键菜单，选中项随当前文档走（搜索打开新文档不再残留旧选区）
- **空目录进树**：扫描器此前对空目录直接 `continue`，用户新建的文件夹落盘成功却看不见，再建还提示重名。现在空目录照常出现，新建后自动展开
- **统一确认框补「取消」按钮**
- **mermaid 主题映射**：新增 `--dv-mermaid-*` 派生变量层，`themeVariables` 由 token 解析注入，换主题立即生效（此前 initialize 只跑一次，换主题后新渲染的图仍用旧配色）；亮暗判断改读 `data-appearance`，`mist` 等亮色主题不再被误判为暗色
- **mermaid hover 联动**：悬停节点点亮出入口边、对端节点、箭头与连线文字，无关元素淡出；flowchart 与 erDiagram 通过 mermaid 生成的 `data-id` 精确配对边与标签（自环、平行边、密集标签下不会错位）；stateDiagram / sequenceDiagram 结构对不上，安全降级为不挂联动
- **箭头随边一起高亮**：箭头是 mermaid 按「图 + 箭头类型」共享的 marker，直接改颜色会点亮全图；改为高亮时克隆一份专属 marker 只给命中的边用，空心标记（ER 图的鸦爪、圆圈）只描边不填色
- **连线文字的可读性**：未命中的标签在聚焦态直接隐去（半透明文字叠在一起会糊成一团，且会抢走指针命中）；同时高亮的标签若仍重叠，沿各自的边路径找空位、按路径长度升序处理，找不到时做小范围平移兜底，高亮态底板改不透明
- **点击图不再触发全屏**：改右上角「全屏查看」按钮（悬停时显现），避免 hover 探图时误触；灯箱内 hover 同样可用
- **插件市场支持一个仓库登记多个插件**：按插件名去重，monorepo 场景下的清单写法补进 `docs/plugin-market.md`
- **插件市场改为「拉产物」**：清单条目新增 `artifact`（manifest 的绝对地址 + 可选 SHA-256），客户端取回 manifest 后按其 `entry` / `styles` 逐个下载纯文本文件直接落盘——因此不需要解压库，桌面安装包仍然零运行时依赖
- **安装链路逐环校验**：https + 可信域（GitHub）→ 拒收 HTML 错误页 → 校验 SHA-256 → 校验 manifest 的 name/version 与清单一致 → 包内路径逐段验安全（拒绝 `..`、绝对路径、含冒号的盘符）→ 先写临时目录再整体落位
- **作者与 star 由每日 CI 刷新**：清单的 `repo` 字段由 GitHub Actions 每日批量更新（GraphQL 一次查询带 100 个仓库，认证后限额千级）。客户端**零 GitHub API 调用**——未认证限额 60 次/小时按 IP 共享，逐仓查询在几十个插件时就会撞死
- **上架文档**：`docs/plugin-market.md` 写清产物规范、GitHub Actions 构建示例、PR 流程与自查清单
- **图表全屏居中**：缩放适配从「两轴都装下才居中，否则两轴都贴左上」改为**分轴判断**——装得下的轴居中、装不下的轴贴边。长流程图正是「高度超出、宽度有余」，旧逻辑把横向一起贴左，实测左右留白差 1165px
- **居中计算扣掉 padding**：平移量改为相对内容区计算，修掉画布 `padding: 0.4rem` 造成的 13px 偏差（现为 1px 亚像素误差）
- **编辑器按需加载**：CodeMirror 全家桶拆成独立 chunk（1.15MB），只在进入编辑态时加载；主 chunk 从 2888KB 降到 1737KB
- **裁剪 Windows 运行时**：`afterPack` 钩子移除只服务 WebGPU / SwiftShader 的五份 DLL（共 36.7MB 原始），解包 336MB → 299MB，安装包 110MB → 100MB。已实测裁剪后标题、mermaid SVG、Shiki 高亮、背景色全部正常
- **测试实例不再污染 `%APPDATA%`**：`DOCVI_DATA_DIR` 现在同时把 Electron 的 userData 指过去（此前只有应用数据被隔离，Chromium 仍在 APPDATA 下堆积缓存目录，一轮探针实测残留 96 个）

### English

- **Batch selection and drag-to-move in the file tree**: Ctrl/Shift to select several entries, act on the whole selection from the context menu, and drag to move; newly created empty folders show up right away
- **Diagrams follow the document theme, and hovering reveals connections**: node and edge-label colours track the active theme; hovering a node or edge lights up the edges, the arrowheads, the far-end nodes and the edge labels, and fades the rest
- **The plugin market can install now**: artifacts are built by each plugin's own repository; the app only downloads and verifies them. Cards show the author and GitHub stars, and one click installs. To list your plugin, open a PR against the catalog — see `docs/plugin-market.md`
- **Diagrams are horizontally centred in fullscreen**: tall flowcharts used to sit against the left edge with empty space on the right
- **Smaller installer, faster start**: 110MB → 100MB, and the editor is now loaded on demand, cutting ~1.1MB from cold-start parsing

#### Full changes

- **Batch selection in the tree**: Ctrl adds, Shift extends, a plain click clears. The context menu and delete act on the whole selection, and moving/deleting inside one directory goes through a single filesystem operation
- **Drag to move**: the drop target resolves to "a directory", "the file's parent directory" or "empty space = content root", skipping no-ops that point at the entry itself, its own descendants, or its current directory. A confirmation dialog comes first
- **Tree toolbar is now "locate current document / expand selection / collapse all"**: create and rename moved into the context menu, and the selection follows the current document (opening another file from search no longer leaves a stale selection)
- **Empty directories appear in the tree**: the scanner used to `continue` past empty directories, so a freshly created folder was written to disk but stayed invisible — and creating it again reported a duplicate name. Empty directories now show up, and a new one is expanded automatically
- **Every confirmation dialog gained a "Cancel" button**
- **mermaid theme mapping**: a new `--dv-mermaid-*` derived-variable layer feeds `themeVariables`, and switching themes takes effect immediately (previously `initialize` ran only once, so diagrams rendered after a theme change kept the old palette). Light/dark detection reads `data-appearance`, so light themes such as `mist` are no longer misread as dark
- **mermaid hover linking**: hovering a node lights up its incoming and outgoing edges, the arrowheads, the far-end nodes and the edge labels, fading everything else. Flowchart and erDiagram edges are paired with their labels via the `data-id` mermaid emits (no mispairing with self-loops, parallel edges or crowded labels). stateDiagram/sequenceDiagram expose no such structure and safely fall back to no linking
- **Arrowheads light up with their edge**: arrowheads are `<marker>` elements mermaid defines once per diagram and arrow type, so recolouring them lit up the whole diagram. A dedicated clone is now created for the highlighted edge only; hollow markers (ER crow's feet, circles) get a stroke but no fill
- **Readable edge labels**: unmatched labels are hidden outright in the focus state (semi-transparent text stacked on top of itself turns into mush, and would also swallow pointer events); if the highlighted labels still overlap, each one looks for a free spot along its own edge, processed shortest-path-first, with a small local shift as a last resort, and the highlighted labels get an opaque background
- **Clicking a diagram no longer opens fullscreen**: a "Fullscreen" button appears in the top-right on hover instead, so probing a diagram with the pointer no longer triggers it. Hover works inside the lightbox too
- **The market accepts several plugins per repository**: entries are deduplicated by plugin name, and the monorepo layout is documented in `docs/plugin-market.md`
- **Market switched to pulling artifacts**: entries gain an `artifact` field (absolute manifest URL plus optional SHA-256); the app reads the manifest, then downloads its `entry` / `styles` as plain text. No archive extractor is needed, so the desktop package still has zero runtime deps
- **Every install step is verified**: https + trusted host (GitHub) → reject HTML error pages → verify SHA-256 → check manifest name/version against the catalog → validate every in-package path (no `..`, no absolute paths, no drive letters) → stage in a temp dir, then move into place
- **Author and stars refreshed daily by CI**: the catalog's `repo` field is updated daily by GitHub Actions (GraphQL batches 100 repositories per query; authenticated limits are in the thousands). The client makes **zero GitHub API calls** — the unauthenticated limit is 60/hour shared per IP, which per-repo queries would exhaust within a few dozen plugins
- **Integration guide**: `docs/plugin-market.md` covers artifact layout, a GitHub Actions example, the PR flow, and a checklist
- **Fullscreen diagrams are centred**: fitting changed from "centre only when both axes fit, otherwise pin both to the top-left" to **per-axis** — a fitting axis centres, an overflowing axis pins. Tall flowcharts overflow vertically but have horizontal room, which the old logic dragged to the left (measured 1165px difference)
- **Centring excludes padding**: offsets are computed against the content box, fixing a 13px bias from the canvas `padding: 0.4rem`
- **Editor loaded on demand**: the CodeMirror bundle is its own 1.15MB chunk loaded only when editing; the main chunk drops from 2888KB to 1737KB
- **Windows runtime trimmed**: an `afterPack` hook removes five DLLs that only serve WebGPU / SwiftShader (36.7MB raw), taking the unpacked app from 336MB to 299MB and the installer from 110MB to 100MB. Verified afterwards that headings, mermaid SVG, Shiki highlighting and background all still render
- **Test instances no longer litter `%APPDATA%`**: `DOCVI_DATA_DIR` now also redirects Electron's userData (previously only app data was isolated, while Chromium kept piling up cache directories — one probe run left 96 behind)

## [0.3.0] - 2026-10-27

### 中文

- **文件在外部被改动后，界面会自己跟上**：AI 写盘、git 拉取、别的编辑器保存，界面随即显示最新内容；你有未保存的修改时不会被静默覆盖，而是让你选保留哪一份
- **侧栏目录和搜索也实时跟上磁盘**：AI 新建、删除、改名文件，侧栏立刻多一行 / 少一行，全库搜索也能马上搜到，不用手动刷新
- **新增「重新载入」入口**：底栏按钮、命令面板、F5 都能重读磁盘上的当前文档，文件监视失效时也有兜底
- **单文件（未加入工作区的 .md）里的图片能正常显示了**：相对路径图片不再破图，AI 生成或从别处拿到的单篇文档可以直接打开阅读
- **大图查看修好了三件事**：mermaid 图按原始尺寸渲染不再糊、背景不再透出正文、关闭按钮不再被系统窗口按钮压住
- **关于页能查更新、直接下载安装了**：显示自己的 GitHub 地址；有新版本时应用内下载安装包并校验 SHA-256，通过后一键重启安装。下载走系统代理，需要挂代理才能访问 GitHub 的网络里也能用
- **底栏窄窗口不再乱**：路径优先显示文件名、前面省略（悬停看完整路径），按钮多了可横向滚动且不占布局，切渲染模式时按钮也不会再被挤动

#### 完整变更

- **应用内自动更新**：从 Release API 取本机平台与架构对应的安装包，下载后校验 SHA-256，校验不过只删文件不执行；Windows 走静默升级脚本（等主进程退出→安装→重启），macOS / Linux 交给系统安装流程
- **下载走 Chromium 网络栈**：`net.request` 而非 Node 全局 fetch——后者不读系统代理，在必须挂代理访问 GitHub 的网络里会表现为「点了更新，进度一动不动」
- **重定向逐跳验域**：GitHub 的 release 下载会 302 到带签名的 CDN 地址，每一跳都校验是否落在可信域，不合规立即中止
- **关于页**：新增项目主页入口、更新说明、下载进度条（带字节数与百分比）、取消下载、重启并安装；容器版明确提示由部署方升级
- **底栏路径尾部优先**：长路径从前面省略、保留文件名，悬停提示显示完整路径
- **底栏按钮区可横向滚动**：滚动条是自绘的悬浮条，绝对定位在底栏底边、悬停才显形，不占任何布局（原生滚动条会把 24px 撑高）
- **底栏按钮不再位移**：会随模式增减的控件（脏标记、折行开关）移到模式按钮左边，模式按钮与固定宽度的操作按钮位置在切模式时保持不变
- **外部改动自动同步**：主进程的文件监视事件真正接到界面（此前整条链路只差最后一跳，事件在发但没人订阅，文档模型里的「外部改动」处理是死代码）
- **目录结构实时跟随磁盘**：每个打开着的工作区挂一棵递归监视（400ms 合并成一批），新建 / 删除 / 改名文档后侧栏自动重扫、搜索索引自动作废重建；已打开的文档按变化路径逐个对账，后台标签的正文也一起更新
- **监视口径与扫描一致**：`.git` / `node_modules` / 素材目录里的写入不算内容变化（否则 `git status` 刷个 index 就会整树重扫）；图片等非 Markdown 文件不触发树的刷新
- **删除已打开的文档会明说**：标签保留、内容停在旧版本，同时提示「已从磁盘删除」，不再让界面装作无事发生
- **三种情形分别处理**：内容没变则什么都不做；缓冲区没有未保存修改则静默采用磁盘版本；有未保存修改则标记冲突并让你选择，绝不覆盖你刚敲的内容
- **手动重新载入**：底栏「重新载入」按钮（读屏标签同步）、命令面板 `doc.reload`、F5；顺带重扫目录树，外部新增/删除的文件也会出现
- **监视归属收口**：由应用按「当前文档」统一持有，切标签时跟着切换；切回已装载的文档先补读一次，避免看到后台期间的旧正文
- **单文件图片**：主进程在读取单文件时登记它的所在目录并下发 `docvi://local/<id>` 资产前缀，相对路径图片走这条通道取值；URL 里不含任何磁盘路径
- **解析基准修正**：单文件文档不再把绝对路径当作相对资源的基准（否则图片 URL 里会带 `C:/Users/…`）
- **大图尺寸修正**：mermaid 产物写的是 `width="100%"`，进入灯箱后没有可参照的包含块，浏览器按 300px 兜底——800×949 的图被排成 300×356 再放大，必然糊。现在打开时按 viewBox 钉死真实尺寸
- **大图可读下限**：图表打开时不会缩到比正文还小；拖拽与滚轮可以看细节，点「适应」时才真正装下全貌
- **大图背景改为实底**：去掉半透明与背景模糊，正文不再从图后透出来
- **大图拖拽不再选中文字**：拖拽期间禁用选区（旧实现加的那个类名从来没有对应样式，等于没生效）
- **覆盖层避让窗口按钮**：大图查看、流程图 / 状态机 / 表关系图的全屏降级覆盖层，顶栏统一避开窗口按钮所在的那一条（Windows 在右上、macOS 在左上），最右侧的关闭按钮不再被系统的 ✕ 盖住

### English

- **The view now follows changes made on disk**: edits from an AI agent, a `git pull` or another editor show up right away. If you have unsaved edits they are never silently overwritten — you choose which version to keep
- **The sidebar and search follow the disk too**: when an AI creates, deletes or renames a file, the tree gains or loses a row and full-text search finds it immediately — no manual refresh
- **New "Reload" entry point**: a status-bar button, a command-palette command and F5 all re-read the current document, covering cases where file watching fails
- **Relative images now work in standalone `.md` files** (documents not added as a workspace): no more broken images, so a single file from an AI or elsewhere can be read as-is
- **The large view is fixed in three ways**: mermaid diagrams render at their real size instead of turning blurry, the backdrop no longer shows the page behind it, and the close button is no longer buried under the window's own buttons
- **The About panel can check for updates and install them**: it links to the GitHub repo, and when a new version exists the app downloads the installer, verifies its SHA-256 and installs it on restart. Downloads use the system proxy, so they work on networks that need one to reach GitHub
- **The status bar stays tidy in narrow windows**: the path keeps its filename and elides the front (hover for the full path), extra buttons scroll horizontally without taking layout space, and switching render mode no longer shoves the mode buttons around

#### Full changes

- **External changes now reach the UI**: the main-process file watcher was already emitting events and the preload bridge was implemented, but nothing in the renderer subscribed — the store's external-change path was dead code
- **The tree tracks the disk live**: every open workspace gets a recursive watcher (batched over 400ms), so a created, deleted or renamed document rescans the tree and rebuilds the search index; open documents are reconciled by changed path, including those in background tabs
- **Watcher scope matches the scan**: writes under `.git` / `node_modules` / asset folders are not content changes (otherwise a `git status` index refresh would rescan the whole tree), and non-Markdown files do not refresh the tree
- **Deleting an open document is stated plainly**: the tab stays with its old content, plus a "deleted on disk" notice instead of pretending nothing happened
- **Three cases handled separately**: identical content does nothing; a clean buffer silently adopts the disk version; a dirty buffer is marked as a conflict and you pick, so nothing you typed is lost
- **Manual reload**: status-bar button, the `doc.reload` command and F5, which also rescans the tree so files added or removed outside the app show up
- **Single owner for watching**: the app holds the watcher for the active document and moves it as tabs change; returning to an already-loaded document re-reads it once instead of showing stale text
- **Standalone images**: reading a standalone file now registers its folder and hands back a `docvi://local/<id>` asset prefix, so relative images resolve; no disk path appears in the URL
- **Resolution base fixed**: standalone documents no longer use their absolute path as the base for relative resources (which leaked `C:/Users/…` into image URLs)
- **Large-view sizing**: mermaid emits `width="100%"`, which has no containing block inside the lightbox and falls back to 300px — an 800×949 diagram laid out at 300×356 and then upscaled, hence the blur. The size is now pinned from the viewBox
- **Legibility floor**: diagrams never open smaller than they were in the document; drag and wheel for detail, and "fit" shows the whole picture
- **Solid backdrop**: the lightbox is opaque, with no blur, so page content no longer shows through
- **Dragging no longer selects text**: selection is suppressed while dragging (the class the old code added never had a matching style, so it did nothing)
- **Overlays clear the window buttons**: the large view and the fullscreen fallbacks of flow diagrams / state machines / table graphs now push their top bar below the window-button strip (top-right on Windows, top-left on macOS), so the rightmost close button is no longer buried under the system ✕
- **In-app updates**: the app picks the asset matching this machine's platform and architecture from the release API, downloads it, verifies SHA-256 and only then offers to install. A failed check deletes the file and never runs it. Windows upgrades silently via a detached script that waits for the app to exit; macOS and Linux hand the file to the system installer
- **Downloads use the Chromium network stack**: `net.request` instead of Node's global `fetch`, which ignores the system proxy and would stall forever on networks that need one to reach GitHub
- **Per-hop redirect validation**: GitHub's release download redirects to a signed CDN URL; every hop is checked against the trusted-domain list and aborted otherwise
- **About panel**: project homepage link, release notes, a download progress bar with bytes and percentage, cancel, and "restart and install"; container builds say they are upgraded by the operator
- **Status bar keeps the filename**: long paths elide from the front, with the full path on hover
- **Status bar buttons scroll horizontally**: the scrollbar is self-drawn, absolutely positioned at the bar's bottom edge and only visible on hover, so it takes no layout space (a native one would push the 24px bar taller)
- **Status bar buttons stop moving**: controls that appear or resize (dirty marker, wrap toggle) moved to the left of the mode buttons, so the mode buttons and fixed-width actions keep their position when switching modes

## [0.2.2] - 2026-10-27

### 中文

- **表格与图片有了真正的可视化编辑**：点表格直接开网格编辑器，列和行都能在任意位置插入；图片支持选择文件、粘贴、拖拽，素材自动存进文档同级目录
- **切视图不再丢东西**：正在看的位置、未保存的改动、撤销记录都会跟着走，输入法打字也不会再把页面弹到顶部
- **支持 macOS 与 Linux 安装包**：新增 dmg（Intel 与 Apple Silicon 双架构）与 AppImage / deb
- **一批实时预览缺陷修好了**：删除线、勾选框、分割线现在按预期显示，格式按钮会亮出当前状态

#### 完整变更

- **删除线等行内格式不再显示原始语法**：选中文字尾部带空格或换行时，包裹出的 Markdown 语法不成立（CommonMark 定界规则），现在改为只包裹实际内容
- **格式按钮显示当前状态**：选区落在加粗 / 斜体 / 删除线 / 代码里时，对应的气泡按钮会亮起
- **表格编辑器**：弹窗尺寸随窗口自适应（不再写死宽度、窄窗口不会被裁）；单元格自动换行长高；行与列都能在任意位置插入、不再只能追加到末尾；点表格本体即打开弹窗
- **图片编辑器**：新增弹窗，可预览、选择本地文件、粘贴或拖拽图片；图片落到文档同级 `assets/` 并自动去重命名；图片块整块可点开
- **任务清单**：插入时不再预填「待办项」文字，方框可以直接点选
- **分割线**：紧贴上一行插入时自动补一个空行（否则会被解析成上一行的标题下划线，横线根本不出现）
- **切换视图保持阅读位置**：按源行而非滚动像素恢复，正在看的内容仍在视野里
- **切换视图保留撤销栈**：切一圈视图回来仍能 Ctrl+Z；同时修掉了「切视图后斜杠菜单不再弹出」——复用编辑器状态时必须换用新的扩展，否则回调还指向已销毁的组件
- **未保存状态不再跳变**：修掉保存后残留的防抖定时器把已保存内容写成草稿、进而在下次切视图时误「恢复草稿」覆盖当前输入的问题
- **输入法不再导致跳顶**：组合输入期间冻结装饰时保留块级内容，文档高度不塌陷
- **表格编辑按钮不再被遮挡**：按钮改为块内定位，表格滚到顶部时仍完整可见
- **表格上下留白可以继续写正文**：只有点在表格本体内才打开编辑器
- **发布流程带上版本说明**：Release 正文从本文件按版本号抽取，缺小节时发版直接失败
- **三平台安装包**：Windows 安装包、macOS dmg（x64 + arm64，ad-hoc 签名）、Linux AppImage + deb；同时裁剪 Electron 语言包并启用最大压缩

### English

- **Tables and images are now truly editable visually**: click a table to open the grid editor with row/column insertion at any position; images can be picked, pasted, or dropped, with assets saved next to the document
- **Switching views no longer loses anything**: reading position, unsaved edits, and undo history all survive, and IME input no longer jumps the page to the top
- **macOS and Linux packages**: dmg (both Intel and Apple Silicon) plus AppImage / deb
- **A batch of live-preview defects fixed**: strikethrough, task checkboxes, and dividers now render as expected, and format buttons show their active state

#### Full changes

- **Inline formatting no longer leaks raw syntax**: wrapping a selection that ends with whitespace produced invalid Markdown (CommonMark delimiter rules); markers are now placed around the visible content only
- **Format buttons reflect the current state**: bold / italic / strikethrough / code buttons light up when the selection is inside them
- **Table editor**: dialog sizes itself to the window instead of a fixed width; cells wrap and grow with their content; rows and columns can be inserted anywhere; clicking the table body opens it
- **Image editor**: new dialog with preview, file picker, paste, and drag-and-drop; images land in a sibling `assets/` folder with automatic rename on conflict; the whole image block is clickable
- **Task lists**: no more placeholder text on insert, and the checkbox is clickable
- **Dividers**: a blank line is inserted automatically when a divider would otherwise attach to the previous line and turn it into a heading underline
- **View switching keeps the reading position**: restored by source line rather than scroll offset, so what you were reading stays in view
- **View switching keeps undo history**: Ctrl+Z still works after a round trip; this also fixes the slash menu going silent, because reused editor state must be reconfigured with fresh extensions
- **Unsaved state no longer flips**: a leftover debounce timer used to rewrite saved content as a draft, which a later view switch would "restore" over current input
- **IME input no longer jumps the page**: decorations keep block content while composing, so document height does not collapse
- **Table edit button no longer clipped**: it is positioned inside the block and stays visible when the table scrolls to the top
- **Table padding is clickable for text again**: only clicks inside the table itself open the editor
- **Release notes are now part of the release**: the release body is extracted from this file by version, and missing sections fail the release
- **Three-platform packages**: Windows installer, macOS dmg (x64 + arm64, ad-hoc signed), Linux AppImage + deb; Electron locales trimmed and maximum compression enabled

## [0.2.1] - 2026-10-27

### 中文

- 表格的可视化编辑入口不再藏起来：悬停表格即可看到「编辑表格」，从斜杠菜单插入表格后直接打开网格编辑器
- 斜杠菜单的上下键按行跳转，可以直接进入增强组件区

### English

- The table edit entry is no longer hidden: hover a table to see the button, and inserting a table from the slash menu opens the grid editor directly
- Up/down arrows in the slash menu move by row, so enhanced components are reachable directly

## [0.2.0] - 2026-10-27

### 中文

- 首个公开版本：把任意 Markdown 目录变成可浏览、可搜索、可交互的文档站；桌面端支持实时预览编辑、工作区管理、临时分享与 MCP 接入
- 实时预览与阅读态的排版基准统一，切换模式不再错位
- 修复实时预览在长文档上不渲染、以及点击命中错行的问题
- 三平台打包链路打通

### English

- First public release: turn any Markdown directory into a browsable, searchable, interactive docs site, with live-preview editing, workspace management, temporary sharing, and MCP access on desktop
- Live preview and reader now share the same typography baseline, so switching modes no longer shifts text
- Fixed live preview not rendering on long documents and clicks landing on the wrong line
- Three-platform packaging pipeline working
