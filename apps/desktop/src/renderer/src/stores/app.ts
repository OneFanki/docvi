import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

import type {
  AppSettings,
  ContentWidth,
  EditorWrap,
  DocPayload,
  GitState,
  RecentEntry,
  TreeNode,
  WorkspaceEntry,
  WorkspaceProbeResult,
} from '@docvi/shared'

/**
 * 主题状态：三个维度独立选择。
 *
 * 为什么分成三个而不是一个：UI（窗口 chrome）、文档（正文渲染）、编辑器（编辑区）
 * 是三个不同的对象，各自可以独立切换。典型场景——白天用浅色 UI + 深色文档
 * （夜间护眼阅读），或深色 UI + 浅色文档（截屏/投影时正文更清楚）。
 *
 * 三者共用的只有「外观档位」这个概念（graphite 深 / paper 浅），
 * 各自有独立的变量命名空间，互不覆盖。
 */

/**
 * 主题键：内置两档 + 插件主题（`plugin-<插件>-<主题 id>`）。
 *
 * 用 string 而不是 union：插件主题是运行时才知道的，union 会把它挡在类型层外面。
 */
export type ThemeKey = string

const BUILTIN_KEYS = new Set(['graphite', 'paper', 'slate', 'mist'])

/**
 * 内置主题的明暗。插件主题的明暗从插件清单读（见 lib/plugin-themes），
 * 两者合起来决定窗口按钮用深色还是浅色符号。
 *
 * 为什么主进程不自己判断：主题 id 对第三方主题是任意字符串，猜不得。
 */
export const BUILTIN_APPEARANCE: Record<string, 'light' | 'dark'> = {
  graphite: 'dark',
  paper: 'light',
  slate: 'dark',
  mist: 'light',
}

/** 旧版 localStorage 键：只作为一次性迁移来源读取 */
const LEGACY_KEYS = {
  ui: 'docvi.ui.theme',
  doc: 'docvi.doc.theme',
  editor: 'docvi.editor.theme',
} as const

