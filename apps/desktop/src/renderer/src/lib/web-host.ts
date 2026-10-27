import MiniSearch from 'minisearch'

import type {
  AppInfo,
  AppSettings,
  DocPayload,
  DocviApi,
  HostSearchResult,
  MarketCatalog,
  PluginRecordView,
  RuntimeInfo,
  UpdateCheckResult,
  RecentEntry,
  Result,
  TreeNode,
  WorkspaceEntry,
} from '@docvi/shared'
import { LOCAL_PREVIEW_ID } from '@docvi/shared'

import { buildLocalTree, normalizeLocalPath, stripCommonRoot } from './local-preview'
import { normalizePortal, type PortalPayloadRaw } from './portal-workspaces'

/**
 * 浏览器宿主适配层：把部署器（deployer）的 HTTP 协议接成渲染层认识的
 * `window.docvi` 形状。
 *
 * 为什么要有这一层：渲染层只认 `window.docvi` 一个接口，Electron 由 preload
 * 提供、容器里没有 preload。没有适配层，容器只能继续用旧壳——两套 UI 长期
 * 分叉，改一处就得记着改两处。
 *
 * 三条边界：
 *  1. **只实现读者面**。容器里没有本地磁盘、没有 git 克隆、没有托盘，
 *     这些方法不提供（调用处按 `hostKind === 'web'` 隐藏入口），而不是返回
 *     一个假成功的空实现——静默成功比报错更难查。
 *  2. **不写任何本地状态**。设置与会话放 localStorage；文档是只读的，
 *     写操作一律返回 E_FORBIDDEN。
 *  3. **协议差异收在这里**。部署器的树是 `TreePayload.roots`（带富文本图标
 *     span），渲染层要 `TreeNode[]`（纯名字 + landing）；转换只在这一处做。
 */

const ok = <T>(data: T): Result<T> => ({ ok: true, data })

/** 统一的失败信封（与主进程 toFailure 同形） */
function deny(
  message: string,
  code: 'E_FORBIDDEN' | 'E_NOT_FOUND' | 'E_INVALID' = 'E_FORBIDDEN',
): {
  ok: false
  error: { code: typeof code; message: string }
} {
  return { ok: false, error: { code, message } }
}

/* ---------- 部署器协议形状 ---------- */

/* PortalPayloadRaw / normalizePortal 见 ./portal-workspaces.ts（纯函数，可单测） */

/** 部署器树：text 里带 `<span class="at-tree-title" title="…">名字</span>` */
interface ShellTreeNode {
  text: string
  link?: string
  items?: ShellTreeNode[]
}

interface ShellTreePayload {
  version: string
  title: string
  description?: string
  configSource: string
  roots: ShellTreeNode[]
}

interface ShellPluginPayload {
  plugins: Array<{
    name: string
    displayName: { zh: string; en?: string }
    version: string
    apiVersion: string
    enabled: boolean
    baseUrl: string
    entry?: string
    styles?: string[]
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
    // 容器端的 manifest 用 components/themes 直接挂在顶层（不是 contributes）
    contributes?: unknown
  }>
}

/* ---------- 小工具 ---------- */

/** 从部署器的富文本 text 里取出纯名字 */
function plainName(text: string): string {
  const match = /data-title="([^"]*)"/.exec(text) ?? /title="([^"]*)"/.exec(text)
  if (match?.[1]) return match[1]
  // 没有 span 包裹时退化成剥标签
  return text.replace(/<[^>]*>/g, '').trim()
}

/**
 * 富文本树 → 渲染层的 TreeNode。
 *
 * `link` 是 `/component-showcase/chapters/01-…`，要去掉开头的 `/` 才是
 * 「工作区相对路径」——渲染层的 `docRead(workspaceId, path)` 按相对路径取。
 *
 * 没有 `link` 的目录是**纯分组**（自身没有 index.md）。它也必须有一个稳定的
 * path：渲染层用 path 作展开状态的键，全给空串会让所有分组目录一起展开/折叠。
 * 这里按「父路径 + 名字」合成一个——它不用于读文档（没有 landing），只作标识。
 */
function toTreeNode(node: ShellTreeNode, parentPath = ''): TreeNode {
  const name = plainName(node.text)
  const linkPath = (node.link ?? '').replace(/^\//, '')
  const path = linkPath || (parentPath ? `${parentPath}/${name}` : name)
  const children = node.items?.map(child => toTreeNode(child, path))
  if (children?.length) {
    return {
      path,
      name,
      type: 'dir',
      // 目录本身有落地页时渲染层会用文档图标并可点击进入
      ...(linkPath ? { landing: linkPath } : {}),
      children,
    }
  }
  return { path, name, type: 'doc' }
}

/** 本地文件的显示标题：docvi 与站点口径一致——优先 h1，其次文件名 */
function localTitle(path: string, text: string): string {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
  if (heading) return heading
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? path
}

/** 搜索结果的摘要行：跳过空行与标题行，取第一句正文 */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---') continue
    return trimmed.slice(0, 120)
  }
  return ''
}

