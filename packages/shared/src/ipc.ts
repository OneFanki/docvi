import type { AppSettings } from './settings.ts'

/**
 * 进程间契约的单一事实源。
 *
 * 主进程、preload、渲染进程三方都从这里取类型与通道名——任何一方私自拼字符串，
 * 都会让「改通道三处同步」退化成靠记忆维持。
 */

/** IPC 通道。命名规则：`docvi:<域>:<动作>`，动作动词用原形。 */
export const IPC = {
  appInfo: 'docvi:app:info',
  /** 用系统默认程序打开外链（只放行 http/https/mailto） */
  appOpenExternal: 'docvi:app:open-external',
  /** 检查更新（读发布清单，比对版本） */
  appUpdateCheck: 'docvi:app:update-check',
  /** 下载并校验本机平台的安装包（走 Chromium 网络栈，沿用系统代理） */
  appUpdateDownload: 'docvi:app:update-download',
  /** 取消正在进行的下载 */
  appUpdateCancel: 'docvi:app:update-cancel',
  /** 启动已下载并校验通过的安装包（应用会先退出） */
  appUpdateInstall: 'docvi:app:update-install',
  /** 主进程 → 渲染进程：下载 / 校验 / 安装进度 */
  appUpdateProgress: 'docvi:app:update-progress',
  /** 关于面板需要的运行时与构建信息 */
  appRuntimeInfo: 'docvi:app:runtime-info',
  /** 主进程 → 渲染进程：命令行 / 二次启动 / 文件关联带来的待打开文件 */
  appOpenPath: 'docvi:app:open-path',
  /** 渲染进程启动时拉取排队的打开请求（同时作为「已就绪」信号） */
  appPendingPaths: 'docvi:app:pending-paths',

  workspaceList: 'docvi:workspace:list',
  workspaceAdd: 'docvi:workspace:add',
  /** 只弹目录框、返回路径（不落库）：添加前要先探测内容根 */
  workspacePick: 'docvi:workspace:pick',
  /** 选定目录后探测内容根候选（旧版「添加目录三场景」） */
  workspaceProbe: 'docvi:workspace:probe',
  workspaceAddAt: 'docvi:workspace:add-at',

  /** git：能力探测 / 克隆仓库 / 拉取 / 分支列表 / 切换分支 */
  gitState: 'docvi:git:state',
  gitClone: 'docvi:git:clone',
  gitPull: 'docvi:git:pull',
  gitBranches: 'docvi:git:branches',
  gitSwitchBranch: 'docvi:git:switch-branch',
  /** 克隆进度推送（主进程 → 渲染进程） */
  gitProgress: 'docvi:git:progress',
  workspaceRemove: 'docvi:workspace:remove',
  workspaceTouch: 'docvi:workspace:touch',

  treeList: 'docvi:tree:list',
  docRead: 'docvi:doc:read',

  /** 单文件入口：系统文件选择框 */
  filePick: 'docvi:file:pick',
  /** 单文件入口：按绝对路径读取（拖放 / 命令行 / 关联） */
  fileRead: 'docvi:file:read',

  /**
   * 工作区内文件操作：新建 / 重命名 / 移动 / 复制 / 删除。
   *
   * 全部走「工作区 id + 相对路径」这一条口子：渲染进程永远拿不到任意绝对
   * 路径的写权限，每个操作都由主进程用 resolveInside 校验落在内容根内，
   * 越界（`..`、绝对路径、符号链接逃逸）直接拒绝。
   */
  fsCreate: 'docvi:fs:create',
  fsRename: 'docvi:fs:rename',
  fsMove: 'docvi:fs:move',
  fsCopy: 'docvi:fs:copy',
  /** 删除走系统回收站（可恢复），不做永久删除 */
  fsTrash: 'docvi:fs:trash',

  /**
   * 图片入库：把粘贴 / 拖入 / 选中的图片字节写进工作区素材目录。
   *
   * 图片不能走文档写通道（那是整文替换），也不能把 base64 直接塞进 Markdown
   * （几十 MB 的 data URL 会让文件没法读、版本历史爆掉）。字节走这条独立通道，
   * 主进程落到文档同级的 `assets/` 并回传相对路径。
   */
  imageImport: 'docvi:image:import',
  /**
   * 选择本地图片并**直接入库**（系统文件框）。
   *
   * 为什么不返回绝对路径让渲染进程再调一次 imageImport：系统文件框给的是磁盘
   * 绝对路径，把它写进 Markdown 是错的（渲染时会被当相对路径拼前缀，必然破图）。
   * 主进程手上已经有文件了，直接读字节 → 落盘 → 回传相对路径，一步到位。
   */
  imagePick: 'docvi:image:pick',

  /** 搜索语料：整库文档全文（按工作区缓存，索引在渲染进程 worker 里建） */
  searchCorpus: 'docvi:search:corpus',

  recentList: 'docvi:recent:list',
  recentTouch: 'docvi:recent:touch',
  recentClear: 'docvi:recent:clear',

  /** 保存：原子写（临时文件 + rename），并做「磁盘是否已被外部改动」判定 */
  docWrite: 'docvi:doc:write',
  /**
   * 导出：Markdown / HTML / PDF。
   *
   * 合成一条通道而不是三条：三种格式共用「弹保存框 → 写文件」的流程，
   * 差别只在产物字节从哪来。拆三条会让参数校验与错误码重复三份。
   */
  docExport: 'docvi:doc:export',
  /** 草稿：崩溃/误关后的恢复缓冲 */
  draftRead: 'docvi:draft:read',
  draftWrite: 'docvi:draft:write',
  draftClear: 'docvi:draft:clear',
  /** 主进程 → 渲染进程：被编辑文件在磁盘上变化了 */
  docExternalChange: 'docvi:doc:external-change',
  /** 订阅/退订某个文件的磁盘变化（编辑态启用） */
  docWatch: 'docvi:doc:watch',
  docUnwatch: 'docvi:doc:unwatch',
  /**
   * 目录树变化：递归监视内容根，让 AI / git 新建、删除、改名的文件自动出现在侧栏。
   *
   * 与 `docExternalChange` 分开：那条是「某个已打开的文档内容变了」，
   * 这条是「目录结构变了」。两者的渲染层处理完全不同（前者换缓冲区，
   * 后者重扫树并作废搜索索引）。
   */
  workspaceWatch: 'docvi:workspace:watch',
  workspaceUnwatch: 'docvi:workspace:unwatch',
  workspaceFilesChanged: 'docvi:workspace:files-changed',

  /** 插件：列表 / 安装 / 卸载 / 启停；以及「按插件 id 读资源」的路径解析 */
  pluginList: 'docvi:plugin:list',
  /** 插件市场清单（远端配置文件 + 本地缓存） */
  pluginMarket: 'docvi:plugin:market',
  pluginInstall: 'docvi:plugin:install',
  pluginUninstall: 'docvi:plugin:uninstall',
  pluginSetEnabled: 'docvi:plugin:set-enabled',
  pluginSetComponentEnabled: 'docvi:plugin:set-component-enabled',

  /** 本地服务：状态 / 重启 / 局域网开关 / 在浏览器打开 MCP 地址 */
  serviceState: 'docvi:service:state',
  serviceRestart: 'docvi:service:restart',
  serviceSetLan: 'docvi:service:set-lan',
  /** 改首选端口（重启后生效；当前端口被占用时服务会顺延） */
  serviceSetPort: 'docvi:service:set-port',
  /** 打开服务日志所在目录（用户排查启动失败时唯一有用的东西） */
  serviceOpenLog: 'docvi:service:open-log',
  /** 主进程 → 渲染进程：服务状态变化（启动、崩溃、重启） */
  serviceChanged: 'docvi:service:changed',

  /** 桌面外壳行为：开机自启动 / 关闭窗口留在托盘 */
  desktopPrefs: 'docvi:desktop:prefs',
  desktopSetAutostart: 'docvi:desktop:set-autostart',
  desktopSetCloseToTray: 'docvi:desktop:set-close-to-tray',

  /** 临时分享：列表 / 新建（文件或目录）/ 删除 / 在浏览器打开 */
  shareList: 'docvi:share:list',
  shareCreate: 'docvi:share:create',
  /** 按已知路径直接分享（分享当前打开的文档，不必再走一次选择框） */
  shareCreatePath: 'docvi:share:create-path',
  shareRemove: 'docvi:share:remove',
  shareOpen: 'docvi:share:open',

  /** 设置：读取 / 增量写入 / 外部修改通知；启动快照走同步通道（避免首帧闪烁） */
  settingsRead: 'docvi:settings:read',
  settingsWrite: 'docvi:settings:write',
  /** 同步窗口按钮配色（Windows 原生 overlay 不读页面 CSS，只能由主进程改） */
  windowAppearance: 'docvi:window:appearance',
  settingsChanged: 'docvi:settings:changed',
  settingsSnapshot: 'docvi:settings:snapshot',
  /** 会话：标签列表 / MRU / 历史（程序自动维护，不进设置导出） */
  sessionRead: 'docvi:session:read',
  sessionWrite: 'docvi:session:write',
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 统一错误码。渲染进程按码分支，不解析 message 文本。 */
export const ERROR_CODES = [
  'E_INVALID',
  'E_NOT_FOUND',
  'E_FORBIDDEN',
  'E_IO',
  'E_CANCELED',
  'E_TOO_LARGE',
  /** 目标位置已有同名条目（新建 / 改名 / 移动）：本身不是错误，要提示用户换个名字 */
  'E_EXISTS',
  'E_INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/**
 * IPC 统一返回信封。
 *
 * 为什么不用异常：Electron 会把跨进程错误序列化成不可读字符串，栈与错误码都丢；
 * 显式信封让「可预期的失败」成为普通数据，只有真正的 bug 才冒泡到控制台。
 */
export type Result<T> =
  { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } }

/** 深度可选的补丁类型：settingsWrite 只要求传要改的字段 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** 关于面板的运行时信息 */
export interface RuntimeInfo {
  /** 应用版本（app.getVersion()；容器版取构建期注入值） */
  version: string
  electron: string | null
  chrome: string | null
  node: string | null
  v8?: string | null
  platform: string
  arch: string
  dataDir: string
  /** 是否为打包产物 */
  packaged: boolean
  /** 开源 / 项目主页（可为空） */
  homepage?: string
}

/**
 * 一个可下载的发布资产。
 *
 * `sha256` 是**必填才有资格被下载**（不是可选优化）：待执行的安装包必须能
 * 校验，拿不到校验值的版本只能引导用户去下载页手动处理。
 */
export interface UpdateAsset {
  /** 发布时的文件名（同时用作本地落盘名，只保留安全字符） */
  name: string
  /** 直链（HTTPS） */
  url: string
  /** 字节数；缺失时进度条按不确定态显示 */
  size?: number
  /** 小写十六进制 SHA-256（GitHub Release 的 digest 字段） */
  sha256?: string
}

/**
 * 检查更新结果。
 *
 * three 态：latest（最新）/ outdated（有新版）/ unavailable（源不可达或未配置）。
 * unavailable 不是错误——离线或还没发布渠道时它才是常态。
 */
export interface UpdateCheckResult {
  status: 'latest' | 'outdated' | 'unavailable'
  current: string
  latest?: string
  /** 新版下载页（浏览器打开；应用内下载不可用时的回退） */
  downloadUrl?: string
  notes?: string
  /** 检查失败 / 未配置时的可读原因 */
  message?: string
  checkedAt: number
  /** 与本机平台 + 架构匹配的资产；缺失 = 只能去下载页 */
  asset?: UpdateAsset
}

/** 更新镜像的阶段：UI 按阶段换文案，不必猜 */
export type UpdatePhase = 'idle' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error'

export interface UpdateProgress {
  phase: UpdatePhase
  /** 正在处理的版本 */
  version?: string
  /** 已下载字节 */
  received?: number
  /** 总字节（服务端没给 Content-Length 时缺失） */
  total?: number
  /** error 阶段的可读原因 */
  message?: string
}

/** 安装包已下载并校验通过，可以交给安装程序 */
export interface UpdateDownloaded {
  version: string
  /** 文件名（仅用于展示，不暴露磁盘路径） */
  fileName: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  dataDir: string
}

/**
 * 内容根里的文件变化（一次批量，已防抖）。
 *
 * 不逐条推送事件：`git checkout` 或批量生成会瞬间产生成百上千条，
 * 每条约一次整树重扫会让界面卡死。主进程按批收拢后只报一条。
 */
export interface WorkspaceFilesChange {
  workspaceId: string
  /** 本批次变化过的相对路径（正斜杠）；平台不提供时为单个空串 */
  paths: string[]
}

export interface WorkspaceEntry {
  id: string
  name: string
  /** 绝对路径：由主进程持有并校验，渲染进程只用于展示 */
  root: string
  addedAt: number
  lastOpenedAt: number
  /**
   * git 托管的平台副本信息（缺省 = 普通本地目录工作区）。
   *
   * 托管工作区的 root 指向分支工作树 `worktrees/<repo>/<branch>/`——平台自持，
   * 云端为准（切换分支即换一棵树），用户自己的目录永不写入。
   */
  git?: GitWorkspace
  /**
   * 容器读者面：平台侧仓库状态（桌面工作区没有这个字段）。
   *
   * 分支选择器、卡片上的「克隆中 / 同步失败 / 最近同步」都从这里取数——
   * 这些信息部署器本来就在 `/api/portal` 里给，界面不该再去猜。
   */
  portal?: PortalWorkspace
}

/** 部署器已发布的一个分支（读者面口径） */
export interface PortalBranch {
  branch: string
  /** 产物：ready 才能浏览；building/failed/none 只作状态展示 */
  artifact: 'ready' | 'building' | 'failed' | 'none'
  /** 索引：indexed 才是最新且可搜索 */
  index: 'indexed' | 'indexing' | 'pending' | 'failed'
  isDefault: boolean
}

/** 容器仓库的读者面状态 */
export interface PortalWorkspace {
  branches: PortalBranch[]
  defaultBranch: string | null
  /** 最近一次同步完成时间（ISO）；从未同步为 null */
  syncAt: string | null
  /** 上次同步失败信息（成功时 null） */
  syncError: string | null
  /** 首次克隆尚未完成：卡片显示「克隆中」并禁止进入 */
  cloning: boolean
}

/**
 * 本地预览装载项：浏览器读成的文本 + 内容根内相对路径。
 *
 * 容器读者面没有磁盘，但用户经常要「先看一眼 AI 刚生成的文件」再提交——
 * 旧版首页支持拖入/选择本地 Markdown，在内存里浏览。这个类型就是那条通道。
 */
export interface LocalPreviewFile {
  path: string
  text: string
}

/** 本地预览临时工作区的固定 id（路由前缀 `/__local/` 与它一一对应） */
export const LOCAL_PREVIEW_ID = '__local'

/** 一个 git 托管工作区当前读的是哪份副本的哪个分支 */
export interface GitWorkspace {
  /** 平台副本名（数据目录 `git/<repo>.git`） */
  repo: string
  /** 远端地址（展示与「刷新」提示用） */
  url: string
  branch: string
}

/** git 能力面（宿主探测 + 克隆 / 拉取 / 分支 / 切换） */
export interface GitState {
  /** git 是否可用；不可用时 reason 给安装指引 */
  available: boolean
  version: string | null
  reason: string | null
}

/** 克隆进度事件（主进程 → 渲染进程推送） */
export interface GitProgressEvent {
  workspaceName: string
  phase: string
  message: string
  percent: number | null
}

/**
 * 添加目录时的内容根探测结果。
 *
 * 用户常选中「仓库根」或「文档总目录」，真正的文档根在里面一层。三者都不命中时
 * 仍可添加（自动扫描模式），只是没有配置语义——所以这不是「能不能加」的判据，
 * 而是「要不要问一句」的判据。
 */
export interface WorkspaceProbeResult {
  hasConfig: boolean
  hasDocs: boolean
  candidates: Array<{ name: string; path: string }>
}

export type TreeNodeType = 'dir' | 'doc'

export interface TreeNode {
  /** 相对 workspace 根的 POSIX 路径；根目录为空串 */
  path: string
  name: string
  type: TreeNodeType
  /** 目录落地页的相对路径（index.md / README.md / 索引.md） */
  landing?: string
  children?: TreeNode[]
}

export interface DocPayload {
  /** 工作区内相对路径；单文件打开时为文件绝对路径（正斜杠形式） */
  path: string
  /** 磁盘绝对路径：最近打开、外部打开去重、在文件管理器中定位 */
  absolutePath: string
  /** 展示用标题：首个 H1，缺失时回退文件名 */
  title: string
  text: string
  mtime: number
  size: number
  /**
   * 正文图片的资产前缀（桌面单文件才有）。
   *
   * 工作区文档由宿主按「当前工作区」统一推导前缀；单文件没有内容根，只能由
   * 主进程在读取时登记它的所在目录并回传 `docvi://local/<id>`。缺省表示
   * 「用宿主默认推导」，不是「没有图片」。
   */
  assetPrefix?: string
}

/**
 * 是否为「工作区外的单文件」。
 *
 * 判据是 path 与 absolutePath 指向同一文件——注意两者斜杠方向不同
 * （path 统一正斜杠，absolutePath 保留平台原生），不能直接字符串比较。
 */
export function isStandaloneDoc(doc: Pick<DocPayload, 'path' | 'absolutePath'>): boolean {
  const normalize = (value: string): string => value.replaceAll('\\', '/').toLowerCase()
  return normalize(doc.path) === normalize(doc.absolutePath)
}

/** 搜索语料中的一篇文档。正文在主进程按上限截断，索引在渲染 worker 里建。 */
export interface SearchDoc {
  /** 工作区内相对路径 */
  path: string
  text: string
}

/** 宿主侧搜索的一条命中（容器里索引在服务端，覆盖全部仓库）。 */
export interface HostSearchHit {
  /** 命中所属工作区（仓库 slug）；单文件入口不产生命中 */
  workspaceId: string | null
  path: string
  title: string
  score: number
  snippet: string
}

export interface HostSearchResult {
  /** 索引里的文档总数（搜索面板据此显示「已索引 N 篇」） */
  total: number
  hits: HostSearchHit[]
}

/** 最近打开：按绝对路径去重，单文件打开的 workspaceId 为 null。 */
export interface RecentEntry {
  path: string
  workspaceId: string | null
  /** 工作区内相对路径；单文件时为空串 */
  relPath: string
  title: string
  openedAt: number
}

/** 保存请求。baseMtime 是「我读进来时的 mtime」，用于冲突判定。 */
export interface WriteDocRequest {
  /** 绝对路径（工作区文档与单文件都走它） */
  absolutePath: string
  text: string
  /** 载入时的 mtime；磁盘 mtime 与之不同即判定为外部改动 */
  baseMtime: number
  /** true = 忽略冲突强制覆盖 */
  force?: boolean
}

export type WriteDocResult =
  | { status: 'saved'; mtime: number; size: number }
  /** 磁盘已被外部改动：调用方决定「覆盖 / 放弃 / 看差异」 */
  | { status: 'conflict'; mtime: number; size: number }

export interface DraftPayload {
  text: string
  updatedAt: number
}

/** 导出格式。三种产物的字节来源不同，见 ExportDocRequest。 */
export type ExportFormat = 'markdown' | 'html' | 'pdf'

/**
 * 导出请求。
 *
 * 产物内容由渲染进程准备好再交给主进程——只有渲染进程知道当前文档渲染成了
 * 什么（组件卡片、Mermaid、代码高亮都是运行期产物）。主进程只负责
 * 「弹保存框 + 写字节」，不理解 Markdown。
 *
 * - markdown：`text` 是原始缓冲区（原封不动，含 frontmatter）
 * - html：`text` 是完整 HTML 文档（样式已内联、图片已转 data URL）
 * - pdf：`text` 也是完整 HTML，主进程放进隐藏窗口打印成 A4
 */
export interface ExportDocRequest {
  format: ExportFormat
  /** 默认文件名（不含扩展名），由渲染进程按文档标题生成 */
  suggestedName: string
  text: string
  /**
   * 文档里含几个只有 docvi 能渲染的富组件。
   *
   * 导出 markdown 成功后要把这个数报给用户：这份文件换编辑器打开会看到
   * `<at-*>` 引用与 frontmatter 声明，而不是卡片。不做拦截弹窗——
   * 用户可能就是要导源文件。
   */
  richComponents?: number
}

/** 导出结果：用户取消时 `canceled` 为 true、`path` 为空串 */
export interface ExportDocResult {
  canceled: boolean
  path: string
}

/** 文件操作的目标类型：普通文件 / 目录 */
export type FsEntryKind = 'file' | 'dir'

/**
 * 文件操作结果：只回新位置的相对路径，不回绝对路径。
 *
 * 渲染进程本来就知道工作区根，相对路径已经够用；把绝对路径回传只会多一个
 * 「两边各存一份路径」的漂移源。
 */
export interface FsOpResult {
  /** 操作后条目的相对路径（POSIX 分隔符）；删除时为被删路径 */
  relPath: string
}

/**
 * 图片入库请求。
 *
 * `data` 是 base64（不含 `data:` 前缀）：渲染进程从 File / 剪贴板字节读出来。
 * 用 base64 而不是传 File 对象——File 跨不了 IPC，而且主进程需要的是字节本身。
 */
export interface ImageImportRequest {
  workspaceId: string
  /** 文档在内容根内的相对路径：素材落在它同级的 `assets/` 下 */
  docRelPath: string
  /** 原始文件名（只取扩展名与主名，路径部分会被丢弃） */
  name: string
  /** base64 编码的图片字节 */
  data: string
}

/** 图片入库结果：相对文档目录的 Markdown 可用路径（如 `assets/图-1.png`） */
export interface ImageImportResult {
  /** 相对**文档所在目录**的路径，可直接写进 `![](...)` */
  relPath: string
  /** 落盘后的绝对路径（用于预览与「在文件夹中显示」） */
  absolutePath: string
  /** 实际写入的字节数 */
  size: number
}

/** preload 经 contextBridge 暴露给渲染进程的完整表面。 */
export interface DocviApi {
  /**
   * 启动设置快照（同步读取一次，避免首帧闪默认主题）。
   *
   * 只读：后续变更一律走 settingsWrite / settingsChanged，不鼓励轮询这个字段。
   */
  bootSettings: AppSettings

  /**
   * 宿主类型。
   *
   * 渲染层靠它决定「哪些入口不该出现」，而不是去猜某个方法是否存在：
   * 容器里没有「打开本地文件」「克隆仓库」「改托盘设置」这些动作，
   * 露出来只会让用户点了报错。
   * 缺省视为 `electron`（老版本 preload 没这个字段，行为不变）。
   */
  hostKind?: 'electron' | 'web'

  /**
   * 插件包内资源的可访问 URL（容器宿主用）。
   *
   * Electron 走自定义协议 `docvi://plugin/...`；容器里资源是 HTTP 路径
   * `/plugins/<name>/<version>/...`。不给这个方法就说明宿主支持自定义协议。
   */
  pluginAssetUrl?(plugin: string, relPath: string): string

  appInfo(): Promise<Result<AppInfo>>
  /**
   * 用系统默认程序打开外链。
   *
   * 正文里的 `https://…` 链接必须走这里：在窗口里直接导航会**离开应用**
   * （Electron 把当前页换成目标站点，返回路径全丢，看起来就是「界面空了」）。
   * 只放行 http/https/mailto，其余协议一律拒绝。
   */
  appOpenExternal(url: string): Promise<Result<null>>
  /** 关于面板：运行时版本、构建信息、数据目录 */
  appRuntimeInfo(): Promise<Result<RuntimeInfo>>
  /** 检查更新：读发布清单，并解析出与本机平台匹配的安装包 */
  appUpdateCheck(): Promise<Result<UpdateCheckResult>>
  /**
   * 下载并校验更新包。
   *
   * 传入的是上一次 `appUpdateCheck` 返回的资产与版本（主进程会再校验一遍地址
   * 与校验和，不信任渲染层传来的任何字段）。
   *
   * 下载走 Chromium 网络栈，因此**沿用系统代理**——这正是它不能换成 Node
   * 全局 fetch 的原因：Node 的 fetch 不读系统代理，在必须挂代理才能访问
   * GitHub 的网络里会直接超时，用户看到的是「点了没反应」。
   *
   * 校验不通过只会删掉临时文件并返回失败，绝不会把未校验的文件交出去。
   */
  appUpdateDownload(request: {
    asset: UpdateAsset
    version: string
  }): Promise<Result<UpdateDownloaded>>
  /** 取消正在进行的下载（没有下载在执行时是空操作） */
  appUpdateCancel(): Promise<Result<null>>
  /**
   * 安装已下载并校验通过的更新。
   *
   * 应用会先退出再交给安装程序：Windows 不允许覆盖正在运行的 exe。
   * 返回成功不代表已经启动完成——真正的启动发生在本进程退出之后。
   */
  appUpdateInstall(): Promise<Result<null>>
  /** 订阅下载 / 校验 / 安装进度；返回取消订阅函数 */
  onUpdateProgress(callback: (progress: UpdateProgress) => void): () => void
  /** 取走启动排队的待打开文件（调用即视为渲染进程已就绪） */
  appPendingPaths(): Promise<Result<string[]>>

  workspaceList(): Promise<Result<WorkspaceEntry[]>>
  /** 打开系统目录选择框；用户取消时 data 为 null */
  workspaceAdd(): Promise<Result<WorkspaceEntry | null>>
  /** 只弹目录框并返回绝对路径（不落库）；取消时 data 为 null */
  workspacePick(): Promise<Result<string | null>>
  /**
   * 按已知绝对路径添加工作区（探测后确认候选用）。
   *
   * 与 workspaceAdd 分开是因为后者要弹系统目录框：探测流程已经拿到路径了，
   * 再弹一次框等于让用户选两遍。
   */
  workspaceAddAt(root: string): Promise<Result<WorkspaceEntry | null>>
  /** 探测一个目录：是否内容根 / 一层子目录里的候选 / 有没有直接 .md */
  workspaceProbe(root: string): Promise<Result<WorkspaceProbeResult>>

  /** git 是否可用（读 `git --version`，不可用时给安装指引） */
  gitState(): Promise<Result<GitState>>
  /**
   * 克隆远端仓库并加为工作区。
   *
   * 产物是**平台自持副本 + 分支工作树**：只写数据目录，绝不碰用户磁盘上的仓。
   * 进度经 `onGitProgress` 推送；成功返回新建的工作区条目。
   */
  gitClone(input: { url: string; name: string; branch?: string }): Promise<Result<WorkspaceEntry>>
  /** 拉取当前分支（fetch + reset --hard，云端为准）；返回新增提交数 */
  gitPull(id: string): Promise<Result<{ branch: string; commits: number; changed: boolean }>>
  /** 列出平台副本的分支（先 fetch，离线时用本地 refs） */
  gitBranches(id: string): Promise<Result<string[]>>
  /** 切换工作区分支：返回换树后的工作区条目（root 已更新） */
  gitSwitchBranch(id: string, branch: string): Promise<Result<WorkspaceEntry>>
  /** 订阅克隆进度；返回取消订阅函数 */
  onGitProgress(callback: (progress: GitProgressEvent) => void): () => void
  workspaceRemove(id: string): Promise<Result<null>>
  workspaceTouch(id: string): Promise<Result<null>>

  treeList(workspaceId: string): Promise<Result<TreeNode[]>>
  docRead(workspaceId: string, path: string): Promise<Result<DocPayload>>

  /**
   * 在 `dirRelPath` 下新建条目。
   *
   * 目录传空串表示工作区根。`name` 只是名字，不含分隔符——拼接与校验都在
   * 主进程做，渲染进程不拼路径。新建的 .md 会带一个空标题骨架，方便直接写。
   */
  fsCreate(
    workspaceId: string,
    dirRelPath: string,
    name: string,
    kind: FsEntryKind,
  ): Promise<Result<FsOpResult>>
  /** 就地改名（同一目录内）；不允许改名时带上路径分隔符 */
  fsRename(workspaceId: string, relPath: string, nextName: string): Promise<Result<FsOpResult>>
  /** 移动到另一个目录（同工作区）；目标同名已存在时报 E_EXISTS */
  fsMove(workspaceId: string, relPath: string, targetDir: string): Promise<Result<FsOpResult>>
  /** 复制到另一个目录（同工作区）；目录递归复制，重名自动加 -副本 后缀 */
  fsCopy(workspaceId: string, relPath: string, targetDir: string): Promise<Result<FsOpResult>>
  /** 删除（进系统回收站，可恢复） */
  fsTrash(workspaceId: string, relPath: string): Promise<Result<FsOpResult>>

  /**
   * 把图片字节写进工作区素材目录，返回可写进 Markdown 的相对路径。
   *
   * 容器读者面没有写权限，由 `web-host` 实现为 E_FORBIDDEN（与其它写操作一致）——
   * 契约上必须存在，渲染层只按 `hostKind` 决定是否露出入口，不做方法存在性探测。
   */
  imageImport(request: ImageImportRequest): Promise<Result<ImageImportResult>>
  /**
   * 选本地图片并直接入库。
   *
   * `workspaceId` 必须给：图片要落到该工作区的素材目录。取消时 data 为 null。
   */
  imagePick(request: {
    workspaceId: string
    docRelPath: string
  }): Promise<Result<ImageImportResult | null>>

  /** 系统文件选择框；取消时 data 为 null */
  filePick(): Promise<Result<string | null>>
  fileRead(absolutePath: string): Promise<Result<DocPayload>>

  /**
   * 把浏览器选中的本地 Markdown 装载成一个**临时工作区**（容器读者面）。
   *
   * 内容只在内存里：刷新即失效、不写服务器、不影响任何仓库。桌面宿主没有
   * 这个场景（它有真实磁盘与工作区），实现为返回 null 的空操作。
   *
   * `kind: 'dir'` 时按文件路径建目录树；`'files'` 时全部平铺在同一层。
   * 返回的 workspace id 固定为 `LOCAL_PREVIEW_ID`，路由落在 `/__local/…`。
   */
  localPreview(
    files: LocalPreviewFile[],
    kind: 'files' | 'dir',
  ): Promise<Result<WorkspaceEntry | null>>

  searchCorpus(workspaceId: string): Promise<Result<SearchDoc[]>>

  /**
   * 宿主侧全文搜索（可选）：索引已在服务端构建好时，渲染进程不该再拉整库
   * 原文自己建一份。提供这个方法即接管整个搜索面板（跨全部仓库、一次查询）。
   */
  searchQuery?(query: string): Promise<Result<HostSearchResult>>

  recentList(): Promise<Result<RecentEntry[]>>
  /** 记录一次打开（按绝对路径覆盖），返回更新后的列表 */
  recentTouch(entry: Omit<RecentEntry, 'openedAt'>): Promise<Result<RecentEntry[]>>
  recentClear(): Promise<Result<RecentEntry[]>>

  /** 订阅「外部要求打开某个文件」；返回取消订阅函数 */
  onOpenPath(callback: (absolutePath: string) => void): () => void
  /** 拖放文件取磁盘路径（webUtils；渲染进程拿不到 File.path） */
  pathsForFiles(files: File[]): string[]

  /** 保存（原子写 + 冲突判定） */
  docWrite(request: WriteDocRequest): Promise<Result<WriteDocResult>>
  /** 导出（弹保存框 → 写文件）；用户取消时 data.canceled 为 true */
  docExport(request: ExportDocRequest): Promise<Result<ExportDocResult>>
  draftRead(absolutePath: string): Promise<Result<DraftPayload | null>>
  draftWrite(absolutePath: string, text: string): Promise<Result<null>>
  draftClear(absolutePath: string): Promise<Result<null>>
  /** 订阅「正在编辑的文件在磁盘上被改动」；返回取消订阅函数 */
  onExternalChange(callback: (absolutePath: string) => void): () => void
  /** 开始/停止监视某个文件（编辑态启用，阅读态不占句柄） */
  docWatch(absolutePath: string): Promise<Result<null>>
  docUnwatch(absolutePath: string): Promise<Result<null>>

  /**
   * 订阅「内容根里的文件被外部新建 / 删除 / 改名」；返回取消订阅函数。
   *
   * 与 `onExternalChange` 的区别：那条讲的是某个**已打开文档**的内容变了，
   * 这条讲的是**目录结构变了**——侧栏要重扫，搜索索引要作废。
   */
  onWorkspaceFilesChanged(callback: (change: WorkspaceFilesChange) => void): () => void
  /** 开始/停止递归监视一个工作区的内容根 */
  workspaceWatch(workspaceId: string): Promise<Result<null>>
  workspaceUnwatch(workspaceId: string): Promise<Result<null>>

  pluginList(): Promise<Result<PluginRecordView[]>>
  /**
   * 读插件市场清单：优先本地缓存，`refresh: true` 时先拉远端再落缓存。
   *
   * 拉取失败不算错误——有缓存就返回缓存并附 `error`（界面提示「这是离线副本」），
   * 没缓存就返回空目录。市场不可用绝不能拖垮已装插件列表。
   */
  pluginMarket(options?: { refresh?: boolean }): Promise<Result<MarketCatalog>>
  /** 打开目录选择框安装插件；取消时 data 为 null */
  pluginInstall(): Promise<Result<PluginRecordView | null>>
  pluginUninstall(id: string): Promise<Result<PluginRecordView[]>>
  pluginSetEnabled(id: string, enabled: boolean): Promise<Result<PluginRecordView[]>>
  /** 逐组件启停：停用某 kind 后，声明同名 kind 的其他包会自动顶上来 */
  pluginSetComponentEnabled(
    id: string,
    kind: string,
    enabled: boolean,
  ): Promise<Result<PluginRecordView[]>>

  /** 本地服务状态（MCP 端点、端口、局域网开关、崩溃信息） */
  serviceState(): Promise<Result<ServiceState>>
  serviceRestart(): Promise<Result<ServiceState>>
  serviceSetLan(lan: boolean): Promise<Result<ServiceState>>
  /** 改首选端口并重启；端口非法时返回 E_INVALID */
  serviceSetPort(port: number): Promise<Result<ServiceState>>
  /** 在系统文件管理器里打开数据目录（里面有 serve.log） */
  serviceOpenLog(): Promise<Result<null>>
  /** 订阅服务状态变化；返回取消订阅函数 */
  onServiceChanged(callback: (state: ServiceState) => void): () => void

  /** 读外壳行为：自启动（读注册表实际状态）与关闭留托盘 */
  desktopPrefs(): Promise<Result<DesktopPrefsState>>
  /** 开关开机自启动；返回写入后的实际状态 */
  desktopSetAutostart(enabled: boolean): Promise<Result<DesktopPrefsState>>
  desktopSetCloseToTray(enabled: boolean): Promise<Result<DesktopPrefsState>>

  shareList(): Promise<Result<ShareEntry[]>>
  /** 新建分享：文件或目录由用户在选择框里选；取消时 data 为 null */
  shareCreate(): Promise<Result<ShareEntry | null>>
  /** 按已知绝对路径分享（分享当前文档） */
  shareCreatePath(absolutePath: string): Promise<Result<ShareEntry | null>>
  shareRemove(id: string): Promise<Result<ShareEntry[]>>
  shareOpen(id: string): Promise<Result<null>>

  /** 读取完整设置（文件被外部改动时也用它刷新） */
  settingsRead(): Promise<Result<AppSettings>>
  /** 增量写入：只传要改的部分，主进程合并后原子落盘 */
  settingsWrite(patch: DeepPartial<AppSettings>): Promise<Result<AppSettings>>
  /**
   * 告诉主进程当前主题的明暗，用于给窗口按钮（最小化/最大化/关闭）配色。
   *
   * 插件主题的明暗只有渲染层知道（主题清单在插件里），主进程按主题 id 猜不出来；
   * 所以这里传的是解析后的 appearance，而不是主题 id。
   */
  setWindowAppearance(appearance: 'light' | 'dark'): Promise<Result<null>>
  /** 订阅外部对 settings.json 的修改；返回取消订阅函数 */
  onSettingsChanged(callback: (settings: AppSettings) => void): () => void

  /** 会话状态（标签、MRU、历史）；结构由渲染层定义，主进程只负责存取 */
  sessionRead(): Promise<Result<unknown>>
  sessionWrite(session: unknown): Promise<Result<null>>
}

/**
 * 插件市场清单条目。
 *
 * **市场是一份远端配置文件**：托管在 GitHub（raw 地址），列第三方的插件与它们的
 * 仓库地址。清单本身不含内置插件——内置插件随安装包发布，不存在「安装」这个
 * 动作，只在「已安装」里启停。
 *
 * 桌面端对市场条目的能力边界：
 *  - 能做的事：浏览清单、打开插件仓库、查看缓存与刷新；
 *  - 不能做的事：从市场下载安装。插件是预构建产物（dist/index.js + style.css），
 *    安装需要下载 tarball、解压、校验、落位，桌面端刻意保持零运行时依赖
 *    （安装包里不带 node_modules），这条链只有容器运维面有。
 */
export interface MarketEntry {
  name: string
  displayName: { zh: string; en?: string }
  version: string
  description?: { zh: string; en?: string }
  trust: 'presentation' | 'sandbox-service' | 'trusted-service'
  tags?: string[]
  /** 插件源码仓库（GitHub 等）。桌面端的主要动作就是打开它 */
  repository: string
  /** 预构建 tarball（可选）：容器运维面据此安装，桌面端只展示 */
  tarball?: string
}

export interface MarketCatalog {
  schemaVersion: number
  updatedAt?: string
  plugins: MarketEntry[]
  /**
   * 本地缓存的拉取时间（epoch ms）；0 = 从未成功拉取过。
   *
   * 必须带上：清单是远端文件，用户需要知道看到的是「刚才的」还是「三天前的」。
   */
  fetchedAt: number
  /** 清单的远端地址（界面上直接显示，方便排查「为什么没有新插件」） */
  sourceUrl: string
  /** 最近一次拉取失败的原因；有缓存时只是提示，不影响展示 */
  error?: string
}

/**
 * 插件记录（主进程与渲染进程共用形状）。
 *
 * 定义在 shared 而不是 plugin-api：plugin-api 是对外发布的协议包，
 * 不该知道「内置 / 用户安装」这类宿主内部概念。
 */
export interface PluginRecordView {
  name: string
  displayName: { zh: string; en?: string }
  version: string
  apiVersion: string
  description?: { zh: string; en?: string }
  trust: 'presentation' | 'sandbox-service' | 'trusted-service'
  entry?: string
  styles?: string[]
  dependencies?: string[]
  /** 插件用法文档（包内相对路径，约定 docs/SKILL.md） */
  docs?: string
  contributes?: {
    components?: Array<{
      kind: string
      title: { zh: string; en?: string }
      description: { zh: string; en?: string }
      example?: string
    }>
    themes?: Array<{
      id: string
      title: { zh: string; en?: string }
      appearance: 'light' | 'dark'
      tokens: string
    }>
    markdownSyntax?: Array<{
      name: string
      form: 'fence' | 'container'
      component: string
      title: { zh: string; en?: string }
      description: { zh: string; en?: string }
    }>
    commands?: Array<{
      id: string
      title: { zh: string; en?: string }
      hint?: string
      group?: string
    }>
  }
  origin: 'builtin' | 'user'
  enabled: boolean
  /** 插件包目录的绝对路径（渲染进程按 docvi://plugin 协议取资源） */
  dir: string
  error: string | null
  /** 该包内被单独停用的组件 kind（清单仍完整，面板据此渲染开关状态） */
  disabledComponents: string[]
}

/**
 * 本地服务状态。
 *
 * 服务是独立进程：渲染层只读状态与端点，不持有 token 之外的任何东西。
 * `endpoint` 已包含端口与 `/mcp` 路径，UI 直接复制给 MCP 客户端。
 */
export interface ServiceState {
  running: boolean
  /** 实际监听端口（被占用时会在首选端口附近顺延） */
  port: number | null
  /** 监听地址：127.0.0.1（仅本机）或 0.0.0.0（局域网） */
  host: string | null
  lan: boolean
  /** MCP 端点完整 URL；未运行时为空串 */
  endpoint: string
  /** 访问令牌（MCP 客户端需带 Authorization: Bearer） */
  token: string
  /** 最近一次启动失败 / 崩溃原因 */
  error: string | null
}

/** 外壳行为状态。autostart 读的是注册表实际值，不是设置文件里的愿望值。 */
export interface DesktopPrefsState {
  autostart: boolean
  /** 实际写入的启动命令行（仅 Windows，便于用户核对） */
  autostartCommand: string
  closeToTray: boolean
  /** 平台不支持（如非 Windows 的自启动）时的说明 */
  error: string | null
}

/** 临时分享记录。`url` 由服务进程按当前端口与局域网开关实时拼出。 */
export interface ShareEntry {
  id: string
  /** 被分享目标的绝对路径 */
  path: string
  kind: 'file' | 'dir'
  createdAt: number
  /** 访问链接；服务未运行时为相对路径 */
  url: string
}
