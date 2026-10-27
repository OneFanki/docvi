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

<!-- 摘要（2–5 条）写在这里。 -->

#### 完整变更

### English

<!-- Summary (2–5 lines). -->

#### Full changes

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