function readLegacy(key: string): ThemeKey | null {
  try {
    const value = localStorage.getItem(key)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

/**
 * 设置补丁的写队列。
 *
 * 连点主题按钮会在一帧内产生多次写入：串行化后每次都在上一次结果上合并，
 * 避免「后发的覆盖先发的」导致磁盘值与界面不一致。
 */
let writeChain: Promise<unknown> = Promise.resolve()
function patchSettings(patch: Parameters<typeof window.docvi.settingsWrite>[0]): void {
  writeChain = writeChain.then(() => window.docvi.settingsWrite(patch)).catch(() => undefined)
}

export const useThemeStore = defineStore('theme', () => {
  // 首帧用 preload 同步取到的快照：与磁盘一致，不会闪默认主题
  const boot = window.docvi.bootSettings
  /** 当前主题 id：一个主题 = 一整套变量（界面 + 正文 + 编辑器 + 组件） */
  const theme = ref<ThemeKey>(boot.theme)
  /** 正文 / 编辑区宽度：铺满画布，或限制在可读行宽 */
  const contentWidth = ref<ContentWidth>(boot.contentWidth)
  /** 侧栏折叠：状态在 settings.json，首帧即按偏好渲染，不闪一下再收 */
  const sidebarCollapsed = ref(boot.sidebarCollapsed)
  /** 源码模式折行（默认折行；关掉 = 横向滚动） */
  const editorWrap = ref<EditorWrap>(boot.editorWrap)

  /** 正在应用外部设置：此时 watch 触发的写回要跳过（否则回写覆盖外部修改） */
  let applyingExternal = false

  watch(theme, value => {
    document.documentElement.dataset.theme = value
    void applyAppearance()
    if (!applyingExternal) patchSettings({ theme: value })
  })
  watch(contentWidth, value => {
    // 挂到根节点：阅读列与编辑区都读这一个属性，切模式不会一宽一窄
    document.documentElement.dataset.contentWidth = value
    if (!applyingExternal) patchSettings({ contentWidth: value })
  })
  watch(sidebarCollapsed, value => {
    document.documentElement.dataset.sidebar = value ? 'collapsed' : 'expanded'
    if (!applyingExternal) patchSettings({ sidebarCollapsed: value })
  })
  watch(editorWrap, value => {
    if (!applyingExternal) patchSettings({ editorWrap: value })
  })

  function setTheme(value: ThemeKey): void {
    theme.value = value
  }

  /** 插件被停用/卸载后，把指向它的选择回退到内置档位 */
  function dropPluginThemes(isGone: (key: ThemeKey) => boolean): void {
    if (!BUILTIN_KEYS.has(theme.value) && isGone(theme.value)) theme.value = 'slate'
  }

  /** 启动时把已存值写进 DOM，避免首帧闪烁 */
  function applyToDom(): void {
    document.documentElement.dataset.contentWidth = contentWidth.value
    document.documentElement.dataset.sidebar = sidebarCollapsed.value ? 'collapsed' : 'expanded'
    document.documentElement.dataset.theme = theme.value
    // 首帧就把明暗写进 DOM 并推给主进程：否则浅色主题启动会闪一帧深色外观
    void applyAppearance()
  }

  /**
   * 解析当前主题的明暗，写进 `data-appearance`，再推给主进程。
   *
   * `data-appearance` 是**插件主题的继承基底**：插件只声明局部变量时，其余部分
   * 按明暗从对应内置主题继承（见 theme.css 第 1 节）。所以这一步必须跟着主题走，
   * 不能只在设置里存着。
   *
   * 主进程只认明暗（Windows 的 titleBarOverlay 是原生绘制，不读页面 CSS），
   * 它按主题 id 猜不出插件主题的深浅，只能由这里推解析后的结果。查不到时按深色
   * 处理——内置默认档位是深色，插件缺 appearance 时也偏向深色，避免白底黑字按钮。
   */
  async function applyAppearance(): Promise<void> {
    const { pluginThemes } = await import('../lib/plugin-themes')
    const loaded = pluginThemes.themes.value.find(item => item.id === theme.value)
    const appearance = loaded?.appearance ?? BUILTIN_APPEARANCE[theme.value] ?? 'dark'
    document.documentElement.dataset.appearance = appearance
    await window.docvi.setWindowAppearance(appearance)
  }

  /** 应用一份外部设置（settings.json 被 AI/用户改了，或启动时校准） */
  function applySettings(next: AppSettings): void {
    applyingExternal = true
    contentWidth.value = next.contentWidth
    sidebarCollapsed.value = next.sidebarCollapsed
    editorWrap.value = next.editorWrap
    theme.value = next.theme
    applyingExternal = false
  }

  /**
   * 一次性迁移旧 localStorage 主题到 settings.json。
   *
   * 旧版存了 ui / doc / editor 三个键。统一后只取 ui：它是最先被感知的一层；
   * 迁移完删旧键，下次启动就是空操作。
   */
  function migrateLegacy(): void {
    const legacy =
      readLegacy(LEGACY_KEYS.ui) ?? readLegacy(LEGACY_KEYS.doc) ?? readLegacy(LEGACY_KEYS.editor)
    if (!legacy) return
    if (legacy !== boot.theme) {
      patchSettings({ theme: legacy })
      applySettings({ ...boot, theme: legacy })
    }
    try {
      for (const key of Object.values(LEGACY_KEYS)) localStorage.removeItem(key)
    } catch {
      // 清不掉也无害：已迁移过，下次启动不会再读
    }
  }

  return {
    theme,
    contentWidth,
    sidebarCollapsed,
    editorWrap,
    setTheme,
    dropPluginThemes,
    applyToDom,
    applySettings,
    migrateLegacy,
  }
})

/**
 * 应用主状态：工作区 / 目录树 / 当前文档内容 / 最近打开。
 *
 * 标签的「有哪些、哪个激活」属于 tabs store；这里只管「打开某个内容要拿到
 * 什么数据」。两者分开的原因是：窗口重开后标签能立刻画出来（纯内存状态），
 * 内容再异步补齐。
 */
export const useAppStore = defineStore('app', () => {
  const workspaces = ref<WorkspaceEntry[]>([])
  const activeWorkspaceId = ref<string | null>(null)
  const tree = ref<TreeNode[]>([])
  /**
   * 当前 `tree` 属于哪个工作区。
   *
   * 为什么需要它：树是**按工作区**的数据，而 activeWorkspaceId 只表示「最近
   * 打开过谁」。启动时我们不再预扫树（省一次目录遍历），于是「activeWorkspaceId
   * 已经是 A」与「A 的树已加载」是两件事——只看前者会让首个工作区打开后树是空的。
   */
  const treeWorkspaceId = ref<string | null>(null)
  const currentDoc = ref<DocPayload | null>(null)
  const recent = ref<RecentEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const activeWorkspace = computed(
    () => workspaces.value.find(w => w.id === activeWorkspaceId.value) ?? null,
  )

  function setError(message: string | null): void {
    error.value = message
  }

  function unwrap<T>(
    result: { ok: true; data: T } | { ok: false; error: { message: string } },
  ): T | null {
    if (result.ok) return result.data
    error.value = result.error.message
    return null
  }

  async function loadWorkspaces(): Promise<void> {
    /*
     * 置 loading 再由 finally 收起：容器版的工作区清单要走一次 HTTP（/api/portal），
     * 这期间列表是空的。不标加载态的话首页会先闪一屏「还没有文档目录」——
     * 对着一堆已有仓库说没有，比什么都不显示更糟。
     */
    loading.value = true
    try {
      /*
       * 最近打开与仓库清单**并发**：两者互不依赖（一个读 localStorage / 磁盘、
       * 一个是 HTTP / 扫盘）。串行会让启动白等一个来回。
       */
      const [list] = await Promise.all([window.docvi.workspaceList(), loadRecent()])
      const entries = unwrap(list)
      if (!entries) return
      workspaces.value = entries
      if (!activeWorkspaceId.value && entries[0]) activeWorkspaceId.value = entries[0].id
      /*
       * 首屏不预扫目录树：文档库首页只显示仓库卡片。树在「打开工作区」时由
       * ensureTabReady 装载——启动时多扫一遍目录树是纯浪费，仓库大时还很明显。
       */
    } finally {
      loading.value = false
    }
  }

  async function loadRecent(): Promise<void> {
    const list = unwrap(await window.docvi.recentList())
    if (list) recent.value = list
  }

  /** 把一个已知路径加进工作区列表并激活（两个添加入口共用） */
  async function adoptWorkspace(entry: WorkspaceEntry): Promise<WorkspaceEntry> {
    workspaces.value = [entry, ...workspaces.value.filter(w => w.id !== entry.id)]
    activeWorkspaceId.value = entry.id
    currentDoc.value = null
    await loadTree(entry.id)
    return entry
  }

  async function addWorkspace(): Promise<WorkspaceEntry | null> {
    const entry = unwrap(await window.docvi.workspaceAdd())
    return entry ? adoptWorkspace(entry) : null
  }

  /** 只弹目录框、返回路径；添加前的探测流程从这里开始 */
  async function pickWorkspace(): Promise<string | null> {
    return unwrap(await window.docvi.workspacePick())
  }

  /** 按已知路径添加（探测后选定了候选内容根） */
  async function addWorkspaceAt(root: string): Promise<WorkspaceEntry | null> {
    const entry = unwrap(await window.docvi.workspaceAddAt(root))
    return entry ? adoptWorkspace(entry) : null
  }

  /** 探测目录：是否内容根 / 一层子目录里的候选 */
  async function probeWorkspace(root: string): Promise<WorkspaceProbeResult | null> {
    return unwrap(await window.docvi.workspaceProbe(root))
  }

  /* ---------- git 托管工作区 ---------- */

  /** git 能力面：只在进入文档库时探测一次（版本不会在运行中变） */
  const gitState = ref<GitState | null>(null)

  async function loadGitState(): Promise<GitState | null> {
    const state = unwrap(await window.docvi.gitState())
    if (state) gitState.value = state
    return state
  }

  /** 克隆远端仓库为托管工作区；进度事件由调用方订阅 */
  async function cloneRepo(input: {
    url: string
    name: string
    branch?: string
  }): Promise<WorkspaceEntry | null> {
    const entry = unwrap(await window.docvi.gitClone(input))
    return entry ? adoptWorkspace(entry) : null
  }

  async function listBranches(id: string): Promise<string[] | null> {
    return unwrap(await window.docvi.gitBranches(id))
  }

  /** 拉取更新（云端为准）；成功后重扫目录树，磁盘变了界面必须跟着变 */
  async function pullWorkspace(
    id: string,
  ): Promise<{ branch: string; commits: number; changed: boolean } | null> {
    const result = unwrap(await window.docvi.gitPull(id))
    if (!result) return null
    if (id === activeWorkspaceId.value) await loadTree(id)
    return result
  }

  /**
   * 切换分支。
   *
   * 切分支会换一棵工作树，工作区 id 随之变化（id 由路径派生）：这里按位置替换
   * 条目而不是重新排序，用户的卡片顺序不该因为切分支而跳动。
   */
  async function switchBranch(id: string, branch: string): Promise<WorkspaceEntry | null> {
    const entry = unwrap(await window.docvi.gitSwitchBranch(id, branch))
    if (!entry) return null
    const index = workspaces.value.findIndex(item => item.id === id)
    if (index >= 0) workspaces.value.splice(index, 1, entry)
    else workspaces.value = [entry, ...workspaces.value]
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = entry.id
      await loadTree(entry.id)
    }
    return entry
  }

  async function removeWorkspace(id: string): Promise<boolean> {
    const result = await window.docvi.workspaceRemove(id)
    if (!result.ok) {
      error.value = result.error.message
      return false
    }
    workspaces.value = workspaces.value.filter(w => w.id !== id)
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = workspaces.value[0]?.id ?? null
      tree.value = []
      currentDoc.value = null
      if (activeWorkspaceId.value) await loadTree(activeWorkspaceId.value)
    }
    return true
  }

  async function openWorkspace(id: string): Promise<void> {
    activeWorkspaceId.value = id
    await window.docvi.workspaceTouch(id)
    await loadTree(id)
  }

  async function loadTree(workspaceId: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const nodes = unwrap(await window.docvi.treeList(workspaceId))
      tree.value = nodes ?? []
      treeWorkspaceId.value = workspaceId
    } finally {
      loading.value = false
    }
  }

  /** 读工作区内文档（不改变当前文档状态，调用方决定挂到哪个标签） */
  async function readDoc(workspaceId: string, relPath: string): Promise<DocPayload | null> {
    loading.value = true
    try {
      return unwrap(await window.docvi.docRead(workspaceId, relPath))
    } finally {
      loading.value = false
    }
  }

  /** 读工作区外的单文件（拖放 / 命令行 / 关联） */
  async function readFile(absolutePath: string): Promise<DocPayload | null> {
    loading.value = true
    try {
      return unwrap(await window.docvi.fileRead(absolutePath))
    } finally {
      loading.value = false
    }
  }

  async function touchRecent(payload: Omit<RecentEntry, 'openedAt'>): Promise<void> {
    const list = unwrap(await window.docvi.recentTouch(payload))
    if (list) recent.value = list
  }

  async function clearRecent(): Promise<void> {
    const list = unwrap(await window.docvi.recentClear())
    if (list) recent.value = list
  }

  /* ---------- 工作区内文件操作 ---------- */

  /**
   * 每个操作成功后都重扫目录树。
   *
   * 不自己改内存里的树：真实结构（落地页、order 排序、空目录剔除）由
   * scanTree 决定，手工同步一份必然与磁盘漂移——而这里正是「以磁盘为准」的场景。
   */
  async function refreshAfterFsOp(workspaceId: string): Promise<void> {
    if (workspaceId === activeWorkspaceId.value) await loadTree(workspaceId)
  }

  async function createEntry(
    workspaceId: string,
    dirRelPath: string,
    name: string,
    kind: 'file' | 'dir',
  ): Promise<string | null> {
    const result = await window.docvi.fsCreate(workspaceId, dirRelPath, name, kind)
    if (!result.ok) {
      error.value = result.error.code === 'E_EXISTS' ? '这个名字已经被占用了' : result.error.message
      return null
    }
    await refreshAfterFsOp(workspaceId)
    return result.data.relPath
  }

  async function renameEntry(
    workspaceId: string,
    relPath: string,
    nextName: string,
  ): Promise<string | null> {
    const result = await window.docvi.fsRename(workspaceId, relPath, nextName)
    if (!result.ok) {
      error.value = result.error.code === 'E_EXISTS' ? '目标位置已有同名条目' : result.error.message
      return null
    }
    await refreshAfterFsOp(workspaceId)
    return result.data.relPath
  }

  async function moveEntry(
    workspaceId: string,
    relPath: string,
    targetDir: string,
  ): Promise<string | null> {
    const result = await window.docvi.fsMove(workspaceId, relPath, targetDir)
    if (!result.ok) {
      error.value = result.error.message
      return null
    }
    await refreshAfterFsOp(workspaceId)
    return result.data.relPath
  }

  async function copyEntry(
    workspaceId: string,
    relPath: string,
    targetDir: string,
  ): Promise<string | null> {
    const result = await window.docvi.fsCopy(workspaceId, relPath, targetDir)
    if (!result.ok) {
      error.value = result.error.message
      return null
    }
    await refreshAfterFsOp(workspaceId)
    return result.data.relPath
  }

  async function trashEntry(workspaceId: string, relPath: string): Promise<boolean> {
    const result = await window.docvi.fsTrash(workspaceId, relPath)
    if (!result.ok) {
      error.value = `删除失败：${result.error.message}`
      return false
    }
    await refreshAfterFsOp(workspaceId)
    return true
  }

  return {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    tree,
    treeWorkspaceId,
    currentDoc,
    recent,
    loading,
    error,
    loadWorkspaces,
    loadRecent,
    adoptWorkspace,
    addWorkspace,
    pickWorkspace,
    addWorkspaceAt,
    probeWorkspace,
    gitState,
    loadGitState,
    cloneRepo,
    listBranches,
    pullWorkspace,
    switchBranch,
    removeWorkspace,
    openWorkspace,
    loadTree,
    readDoc,
    readFile,
    touchRecent,
    clearRecent,
    createEntry,
    renameEntry,
    moveEntry,
    copyEntry,
    trashEntry,
    setError,
  }
})