/* ---------- 主体 ---------- */

/** 插件 name → version：资源 URL 要带版本段 */
const pluginVersion = new Map<string, string>()

/* ---------- 宿主侧搜索 ---------- */

/** 部署器生成的 minisearch 索引载荷（只声明用到的字段） */
interface ShellSearchIndex {
  version: string
  index: unknown
  docs: Array<{ path: string; title: string; summary: string }>
}

/**
 * 与索引生成侧（scripts/lib/docs-core.mjs）同一套分词：英文/数字词 + CJK 单字。
 *
 * 分词器是索引的一部分而不是查询时的自由选择：分词不一致会让中文查询
 * 命中为零（索引按字切，查询按词切），这类 bug 在中文内容上几乎必然出现。
 */
function tokenize(text: string): string[] {
  return Array.from(text.toLowerCase().matchAll(/[a-z0-9]+|[\u4e00-\u9fff]/g)).map(m => m[0])
}

const miniOptions = {
  idField: 'path',
  fields: ['title', 'content'],
  storeFields: ['title', 'summary'],
  tokenize,
  searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 4 } },
}

export interface WebHostOptions {
  /** 当前分支选择（`?branch=`），缺省用仓库默认分支 */
  branchOf?: (slug: string) => string | null
}

/** 最近打开上限（与桌面端 store.ts 的 MAX_RECENT 一致） */
const MAX_RECENT = 12

/**
 * 建一个浏览器版 `window.docvi`。
 *
 * 只实现读者面 + 设置持久化；写操作与桌面专属能力明确返回 E_FORBIDDEN，
 * 调用处（按 hostKind 隐藏）不该走到这里——真走到了也有明确的错误，不静默。
 */
