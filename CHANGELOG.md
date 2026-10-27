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

（暂无）

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