export function createWebHost(options: WebHostOptions = {}): DocviApi {
  /** 工作区（仓库）清单缓存：树请求要按 slug 拼 URL */
  let cache: WorkspaceEntry[] | null = null

  /**
   * 本地预览装载的内存工作区（`/__local/…`）。
   *
   * 单例而不是列表：这是「看一眼刚生成的文件」的临时载体，不是第二个仓库库。
   * 每次装载整体替换，旧内容立即释放——否则反复拖入大目录会把内存留在标签页里。
   *
   * 索引也在装载时一次建好：本地预览的文档不在服务端索引里，不建的话搜索面板
   * 搜不到刚拖进来的东西，用户会以为「装载失败」。
   */
  let local: {
    entry: WorkspaceEntry
    files: Map<string, string>
    tree: TreeNode[]
    index: MiniSearch
  } | null = null

  const settingsKey = 'docvi.web.settings'
  const sessionKey = 'docvi.web.session'
  const recentKey = 'docvi.web.recent'

  function readRecent(): RecentEntry[] {
    try {
      const raw = localStorage.getItem(recentKey)
      if (!raw) return []
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is RecentEntry =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as RecentEntry).path === 'string' &&
          typeof (item as RecentEntry).title === 'string',
      )
    } catch {
      return []
    }
  }

  function writeRecent(list: RecentEntry[]): void {
    try {
      localStorage.setItem(recentKey, JSON.stringify(list))
    } catch {
      // 隐私模式写不进去：最近打开退化为本次会话内有效
    }
  }

  function readSettings(): AppSettings {
    const base: AppSettings = {
      schemaVersion: 1,
      theme: 'slate',
      locale: 'zh',
      tabs: {
        maxTabs: 0,
        overflow: 'least-recent',
        layout: 'single',
        overflowX: 'scroll',
        maxWidth: 200,
      },
      contentWidth: 'full',
      sidebarCollapsed: false,
      editorWrap: 'wrap',
      desktop: { autostart: false, closeToTray: false },
    }
    try {
      const raw = localStorage.getItem(settingsKey)
      if (!raw) return base
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      return { ...base, ...parsed, tabs: { ...base.tabs, ...(parsed.tabs ?? {}) } }
    } catch {
      return base
    }
  }

  async function repoList(): Promise<WorkspaceEntry[]> {
    if (!cache) {
      const res = await fetch('/api/portal')
      if (!res.ok) throw new Error(`仓库清单加载失败（${res.status}）`)
      cache = normalizePortal((await res.json()) as PortalPayloadRaw)
    }
    // 本地预览排在首位：它是用户刚拖进来的东西，一进库就该看见
    return local ? [local.entry, ...cache] : cache
  }

  /**
   * 搜索索引：每仓一份（部署器按 `?repo=` 生成），首次查询时懒加载。
   *
   * 为什么不逐篇拉原文自己建：容器里的文档本来就在服务端，索引是构建时算好的，
   * 浏览器再跑一遍既慢又白费带宽。索引与树上一次查询都可能命中多个仓，因此
   * 这里按 slug 缓存 loader 的 Promise，失败后允许重试（置回 null）。
   */
  const searchIndexes = new Map<string, Promise<MiniSearch | null>>()

  function loadSearchIndex(slug: string): Promise<MiniSearch | null> {
    const cached = searchIndexes.get(slug)
    if (cached) return cached
    const task = (async () => {
      const branch = options.branchOf?.(slug)
      const res = await fetch(
        `/api/search-index?repo=${encodeURIComponent(slug)}${
          branch ? `&branch=${encodeURIComponent(branch)}` : ''
        }`,
      )
      // 索引缺失（构建中 / 旧版本平台）：该仓本轮不参与搜索，不当作错误
      if (!res.ok) return null
      const payload = (await res.json()) as ShellSearchIndex
      try {
        return MiniSearch.loadJSON(JSON.stringify(payload.index), miniOptions as never)
      } catch {
        return null
      }
    })()
    searchIndexes.set(slug, task)
    return task
  }

  const host: DocviApi = {
    bootSettings: readSettings(),
    hostKind: 'web',

    /* ---------- 应用 ---------- */

    async appInfo(): Promise<Result<AppInfo>> {
      return ok({ name: 'docvi', version: __DOCVI_VERSION__, platform: 'web', dataDir: '' })
    },

    /** 容器版的运行时信息：没有 Electron，浏览器信息在 UA 里但不必解析 */
    async appRuntimeInfo(): Promise<Result<RuntimeInfo>> {
      return ok({
        version: __DOCVI_VERSION__,
        electron: null,
        chrome: null,
        node: null,
        platform: 'web',
        arch: 'unknown',
        dataDir: '',
        packaged: true,
      })
    },

    /** 容器版的更新由部署方重建镜像完成，客户端不自更新 */
    async appUpdateCheck(): Promise<Result<UpdateCheckResult>> {
      return ok({
        status: 'unavailable',
        current: __DOCVI_VERSION__,
        checkedAt: Date.now(),
        message: '容器版由部署方升级，客户端不做自更新',
      })
    },

    /*
     * 更新下载 / 安装：容器版没有这套流程，一律 deny。
     *
     * 不给「静默成功」的空实现：那会让关于页显示「已下载」，而磁盘上什么都没有。
     * 宿主能力缺失就要明确失败，UI 才能据此只显示「联系运维升级」。
     */
    async appUpdateDownload() {
      return deny('容器版不支持应用内更新')
    },
    async appUpdateCancel(): Promise<Result<null>> {
      return ok(null)
    },
    async appUpdateInstall() {
      return deny('容器版不支持应用内更新')
    },
    onUpdateProgress(): () => void {
      return () => undefined
    },

    /**
     * 容器版外链：新标签打开，并立刻切断 opener。
     *
     * 与桌面同理，不能在当前页导航——那会把 SPA 整页换掉；只是这里用浏览器
     * 自己的新标签，而不是系统浏览器。切断 opener 防止目标页反向操纵本站。
     */
    async appOpenExternal(url: string): Promise<Result<null>> {
      const target = url.trim()
      if (!/^(https?:\/\/|mailto:)/i.test(target)) {
        return deny('只允许打开 http/https/mailto 链接', 'E_INVALID')
      }
      window.open(target, '_blank', 'noopener,noreferrer')
      return ok(null)
    },

    /* ---------- 插件 ---------- */

    /**
     * 插件资源 URL：容器里是 `/plugins/<name>/<version>/<path>`。
     *
     * 版本段必须带上——部署器的插件文件路由是 `/plugins/<name>/<version>/…`，
     * 不带版本会 404。版本从最近一次 pluginList 的结果里查。
     */
    pluginAssetUrl(plugin: string, relPath: string): string {
      const record = pluginVersion.get(plugin)
      const version = record ?? '0.1.0'
      return `/plugins/${encodeURIComponent(plugin)}/${encodeURIComponent(version)}/${relPath}`
    },

    async pluginList(): Promise<Result<PluginRecordView[]>> {
      try {
        const res = await fetch('/api/plugins')
        if (!res.ok) return deny(`插件清单加载失败（${res.status}）`, 'E_INVALID')
        const payload = (await res.json()) as ShellPluginPayload
        const records: PluginRecordView[] = payload.plugins.map(item => {
          pluginVersion.set(item.name, item.version)
          return {
            name: item.name,
            displayName: item.displayName,
            version: item.version,
            apiVersion: item.apiVersion,
            trust: 'presentation',
            enabled: item.enabled,
            // 容器里没有「本地安装」的概念：平台预置包与运维安装的包对读者一视同仁。
            // 面板按 origin 分组，统一记成 builtin 才不会被归到「已安装」那一栏。
            origin: 'builtin',
            // 容器里没有磁盘目录：资源位置由 pluginAssetUrl 统一拼，这个字段不参与
            dir: '',
            error: null,
            // 部署器把贡献点摊在顶层（不是 contributes 段）
            contributes: {
              components: item.components ?? [],
              themes: item.themes ?? [],
              markdownSyntax: item.markdownSyntax ?? [],
            },
            disabledComponents: [],
          }
        })
        return ok(records)
      } catch (error) {
        return deny(`插件清单加载失败：${(error as Error).message}`, 'E_INVALID')
      }
    },

    /* ---------- 工作区（= 仓库） ---------- */

    async workspaceList(): Promise<Result<WorkspaceEntry[]>> {
      try {
        return ok(await repoList())
      } catch (error) {
        return deny((error as Error).message, 'E_INVALID')
      }
    },
    async workspaceTouch(): Promise<Result<null>> {
      return ok(null)
    },

    /* ---------- 内容 ---------- */

    async treeList(workspaceId: string): Promise<Result<TreeNode[]>> {
      if (workspaceId === LOCAL_PREVIEW_ID) {
        if (!local) return deny('本地预览已失效，请重新选择文件', 'E_NOT_FOUND')
        return ok(local.tree)
      }
      try {
        const res = await fetch(
          `/api/tree?repo=${encodeURIComponent(workspaceId)}${
            options.branchOf?.(workspaceId)
              ? `&branch=${encodeURIComponent(options.branchOf(workspaceId) as string)}`
              : ''
          }`,
        )
        if (!res.ok) return deny(`目录树加载失败（${res.status}）`, 'E_INVALID')
        const payload = (await res.json()) as ShellTreePayload
        return ok(payload.roots.map(node => toTreeNode(node)))
      } catch (error) {
        return deny(`目录树加载失败：${(error as Error).message}`, 'E_INVALID')
      }
    },

    async docRead(workspaceId: string, path: string): Promise<Result<DocPayload>> {
      if (workspaceId === LOCAL_PREVIEW_ID) {
        if (!local) return deny('本地预览已失效，请重新选择文件', 'E_NOT_FOUND')
        const clean = normalizeLocalPath(path)
        const text = local.files.get(clean)
        if (text === undefined) return deny(`文档不存在：${path}`, 'E_NOT_FOUND')
        const name = clean.split('/').pop() ?? clean
        return ok({
          path: clean,
          absolutePath: `/${LOCAL_PREVIEW_ID}/${clean}`,
          title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name.replace(/\.md$/i, ''),
          text,
          mtime: 0,
          size: text.length,
        })
      }
      try {
        const clean = path.replace(/^\//, '')
        const url = `/docs/${encodeURIComponent(workspaceId)}/${clean}.md${
          options.branchOf?.(workspaceId)
            ? `?branch=${encodeURIComponent(options.branchOf(workspaceId) as string)}`
            : ''
        }`
        const res = await fetch(encodeURI(url))
        if (res.status === 404) return deny(`文档不存在：${path}`, 'E_NOT_FOUND')
        if (!res.ok) return deny(`文档读取失败（${res.status}）`, 'E_INVALID')
        const text = await res.text()
        const name = clean.split('/').pop() ?? clean
        return ok({
          path: clean,
          /*
           * 容器里没有本地绝对路径，但要一个**能与工作区根对齐**的稳定 key：
           * 最近打开的条目会拿它来反查所属工作区（resolveToWorkspace 比较
           * 「是否以 workspace.root 开头」），所以这里用站点路径而不是
           * `web:<slug>/…` 这类自造前缀——后者永远匹配不上，最近打开点了没反应。
           */
          absolutePath: `/${workspaceId}/${clean}`,
          title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? name.replace(/\.md$/i, ''),
          text,
          mtime: 0,
          size: text.length,
        })
      } catch (error) {
        return deny(`文档读取失败：${(error as Error).message}`, 'E_INVALID')
      }
    },

    /* ---------- 设置 / 会话（localStorage） ---------- */

    async settingsRead(): Promise<Result<AppSettings>> {
      return ok(readSettings())
    },
    async settingsWrite(patch): Promise<Result<AppSettings>> {
      const next = { ...readSettings(), ...patch } as AppSettings
      try {
        localStorage.setItem(settingsKey, JSON.stringify(next))
      } catch {
        // 隐私模式写不进去：设置降级为仅本次会话有效，不报错打断使用
      }
      return ok(next)
    },
    async sessionRead(): Promise<Result<unknown>> {
      try {
        const raw = localStorage.getItem(sessionKey)
        return ok(raw ? JSON.parse(raw) : null)
      } catch {
        return ok(null)
      }
    },
    async sessionWrite(session: unknown): Promise<Result<null>> {
      try {
        localStorage.setItem(sessionKey, JSON.stringify(session))
      } catch {
        // 同上
      }
      return ok(null)
    },

    /** 浏览器里没有窗口按钮需要同步 */
    async setWindowAppearance(): Promise<Result<null>> {
      return ok(null)
    },
    onSettingsChanged(): () => void {
      // 容器里没有第二个进程改设置文件，永远不会有外部变更
      return () => undefined
    },

    /* ---------- 读者面之外：明确不可用 ---------- */

    async appPendingPaths(): Promise<Result<string[]>> {
      return ok([])
    },
    onOpenPath(): () => void {
      return () => undefined
    },
    pathsForFiles(): string[] {
      return []
    },

    async workspaceAdd() {
      return deny('容器版不支持添加本地目录')
    },
    async workspacePick() {
      return deny('容器版不支持选择本地目录')
    },
    async workspaceAddAt() {
      return deny('容器版不支持添加本地目录')
    },
    async workspaceProbe() {
      return deny('容器版不支持探测本地目录')
    },
    async workspaceRemove() {
      return deny('容器版不支持移除仓库')
    },

    async gitState() {
      return deny('容器版无 git 客户端能力')
    },
    async gitClone() {
      return deny('容器版不支持克隆仓库')
    },
    async gitPull() {
      return deny('容器版不支持拉取')
    },
    async gitBranches() {
      return deny('容器版不支持切换分支')
    },
    async gitSwitchBranch() {
      return deny('容器版不支持切换分支')
    },
    onGitProgress(): () => void {
      return () => undefined
    },

    async fsCreate() {
      return deny('容器版文档是只读的')
    },
    async fsRename() {
      return deny('容器版文档是只读的')
    },
    async fsMove() {
      return deny('容器版文档是只读的')
    },
    async fsCopy() {
      return deny('容器版文档是只读的')
    },
    async fsTrash() {
      return deny('容器版文档是只读的')
    },

    /*
     * 图片入库是写操作，容器读者面没有磁盘。契约上必须存在（渲染层只按
     * hostKind 决定入口显隐，不做方法存在性探测），所以实现为明确拒绝。
     */
    async imageImport() {
      return deny('容器版文档是只读的')
    },
    async imagePick() {
      return deny('容器版文档是只读的')
    },

    async filePick() {
      return deny('容器版不支持打开本地文件')
    },
    async fileRead() {
      return deny('容器版不支持打开本地文件')
    },

    /**
     * 装载本地 Markdown 预览（容器读者面）。
     *
     * 传空数组 = 卸载。内容只在内存：不写服务器、不进任何仓库，刷新即失效。
     * 目录模式剥掉共同根目录名（浏览器的 `webkitRelativePath` 第一段就是用户
     * 选中的文件夹名），否则树里会多套一层同名的根。
     */
    async localPreview(files, kind) {
      if (!files.length) {
        local = null
        return ok(null)
      }
      const usable = files
        .filter(file => typeof file.path === 'string' && typeof file.text === 'string')
        .map(file => ({ path: normalizeLocalPath(file.path), text: file.text }))
        .filter(file => file.path.length > 0)
      if (!usable.length) return ok(null)

      const stripped = kind === 'dir' ? stripCommonRoot(usable) : { rootName: null, files: usable }
      // 同一路径出现多次（大小写差异 / 重复选择）：后者覆盖前者，与文件系统语义一致
      const map = new Map<string, string>()
      for (const file of stripped.files) map.set(file.path, file.text)
      const entries = [...map].map(([path, text]) => ({ path, text }))
      const tree = buildLocalTree(entries)

      const index = new MiniSearch(miniOptions as never)
      index.addAll(
        entries.map(file => ({
          path: file.path,
          title: localTitle(file.path, file.text),
          content: file.text,
          summary: firstLine(file.text),
        })),
      )

      local = {
        entry: {
          id: LOCAL_PREVIEW_ID,
          name: stripped.rootName ?? '本地预览',
          root: '/__local/',
          addedAt: Date.now(),
          lastOpenedAt: Date.now(),
        },
        files: map,
        tree,
        index,
      }
      return ok(local.entry)
    },

    /**
     * 搜索语料：容器端没有「整库原文」端点（服务端只提供 minisearch 索引，
     * 形状不同）。这里逐篇拉原文会打满请求，所以直接返回空 —— 搜索面板
     * 走下面的 searchQuery（服务端索引），不会再走这条路。
     */
    async searchCorpus(): Promise<Result<never[]>> {
      return ok([])
    },

    /**
     * 服务端索引查询：每仓一份 minisearch 索引，并行查完按分数合并。
     *
     * 为什么并行查而不是先合并成一份：每仓索引是独立构建的（各自的内容指纹），
     * 合并需要重算 id 与分数基准；读者面每个平台通常只有几仓，并行开销可忽略。
     * 分数跨仓不可比，但这里只需要「本仓命中靠前」的局部排序——面板本来就按
     * 工作区分组展示，跨仓的绝对分数没有意义。
     */
    async searchQuery(query: string): Promise<Result<HostSearchResult>> {
      const text = query.trim()
      if (!text) return ok({ total: 0, hits: [] })
      try {
        const workspaces = await repoList()
        const engines = await Promise.all(
          // 本地预览没有服务端索引（下面单独查内存索引），跳过它避免一次必然 404 的请求
          workspaces
            .filter(entry => entry.id !== LOCAL_PREVIEW_ID)
            .map(async entry => ({
              entry,
              engine: await loadSearchIndex(entry.id).catch(() => null),
            })),
        )
        const hits: HostSearchResult['hits'] = []
        let total = 0
        for (const { entry, engine } of engines) {
          if (!engine) continue
          total += engine.documentCount
          // 每仓取前 20：面板最多展示 20 条，逐仓取满再多也是浪费
          for (const result of engine.search(text).slice(0, 20)) {
            const fields = engine.getStoredFields(result.id) as
              { title?: string; summary?: string } | undefined
            hits.push({
              workspaceId: entry.id,
              path: String(result.id).replace(/^\//, ''),
              title: fields?.title ?? String(result.id),
              score: result.score,
              snippet: fields?.summary ?? '',
            })
          }
        }
        hits.sort((a, b) => b.score - a.score)
        // 本地预览的文档不在服务端索引里，单独查一次内存索引
        if (local) {
          for (const result of local.index.search(text).slice(0, 20)) {
            const fields = local.index.getStoredFields(result.id) as
              { title?: string; summary?: string } | undefined
            hits.push({
              workspaceId: LOCAL_PREVIEW_ID,
              path: String(result.id),
              title: fields?.title ?? String(result.id),
              score: result.score,
              snippet: fields?.summary ?? '',
            })
          }
          hits.sort((a, b) => b.score - a.score)
        }
        return ok({ total, hits: hits.slice(0, 60) })
      } catch (error) {
        return deny(`搜索失败：${(error as Error).message}`, 'E_INVALID')
      }
    },

    /**
     * 最近打开：容器里没有磁盘注册表，按浏览器本地（localStorage）记一份。
     *
     * 上限与桌面端一致（12 条）：最近打开是「刚才去哪了」的短期记忆，
     * 不是书签，无限增长只会让库里那一节越来越长。
     */
    async recentList() {
      return ok(readRecent())
    },
    async recentTouch(entry) {
      const next: RecentEntry[] = [
        { ...entry, openedAt: Date.now() },
        ...readRecent().filter(item => item.path !== entry.path),
      ].slice(0, MAX_RECENT)
      writeRecent(next)
      return ok(next)
    },
    async recentClear() {
      writeRecent([])
      return ok([])
    },

    async docWrite() {
      return deny('容器版文档是只读的')
    },
    async docExport() {
      return deny('容器版不支持导出到本地')
    },
    async draftRead(): Promise<Result<null>> {
      return ok(null)
    },
    async draftWrite(): Promise<Result<null>> {
      return ok(null)
    },
    async draftClear(): Promise<Result<null>> {
      return ok(null)
    },
    onExternalChange(): () => void {
      return () => undefined
    },
    async docWatch(): Promise<Result<null>> {
      return ok(null)
    },
    async docUnwatch(): Promise<Result<null>> {
      return ok(null)
    },

    /*
     * 容器版的目录结构由服务端仓库决定，读者面没有本地文件系统可监视。
     * 订阅返回空函数（没有事件可发），watch/unwatch 是空操作——不是 deny：
     * 渲染层无差别调用时不该因此报错。
     */
    onWorkspaceFilesChanged(): () => void {
      return () => undefined
    },
    async workspaceWatch(): Promise<Result<null>> {
      return ok(null)
    },
    async workspaceUnwatch(): Promise<Result<null>> {
      return ok(null)
    },

    async pluginInstall() {
      return deny('容器版不支持安装插件')
    },
    /**
     * 容器版市场清单：读者面没有安装权限，因此返回空目录；安装属于运维面
     * （`/_/admin`，token 后），与读者面分开——不在浏览器里给读者一个点了
     * 必然失败的「安装」按钮。
     */
    async pluginMarket(): Promise<Result<MarketCatalog>> {
      return ok({ schemaVersion: 1, plugins: [], fetchedAt: 0, sourceUrl: '' })
    },
    async pluginUninstall() {
      return deny('容器版不支持卸载插件')
    },
    async pluginSetEnabled() {
      return deny('容器版不支持启停插件')
    },
    async pluginSetComponentEnabled() {
      return deny('容器版不支持启停组件')
    },

    async serviceState() {
      return deny('容器版无本地服务进程')
    },
    async serviceRestart() {
      return deny('容器版无本地服务进程')
    },
    async serviceSetLan() {
      return deny('容器版无本地服务进程')
    },
    async serviceSetPort() {
      return deny('容器版无本地服务进程')
    },
    async serviceOpenLog() {
      return deny('容器版无本地服务进程')
    },
    onServiceChanged(): () => void {
      return () => undefined
    },

    async desktopPrefs() {
      return deny('容器版无桌面外壳')
    },
    async desktopSetAutostart() {
      return deny('容器版无桌面外壳')
    },
    async desktopSetCloseToTray() {
      return deny('容器版无桌面外壳')
    },

    async shareList() {
      return ok([])
    },
    async shareCreate() {
      return deny('容器版不提供临时分享入口')
    },
    async shareCreatePath() {
      return deny('容器版不提供临时分享入口')
    },
    async shareRemove() {
      return ok([])
    },
    async shareOpen() {
      return deny('容器版不提供临时分享入口')
    },
  }

  return host
}
