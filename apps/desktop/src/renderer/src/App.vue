<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AlertCircle, CheckCircle2, FilePlus2, FolderPlus, Link2, X } from 'lucide-vue-next'
import type { DocPayload, ExportFormat, PortalWorkspace, WorkspaceEntry } from '@docvi/shared'
import { ComponentRegistry, type OutlineEntry } from '@docvi/renderer-core'

import { useAppStore, useThemeStore } from './stores/app'
import { isRealScopeLabel, useTabsStore, type DocRef, type TabRecord } from './stores/tabs'
import { useDocumentStore } from './stores/documents'
import { useCommands } from './lib/commands'
import { buildExportHtml, countRichComponents, exportNotice, suggestedName } from './lib/export-doc'
import { searchIndex } from './lib/search'
import { pluginThemes } from './lib/plugin-themes'
import { useThemeOptions } from './lib/theme-options'
import { usePluginStore } from './stores/plugins'
import { useServiceStore } from './stores/service'
import { useI18n, applyExternalLocale, migrateLegacyLocale } from './lib/i18n'
import { isReadOnlyHost, isWebHost } from './lib/host'
import {
  createHandoff,
  forgetDocument,
  invalidateState,
  leaveView,
  peekAnchor,
  rememberState,
  stateOf,
  takeAnchor,
} from './lib/view-handoff'
import {
  onRouteChange,
  pushDocUrl,
  readBranch,
  readPreviewRoute,
  readRoute,
  replaceDocUrl,
  replaceLibraryUrl,
  setDefaultBranchLookup,
  switchBranch,
} from './lib/web-router'
import { BUILTIN_KINDS } from './plugins/builtin'
import TitleBar from './components/TitleBar.vue'
import TabBar from './components/TabBar.vue'
import TabSwitcher from './components/TabSwitcher.vue'
import DocTree, { type TreeFsAction } from './components/DocTree.vue'
import LibraryView from './components/LibraryView.vue'
import ReaderView from './components/ReaderView.vue'
import OutlinePanel from './components/OutlinePanel.vue'
import StatusBar from './components/StatusBar.vue'
import CommandPalette from './components/CommandPalette.vue'
import PluginsView from './components/PluginsView.vue'
import PreviewPage from './components/PreviewPage.vue'
import SettingsView from './components/SettingsView.vue'
import ShortcutsPanel from './components/ShortcutsPanel.vue'
import EditorView from './components/EditorView.vue'
import ConfirmDialog, { type ConfirmAction } from './components/ConfirmDialog.vue'
import PromptDialog from './components/PromptDialog.vue'
import ContentRootDialog from './components/ContentRootDialog.vue'
import CloneRepoDialog from './components/CloneRepoDialog.vue'
import BranchDialog from './components/BranchDialog.vue'
import BranchPicker from './components/BranchPicker.vue'
import GitBar from './components/GitBar.vue'
// 相对路径：别名把 @docvi/editor 精确映射到 src/index.ts，'@docvi/editor/editor.css' 会解析失败
import '../../../../../packages/editor/src/styles/editor.css'

type View = 'library' | 'reader' | 'plugins' | 'settings' | 'preview'

/**
 * 应用根。
 *
 * 标签模型（v2）在这里落地：**一个标签 = 一个工作现场**。
 *  - 文档库是钉住的首页标签，从它打开工作区 = 新建标签（点两次 = 两个标签）；
 *  - 标签内部的文档切换只替换内容与历史，不新增标签；
 *  - 每个标签有自己的文档历史（Alt+←/→）与目录树展开状态；
 *  - 文档正文按路径共享（documents store），多个标签看同一文件时内容一致。
 */
const store = useAppStore()
const theme = useThemeStore()
const tabs = useTabsStore()
const documents = useDocumentStore()
const plugins = usePluginStore()
const service = useServiceStore()
const { t, locale } = useI18n()
const { register } = useCommands()

/**
 * 组件示例预览（容器端整页路由 `/_/preview/<插件>/<组件>`）。
 *
 * 单独一个状态而不是走标签：它是运维面「预览」按钮的落地页，一个临时查看
 * 视图，不该进标签条、也不该被会话恢复。只在容器读者面存在——桌面端没有
 * 这条 URL，插件面板用的是卡片内就地预览。
 */
const previewRoute = ref<{ plugin: string; kind: string } | null>(null)

const view = computed<View>(() => {
  if (previewRoute.value) return 'preview'
  const kind = activeTab.value?.kind
  if (kind === 'library') return 'library'
  if (kind === 'settings') return 'settings'
  if (kind === 'plugins') return 'plugins'
  return 'reader'
})
const outline = ref<OutlineEntry[]>([])
const showOutline = ref(true)
/**
 * 目录树显隐：与大纲同级的面板开关，都在标题栏右上角。
 *
 * 状态落在 settings.json（`sidebarCollapsed`）而不是组件内 ref——折叠一次就该
 * 一直是折叠的，每次重启都要重新点一下是纯摩擦。
 */
const showTree = computed({
  get: () => !theme.sidebarCollapsed,
  set: (visible: boolean) => {
    theme.sidebarCollapsed = !visible
  },
})
const paletteOpen = ref(false)
const shortcutsOpen = ref(false)
const readerRef = ref<InstanceType<typeof ReaderView> | null>(null)
const editorRef = ref<InstanceType<typeof EditorView> | null>(null)
const statusBarRef = ref<InstanceType<typeof StatusBar> | null>(null)
const tabBarRef = ref<InstanceType<typeof TabBar> | null>(null)

/**
 * 阅读 / 实时预览 / 源码 / 分屏 四种模式。
 *
 * 模式是**视图状态**，不改变文档格式：任何模式写出的都是同一份 Markdown。
 * 切标签时回到阅读态——编辑器实例随标签切换销毁，但缓冲区留在文档模型里。
 *
 * 「分屏」= 左源码 + 右渲染，同步滚动。它不是第五种编辑语义，而是把
 * 「源码模式」和「阅读模式」并排放——左侧走 source 语义（绝不显示 Live
 * Preview 的装饰），右侧渲染的是同一份缓冲区。
 */
type DocMode = 'read' | 'live' | 'source' | 'split'
const docMode = ref<DocMode>('read')
const editing = computed(() => docMode.value !== 'read')
/** 分屏时左窗占比（0.3–0.7，拖动分隔条调整） */
const splitRatio = ref(0.5)

/**
 * 视图切换要保管的两样东西：阅读位置锚点（源行）与编辑器状态（含撤销栈）。
 *
 * 为什么不能用 scrollTop：阅读态与编辑态的排版高度完全不同（源码里一行表格
 * 渲染后可能是几十行），把像素值搬过去必然落错地方。源行是唯一稳定的坐标系——
 * 切换前记下「视口顶部是第几行」，切换后在新视图里把同一行滚到顶部。
 *
 * 为什么必须保管 EditorState：它承载 CM6 的撤销栈。编辑器实例随模式切换销毁，
 * 状态不留下来，「没保存、切个视图就撤不回」——用户会以为改动被吞了。
 *
 * 时序规则（锚点用一次即清、外部改动作废快照）收在 `lib/view-handoff.ts`，
 * 那里是纯函数、有单测覆盖。
 */
const handoff = createHandoff()
/** 供模板读取的响应式计数器：handoff 内部的 Map 不是响应式的，靠它触发重渲染 */
const handoffEpoch = ref(0)
function touched(): void {
  handoffEpoch.value += 1
}

/** 待恢复的源行（编辑器挂载时读一次；阅读侧渲染完成后由 onRendered 消费） */
const restoreAnchor = computed(() => {
  void handoffEpoch.value
  return peekAnchor(handoff)
})

/** 当前文档的编辑器状态快照（含撤销栈）；没有则为 null */
const currentEditorState = computed(() => {
  void handoffEpoch.value
  const path = activeRef.value?.absolutePath ?? ''
  return path ? stateOf(handoff, path) : null
})

/* ---------- 当前标签 / 当前文档 ---------- */

const activeTab = computed(() => tabs.activeTab)
const activeRef = computed(() => tabs.activeDoc)

/** 当前文档记录（来自文档模型；切标签不丢未保存内容） */
const currentRecord = computed(() => {
  const ref = activeRef.value
  return ref ? documents.get(ref.absolutePath) : null
})

/** 阅读/编辑视图需要的载荷形状（阅读渲染的是缓冲区，不是磁盘内容） */
const currentDoc = computed<DocPayload | null>(() => {
  const record = currentRecord.value
  if (!record) return null
  return {
    path: record.relPath || record.absolutePath,
    absolutePath: record.absolutePath,
    title: record.name,
    text: record.text,
    mtime: record.mtime,
    size: record.size,
  }
})

const dirty = computed(() => {
  const record = currentRecord.value
  return record ? record.text !== record.savedText : false
})

/**
 * 分屏右侧渲染用的文档：输入时防抖。
 *
 * 每个按键都重跑一遍 md + 高亮 + mermaid 会让打字明显发涩；250ms 是人能
 * 感知「跟着变」又不必每次输入都跑满渲染的折中。非分屏模式直接跟随。
 */
const splitDoc = ref<DocPayload | null>(null)
let splitTimer: number | null = null
watch(
  () => [docMode.value, currentDoc.value] as const,
  ([mode, doc]) => {
    if (splitTimer !== null) {
      window.clearTimeout(splitTimer)
      splitTimer = null
    }
    if (mode !== 'split') {
      splitDoc.value = doc
      return
    }
    splitTimer = window.setTimeout(() => {
      splitDoc.value = doc
    }, 250)
  },
  { immediate: true },
)

/**
 * 窗口标题（只进系统任务栏/Alt+Tab，不进窗口内）。
 *
 * 窗口内不再显示文档标题——标题栏中间留给搜索框。系统层仍要能认出这是哪篇文档，
 * 否则任务栏会永远只有 "docvi"。未保存时前面加圆点，与标签上的脏标记语义一致。
 */
const windowTitle = computed(() => {
  const name = activeRef.value?.title ?? ''
  const prefix = dirty.value && name ? '• ' : ''
  return name ? `${prefix}${name} · docvi` : 'docvi'
})

watch(windowTitle, value => {
  document.title = value
})

/** 目录树是否可用（工作区标签的阅读视图才有树）；显隐由 showTree 单独控制 */
const treeAvailable = computed(
  () => view.value === 'reader' && activeTab.value?.kind === 'workspace',
)

/** 侧栏实际渲染条件：可用 + 用户没折叠 */
const showSidebar = computed(() => treeAvailable.value && showTree.value)

/** 大纲只在阅读态有意义；编辑态下右侧面板会被收起 */
const outlineAvailable = computed(() => view.value === 'reader' && !editing.value)
const showOutlinePanel = computed(() => outlineAvailable.value && showOutline.value)

/** 树顶部的工作区名：从注册表实时取，快照不可信（可能为空串或 id） */
const activeScopeLabel = computed(() => {
  const tab = activeTab.value
  const fromRegistry = tab?.workspaceId
    ? store.workspaces.find(item => item.id === tab.workspaceId)?.name
    : undefined
  if (fromRegistry) return fromRegistry
  return isRealScopeLabel(tab?.scopeLabel ?? '') ? (tab?.scopeLabel ?? '') : ''
})

/** 搜索面板用的工作区名表（结果分组与徽标都靠它） */
const workspaceNames = computed(() => new Map(store.workspaces.map(item => [item.id, item.name])))

/**
 * 站内链接的前缀（只容器版有）。
 *
 * 容器里内容根的 URL 前缀是 `/<仓库>`，站内链接与图片都在这个命名空间里。
 * 桌面端没有仓库段，链接就是工作区相对路径。
 */
const docLinkPrefix = computed(() => {
  if (!isWebHost) return ''
  const id = activeTab.value?.workspaceId
  return id ? `/${id}` : ''
})

/**
 * 正文内相对图片的前缀。
 *
 * 桌面端**必须**给出 `docvi://asset/<工作区>/`：渲染管线把图片归一成根相对
 * 路径（`/img/a.png`），留空就会被浏览器解析到 `docvi://app/img/a.png`——
 * 渲染产物目录里没有这篇文档的图片，结果是破图。主进程按登记的工作区 id
 * 把根目录换出来，URL 里不出现任何磁盘路径。
 */
const docAssetPrefix = computed(() => {
  if (!isWebHost) {
    const id = activeTab.value?.workspaceId
    return id ? `docvi://asset/${id}` : ''
  }
  const id = activeTab.value?.workspaceId
  return id ? `/${id}` : ''
})

const unregisters: Array<() => void> = []

/**
 * 主题命令的注销函数（与 unregisters 分开）。
 *
 * 主题清单是**运行期变化**的：插件装上/停用都会增减条目，因此这批命令不能
 * 像内置命令那样在启动时注册一次就完事，只能跟着清单重建。
 */
let themeCommandUnregisters: Array<() => void> = []

/** 错误提示 8 秒自动收起；新错误重新计时 */
let errorTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => store.error,
  message => {
    if (errorTimer) clearTimeout(errorTimer)
    errorTimer = null
    if (!message) return
    errorTimer = setTimeout(() => {
      store.setError(null)
      errorTimer = null
    }, 8000)
  },
)

/**
 * 成功提示（拉取到新提交、切分支完成）。
 *
 * 与错误分开：错误是「出事了」，必须停留到用户看见；成功只是确认动作生效，
 * 3.5 秒就够。共用一条通道会让两者互相抢占计时器，还会把成功消息染成错误配色。
 */
const notice = ref<string | null>(null)
let noticeTimer: ReturnType<typeof setTimeout> | null = null
function showNotice(message: string): void {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = null
    noticeTimer = null
  }, 3500)
}

/* ---------- 添加目录时的内容根候选 ---------- */

const candidateState = ref<{
  open: boolean
  /** 用户实际选中的目录（「就用这个目录」按钮用） */
  root: string
  candidates: Array<{ name: string; path: string }>
}>({ open: false, root: '', candidates: [] })

/** 候选里挑一个：用候选路径添加 */
async function pickCandidate(path: string): Promise<void> {
  candidateState.value = { open: false, root: '', candidates: [] }
  const entry = await store.addWorkspaceAt(path)
  if (entry) await openWorkspaceTab(entry.id)
}

/** 坚持用所选目录本身（虽然它自己不是内容根） */
async function keepPickedRoot(): Promise<void> {
  const root = candidateState.value.root
  candidateState.value = { open: false, root: '', candidates: [] }
  if (!root) return
  const entry = await store.addWorkspaceAt(root)
  if (entry) await openWorkspaceTab(entry.id)
}

/* ---------- 通用确认框（关闭脏标签等） ---------- */

const confirmState = ref<{
  open: boolean
  title: string
  message: string
  actions: ConfirmAction[]
}>({
  open: false,
  title: '',
  message: '',
  actions: [],
})
let confirmResolve: ((id: string | null) => void) | null = null

function askConfirm(
  title: string,
  message: string,
  actions: ConfirmAction[],
): Promise<string | null> {
  confirmState.value = { open: true, title, message, actions }
  return new Promise(resolve => {
    confirmResolve = resolve
  })
}

function resolveConfirm(id: string | null): void {
  confirmState.value = { ...confirmState.value, open: false }
  const resolve = confirmResolve
  confirmResolve = null
  resolve?.(id)
}

/* ---------- 启动 ---------- */

onMounted(async () => {
  theme.applyToDom()
  theme.migrateLegacy()
  migrateLegacyLocale()

  /*
   * 容器版：地址栏路由必须**在任何标签激活之前**读出来。
   *
   * 下面 `ensureLibrary()` 会激活库标签，watcher 随即把地址栏改写成 `/`；
   * 那时再 `readRoute()` 就只剩空路径——深链与分支切换都会落到空首页。
   * 先读一次存起来，装载完仓库清单后再应用。
   */
  const initialRoute = isWebHost ? readRoute() : null

  // 语言可能在运行中切换：索引进度是后台任务的展示文案，必须跟着走
  searchIndex.setLabels({ indexing: t('status.indexing') })
  watch(locale, () => searchIndex.setLabels({ indexing: t('status.indexing') }))

  // 设置：主题 / 语言已由 preload 快照初始化；这里把外部修改接上
  const unsubscribeSettings = window.docvi.onSettingsChanged(next => {
    theme.applySettings(next)
    applyExternalLocale(next.locale)
    tabs.setPreferences(next.tabs)
  })
  unregisters.push(unsubscribeSettings)
  tabs.setPreferences(window.docvi.bootSettings.tabs)

  // 标签脏检查：上限策略关闭标签时不能用有未保存修改的（文档模型是真相源）
  tabs.setDirtyCheck(tab => {
    const ref = tabs.currentDocOf(tab.id)
    return ref ? documents.isDirty(ref.absolutePath) : false
  })

  tabs.ensureLibrary(t('app.library'))
  // 会话恢复：session.json 优先；没有则沿用 localStorage 迁移结果
  const session = await window.docvi.sessionRead()
  if (session.ok && session.data) tabs.hydrate(session.data)
  tabs.ensureLibrary(t('app.library'))

  await store.loadWorkspaces()
  // 标签上存的作用域名只是快照：旧会话可能是空串或工作区 id，统一按注册表纠正
  tabs.syncWorkspaceNames(new Map(store.workspaces.map(item => [item.id, item.name])))
  // 切分支时要判断「是不是默认分支」（是就清掉 ?branch= 保持 URL 干净）
  setDefaultBranchLookup(
    slug => store.workspaces.find(item => item.id === slug)?.portal?.defaultBranch ?? null,
  )

  await plugins.load()
  await pluginThemes.load(plugins.records)
  theme.dropPluginThemes(key => !pluginThemes.themes.value.some(item => item.id === key))

  // 恢复上次激活的标签（页标签不需要额外装载）
  const tab = activeTab.value
  if (tab && (tab.kind === 'workspace' || tab.kind === 'file')) {
    await ensureTabReady(tab)
    await restoreScroll()
  }

  /*
   * 容器版：地址栏是真入口。
   *
   * `/仓库/文档路径` 是分享链接与刷新的唯一依据，优先级高于会话恢复——
   * 用户点开一条链接，期待看到链接指向的文档，而不是他上次在这台浏览器里
   * 停在哪（两者是不同的人写下的意图）。
   */
  if (isWebHost) {
    // 用挂载时抢在标签激活之前读到的那一份：此刻地址栏可能已被改写
    const initialPreview = readPreviewRoute()
    if (initialPreview) {
      previewRoute.value = initialPreview
    } else if (initialRoute) {
      await openRoute(initialRoute.slug, initialRoute.path)
    } else {
      replaceLibraryUrl()
    }
    // 初始路由已落定：从此允许标签变化回写地址栏
    routeSettled = true
    unregisters.push(
      onRouteChange(() => {
        // 预览页是独立视图：地址栏变化时优先看它
        const nextPreview = readPreviewRoute()
        if (nextPreview) {
          previewRoute.value = nextPreview
          return
        }
        previewRoute.value = null
        const next = readRoute()
        if (next) void openRoute(next.slug, next.path)
        else goLibrary()
      }),
    )
  }

  // 服务状态要在启动时就拿到：状态栏的 MCP 芯片常驻显示运行与否
  if (!isWebHost) {
    void service.load()
    unregisters.push(service.subscribe())
  }

  const unsubscribe = window.docvi.onOpenPath(path => void openStandalone(path))
  unregisters.push(unsubscribe)
  const pending = await window.docvi.appPendingPaths()
  if (pending.ok) {
    for (const path of pending.data) await openStandalone(path)
  }

  registerCommands()
})

onBeforeUnmount(() => {
  for (const off of unregisters) off()
  for (const off of themeCommandUnregisters) off()
  searchIndex.dispose()
  if (errorTimer) clearTimeout(errorTimer)
})

/* ---------- 文档装载 ---------- */

/** 确保某篇文档已在文档模型里（没有才读盘；已有则保留缓冲区） */
async function ensureDocLoaded(ref: DocRef): Promise<boolean> {
  if (documents.get(ref.absolutePath)) return true
  const payload = ref.workspaceId
    ? await store.readDoc(ref.workspaceId, ref.relPath)
    : await store.readFile(ref.absolutePath)
  if (!payload) return false
  const record = documents.load(payload)
  // 工作区文档要记回 workspaceId（DocPayload.path 是相对路径）
  if (ref.workspaceId) record.workspaceId = ref.workspaceId
  return true
}

/**
 * 激活某个标签时要做的全部准备：树、文档（索引在后台跑）。
 *
 * **索引不在这里等**：整库读盘 + worker 建索引在大仓库上要几秒，等它完成
 * 会让「点开工作区」表现为卡住不动。这里只把索引排进队列，进度交给底栏
 * （`lib/tasks`）；搜索面板在索引未就绪时显示自己的进度文案。
 */
async function ensureTabReady(tab: TabRecord): Promise<boolean> {
  if (tab.kind === 'library') return true
  if (tab.kind === 'workspace' && tab.workspaceId) {
    const workspace = store.workspaces.find(item => item.id === tab.workspaceId)
    if (!workspace) return false
    /*
     * 树的装载条件不是「activeWorkspaceId 变了」，而是「这棵树的归属不是它」。
     * 启动时不再预扫树，首个工作区打开时 activeWorkspaceId 可能已经等于它，
     * 只看前者会让树保持为空（用户看到「还没有打开文档」）。
     */
    if (store.treeWorkspaceId !== tab.workspaceId) {
      await store.openWorkspace(tab.workspaceId)
    }
    // 顶层目录默认展开（只播种一次；用户手动折叠后不再重置）
    tabs.seedExpanded(
      tab.id,
      store.tree.filter(node => node.type === 'dir').map(node => node.path),
    )
    // 当前工作区优先入队，其余工作区空闲时补；两者都不 await（见上）
    void searchIndex.index(tab.workspaceId).then(() =>
      searchIndex.indexRest(
        store.workspaces.map(item => item.id),
        tab.workspaceId,
      ),
    )
  }
  const ref = tabs.currentDocOf(tab.id)
  if (!ref) {
    // 标签刚建、还没选文档：先落到落地页（目录树首项有 landing 时用它）
    return true
  }
  return ensureDocLoaded(ref)
}

/** 按当前标签记录的滚动位置恢复（渲染完成后再调用） */
async function restoreScroll(): Promise<void> {
  const ref = activeRef.value
  if (!ref) return
  await nextTick()
  readerRef.value?.restoreScroll(ref.scrollY)
}

/* ---------- 标签操作 ---------- */

/** 激活标签：写回滚动 → 切上下文 → 装载内容 */
async function activateTab(id: string): Promise<void> {
  if (id === tabs.activeId) return
  // 切走前保存当前屏的滚动位置
  if (readerRef.value && activeRef.value) {
    tabs.setScroll(tabs.activeId ?? '', readerRef.value.getScroll())
  }
  docMode.value = 'read'
  tabs.activate(id)
  const tab = activeTab.value
  if (!tab) return
  void tabBarRef.value?.revealTab(tab.id)

  if (tab.kind === 'library') {
    return
  }
  const ok = await ensureTabReady(tab)
  if (!ok) {
    store.setError(t('error.tabUnavailable'))
    tabs.close(tab.id)
    return
  }
  await restoreScroll()
}

/** 文档库标签：没有则创建 */
function goLibrary(): void {
  const tab = tabs.ensureLibrary(t('app.library'))
  tabs.activate(tab.id)
}

/** 从文档库打开工作区 = 新建标签（不去重） */
async function openWorkspaceTab(workspaceId: string): Promise<void> {
  const workspace = store.workspaces.find(item => item.id === workspaceId)
  if (!workspace) return
  const result = tabs.openWorkspace({ id: workspace.id, name: workspace.name })
  if (!result.tab) {
    store.setError(result.rejected ?? t('error.tabLimit'))
    return
  }
  await ensureTabReady(result.tab)
  // 默认落到落地页，让用户第一眼看到内容
  const landing = findLanding(store.tree)
  if (landing) await navigateInTab(result.tab.id, landing, false)
}

/* ---------- 容器版：地址栏路由 ---------- */

/** 正在应用地址栏带来的路由：此时的文档切换不再回写地址栏（否则历史里会多一条） */
let applyingRoute = false

/**
 * 容器版：切到某个仓库的某个已发布分支。
 *
 * 只影响当前读者（地址带 `?branch=`）：不写服务器、不动仓库，其他读者不受影响。
 * 切完整页重载——分支换了等于整个内容根换了，就地刷新要逐个失效树/索引/正文，
 * 漏一个就会出现「树是新的、正文是旧的」。
 */
function selectBranch(payload: { slug: string; branch: string }): void {
  if (!isWebHost) return
  switchBranch(payload.slug, payload.branch)
}

/**
 * 容器版：装载本地 Markdown 预览（内容只在浏览器内存）。
 *
 * 装载后立刻进该工作区，落到第一篇文档——用户的动作意图就是「看一眼」，
 * 让他再自己点一次是多余的步骤。
 */
async function loadLocalPreview(payload: {
  files: Array<{ path: string; text: string }>
  kind: 'files' | 'dir'
}): Promise<void> {
  const result = await window.docvi.localPreview(payload.files, payload.kind)
  if (!result.ok) {
    store.setError(result.error.message)
    return
  }
  if (!result.data) return
  // 工作区清单要重新拉：新装载的本地预览是列表里的第一项
  await store.loadWorkspaces()
  await openWorkspaceTab(result.data.id)
  store.setError(t('portal.localLoaded', { count: payload.files.length }))
}

/** 文档库组件暴露的「打开本地文件选择框」——命令面板用，避免两处各写一份 input */
const libraryRef = ref<{ pickLocalFiles: () => void } | null>(null)

function pickLocalFiles(): void {
  libraryRef.value?.pickLocalFiles()
}

/**
 * 按地址栏路由打开文档。
 *
 * 三种情况都要能处理，因为链接可能指向任何地方：
 *  1. 当前标签已是同仓工作区 → 原地换文档；
 *  2. 当前标签是别的仓 / 文档库 → 新开该仓标签（不毁掉当前浏览现场）；
 *  3. 地址里没有文档段（`/<仓库>/`）→ 落到该仓落地页。
 */
async function openRoute(slug: string, path: string): Promise<void> {
  const workspace = store.workspaces.find(item => item.id === slug)
  if (!workspace) {
    store.setError(t('error.workspaceMissing'))
    return
  }

  let target = tabs.activeTab
  if (!target || target.kind !== 'workspace' || target.workspaceId !== slug) {
    const result = tabs.openWorkspace({ id: workspace.id, name: workspace.name })
    if (!result.tab) {
      store.setError(result.rejected ?? t('error.tabLimit'))
      return
    }
    target = result.tab
    await ensureTabReady(target)
  }

  const docPath = path || findLanding(store.tree)
  if (!docPath) return
  applyingRoute = true
  try {
    await navigateInTab(target.id, docPath, false)
  } finally {
    applyingRoute = false
  }
}

/**
 * 正文里的站内链接（渲染管线已归一成**根相对路径**）。
 *
 * 两种宿主的根相对路径含义不同，必须分开解析：
 *  - **容器**：`/<仓库>/<内容根内路径>`——第一段是仓库 slug，交给 SPA 路由；
 *  - **桌面**：`/<内容根内路径>`——没有仓库段，就是当前工作区里的相对路径。
 *    早先按容器语义解析，第一段会被当成仓库 id 去查注册表，查不到就报
 *    「工作区不存在」；而更早版本根本没接管点击，窗口会直接导航到那个地址，
 *    整个界面变白——用户报的「点带跳转的文本，界面直接空掉」就是它。
 *
 * 锚点单独处理：只滚到小节，不重新打开文档——同一篇里点目录跳转是最高频的
 * 链接形态，走一遍装载会把渲染、高亮、图表全重跑一次。
 */
async function onContentNavigate(href: string): Promise<void> {
  const [rawPath, hash = ''] = href.split('#')
  const segments = (rawPath ?? '').split('/').filter(Boolean).map(safeDecode)
  const current = activeTab.value

  if (!isWebHost) {
    // 桌面：整条路径都是工作区内的相对路径
    if (current?.kind !== 'workspace' || !current.workspaceId) return
    const raw = segments.join('/') || findLanding(store.tree)
    if (!raw) return
    // 链接是不带扩展名的：换成树里的真实文件名（落地页可能是 索引.md / README.md）
    const target = resolveDocPath(raw)
    if (!target) {
      store.setError(t('error.linkMissing', { path: raw }))
      return
    }
    if (target === activeRef.value?.relPath) {
      if (hash) readerRef.value?.scrollTo(`#${cssEscape(hash)}`)
      return
    }
    await navigateInTab(current.id, target, false)
    if (hash) {
      // 渲染是异步的：等这一轮 DOM 稳定后再滚到锚点
      await nextTick()
      window.setTimeout(() => readerRef.value?.scrollTo(`#${cssEscape(hash)}`), 120)
    }
    return
  }

  const slug = segments[0] ?? ''
  if (!slug) return
  const path = segments.slice(1).join('/')

  if (current?.workspaceId === slug && current.kind === 'workspace') {
    const target = path || findLanding(store.tree)
    if (!target) return
    if (target === activeRef.value?.relPath) {
      if (hash) readerRef.value?.scrollTo(`#${cssEscape(hash)}`)
      return
    }
    await navigateInTab(current.id, target, false)
    if (hash) {
      // 渲染是异步的：等这一轮 DOM 稳定后再滚到锚点
      await nextTick()
      window.setTimeout(() => readerRef.value?.scrollTo(`#${cssEscape(hash)}`), 120)
    }
    return
  }
  await openRoute(slug, path)
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** CSS.escape 的替代：只转义会破坏选择器的字符（锚点 id 里常见空格与点） */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * 文档切换 → 地址栏。
 *
 * push 由 `navigateInTab` 负责（那是唯一真正「换文档」的入口，浏览器后退才能
 * 回到上一篇）；这里只处理标签激活等**位置变化**，用 replace——标签切换是同一
 * 段浏览里的跳转，在历史里堆一串重复项没有意义。库首页同理。
 *
 * **首帧之前不许写地址栏**：启动时 `ensureLibrary()` 会先激活库标签，watcher
 * 立刻触发并调 `replaceLibraryUrl()`，把深链 `/<仓库>/<文档>?branch=…` 改写成 `/`——
 * 之后 `readRoute()` 读到的已经是空路径，深链与分支切换双双失效（实测：直接
 * 打开一个仓库深链会被丢回空首页）。所以初始路由应用完之前一律不写。
 */
let routeSettled = !isWebHost

watch(
  () => [activeTab.value?.workspaceId, activeRef.value?.relPath] as const,
  ([workspaceId, relPath]) => {
    if (!isWebHost || applyingRoute || !routeSettled) return
    if (workspaceId) replaceDocUrl(workspaceId, relPath ?? '')
    else replaceLibraryUrl()
  },
)

/** 目录树里找第一篇可显示的文档（优先目录落地页） */
function findLanding(nodes: ReturnType<typeof useAppStore>['tree']): string | null {
  const walk = (list: typeof nodes): string | null => {
    for (const node of list ?? []) {
      if (node.type === 'dir' && node.landing) return node.landing
      if (node.type === 'doc') return node.path
      if (node.children) {
        const hit = walk(node.children)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(nodes)
}

/**
 * 把正文链接里的**无扩展名路径**换回磁盘上的真实相对路径。
 *
 * 渲染管线按平台约定把 `.md` 剥掉了（站内链接从来不需要扩展名），但桌面端
 * 读文件要的是真实文件名。做法是从目录树里比对，而不是盲目拼 `.md`——
 * 目录落地页可能是 `索引.md` / `README.md`，拼错就是「文档不存在」。
 *
 * 树里 `doc.path` 带扩展名、`dir.landing` 也带，因此两边都按「剥掉扩展名后
 * 比较」处理。
 */
function resolveDocPath(relPath: string): string | null {
  if (!relPath) return null
  if (/\.md$/i.test(relPath)) return relPath
  const stripExt = (value: string): string => value.replace(/\.md$/i, '')

  const walk = (nodes: ReturnType<typeof useAppStore>['tree']): string | null => {
    for (const node of nodes ?? []) {
      if (node.type === 'doc') {
        if (stripExt(node.path) === relPath) return node.path
        continue
      }
      // 目录：先看落地页（它就是点目录名打开的那一篇）
      if (node.landing && stripExt(node.landing) === relPath) return node.landing
      if (node.children) {
        const hit = walk(node.children)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(store.tree)
}

/**
 * 展开目标文档的所有祖先目录（目录树定位）。
 *
 * 从搜索、最近打开、外部链接进到一篇深层文档时，若祖先目录是折叠的，
 * 树里根本看不到这一行——用户只知道「打开了」，不知道「我在哪」。
 * 这里只做**展开**，不动用户已展开的其他分支（折叠会打乱浏览现场）。
 *
 * 相对路径逐段前缀就是祖先目录的相对路径（与树节点 path 同口径）。
 */
function revealInTree(tabId: string, relPath: string): void {
  const parts = relPath.split('/').filter(Boolean)
  if (parts.length < 2) return
  const tab = tabs.tabs.find(item => item.id === tabId)
  if (!tab) return
  const ancestors: string[] = []
  for (let i = 1; i < parts.length; i += 1) ancestors.push(parts.slice(0, i).join('/'))
  const merged = new Set([...tab.expanded, ...ancestors])
  if (merged.size !== tab.expanded.length) tabs.setExpanded(tabId, [...merged])
}

/**
 * 在标签内打开一篇文档。
 *
 * `newTab = true` 时新建标签（右键菜单 / 跨工作区跳转）；
 * 否则替换当前标签的内容（目录树单击、搜索结果）。
 */
async function navigateInTab(tabId: string, relPath: string, newTab: boolean): Promise<void> {
  const tab = tabs.tabs.find(item => item.id === tabId)
  if (!tab || tab.kind !== 'workspace' || !tab.workspaceId) return
  const workspaceId = tab.workspaceId
  const payload = await store.readDoc(workspaceId, relPath)
  if (!payload) return
  if (newTab) {
    // 名字只从工作区注册表取：`scopeLabel || workspaceId` 会把哈希写到标签上
    const name = store.workspaces.find(item => item.id === workspaceId)?.name ?? ''
    const result = tabs.openWorkspace({ id: workspaceId, name })
    if (!result.tab) {
      store.setError(result.rejected ?? t('error.tabLimit'))
      return
    }
    tabs.navigate(result.tab.id, {
      key: `workspace:${workspaceId}:${relPath}`,
      workspaceId,
      relPath,
      absolutePath: payload.absolutePath,
      title: payload.title,
      scrollY: 0,
    })
    revealInTree(result.tab.id, relPath)
    await ensureDocLoaded(tabs.currentDocOf(result.tab.id) as DocRef)
    return
  }

  // 替换当前标签：先把当前屏滚动写回
  if (readerRef.value && activeRef.value) {
    tabs.setScroll(tabId, readerRef.value.getScroll())
  }
  const record = documents.load(payload)
  record.workspaceId = workspaceId
  /*
   * 容器版：地址栏必须先于 tabs.navigate 更新。
   *
   * 反过来的顺序会让下面那个 watch 抢先把 URL 改成新文档（它监听 activeRef），
   * 等这里再 push 时目标地址已经和当前地址相同，push 被当成空操作跳过——
   * 结果整段浏览只留一条历史，浏览器后退直接退出站点。
   */
  if (isWebHost && !applyingRoute) pushDocUrl(workspaceId, relPath)
  // 深层文档：先展开祖先，再落标签——否则树里看不到刚打开的这一行
  revealInTree(tabId, relPath)
  tabs.navigate(tabId, {
    key: `workspace:${workspaceId}:${relPath}`,
    workspaceId,
    relPath,
    absolutePath: payload.absolutePath,
    title: payload.title,
    scrollY: 0,
  })
  docMode.value = 'read'
  await store.touchRecent({
    path: payload.absolutePath,
    workspaceId,
    relPath,
    title: payload.title,
  })
  await nextTick()
  readerRef.value?.restoreScroll(0)
}

/** 目录树单击 / 搜索结果：在当前标签内切换 */
async function openDoc(path: string): Promise<void> {
  const tabId = tabs.activeId
  if (!tabId) return
  await navigateInTab(tabId, path, false)
}

/**
 * 全局搜索命中「其他工作区」的文档：新开该工作区的标签并落到这篇。
 *
 * 为什么不复用当前标签：当前标签属于另一个工作区，换掉内容等于把用户的浏览
 * 现场丢了；而两个工作区的上下文本来就不该混在同一个标签里。
 */
async function openDocInWorkspace(payload: { workspaceId: string; path: string }): Promise<void> {
  const workspace = store.workspaces.find(item => item.id === payload.workspaceId)
  if (!workspace) {
    store.setError(t('error.workspaceMissing'))
    return
  }
  const result = tabs.openWorkspace({ id: workspace.id, name: workspace.name })
  if (!result.tab) {
    store.setError(result.rejected ?? t('error.tabLimit'))
    return
  }
  await ensureTabReady(result.tab)
  await navigateInTab(result.tab.id, payload.path, false)
}

/** 目录树右键：在新标签页打开 */
async function openDocNewTab(path: string): Promise<void> {
  const tabId = tabs.activeId
  if (!tabId) return
  await navigateInTab(tabId, path, true)
  await nextTick()
  readerRef.value?.restoreScroll(0)
}

/**
 * 单文件（选择框 / 拖放 / 命令行 / 关联 / 最近打开）。
 *
 * 落在已登记工作区内就按工作区文档打开（新标签）：目录树能高亮、相对链接
 * 按库内路径解析，也不会出现「同一文件两种身份」。
 */
async function openStandalone(absolutePath: string): Promise<void> {
  const inside = resolveToWorkspace(absolutePath)
  if (inside) {
    const workspace = store.workspaces.find(item => item.id === inside.workspaceId)
    if (!workspace) return
    const payload = await store.readDoc(inside.workspaceId, inside.relPath)
    if (!payload) return
    const result = tabs.openWorkspace({ id: workspace.id, name: workspace.name })
    if (!result.tab) {
      store.setError(result.rejected ?? t('error.tabLimit'))
      return
    }
    documents.load(payload)
    tabs.navigate(result.tab.id, {
      key: `workspace:${workspace.id}:${inside.relPath}`,
      workspaceId: workspace.id,
      relPath: inside.relPath,
      absolutePath: payload.absolutePath,
      title: payload.title,
      scrollY: 0,
    })
    await ensureTabReady(result.tab)
    await store.touchRecent({
      path: payload.absolutePath,
      workspaceId: workspace.id,
      relPath: inside.relPath,
      title: payload.title,
    })
    return
  }

  const payload = await store.readFile(absolutePath)
  if (!payload) return
  const result = tabs.openFile({ absolutePath: payload.absolutePath, title: payload.title })
  if (!result.tab) {
    store.setError(result.rejected ?? t('error.tabLimit'))
    return
  }
  documents.load(payload)
  await store.touchRecent({
    path: payload.absolutePath,
    workspaceId: null,
    relPath: '',
    title: payload.title,
  })
}

/** 文件是否落在某个已登记工作区内 */
function resolveToWorkspace(absolutePath: string): { workspaceId: string; relPath: string } | null {
  const target = absolutePath.replaceAll('\\', '/').toLowerCase()
  for (const workspace of store.workspaces) {
    const root = workspace.root.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    if (!root || !target.startsWith(`${root}/`)) continue
    const relPath = absolutePath.replaceAll('\\', '/').slice(root.length + 1)
    if (!relPath) continue
    return { workspaceId: workspace.id, relPath }
  }
  return null
}

async function openFileDialog(): Promise<void> {
  const result = await window.docvi.filePick()
  if (!result.ok) {
    store.setError(result.error.message)
    return
  }
  if (result.data) await openStandalone(result.data)
}

/** 最近打开：工作区条目按工作区文档打开（新标签），单文件直接读 */
async function openRecent(entry: {
  workspaceId: string | null
  relPath: string
  path: string
}): Promise<void> {
  if (entry.workspaceId) {
    const exists = store.workspaces.some(item => item.id === entry.workspaceId)
    if (!exists) {
      store.setError(t('error.workspaceGone'))
      return
    }
    await openStandalone(entry.path)
    return
  }
  await openStandalone(entry.path)
}

/**
 * 添加工作区：选目录 → 探测内容根 → 命中候选时让用户挑一个。
 *
 * 为什么不在 IPC 里一把做完：用户选的常常是仓库根或文档总目录，真正的文档根
 * 在里面一层。探测出候选后必须**问一句**才符合预期——直接按父目录加进去，
 * 得到的是一棵把无关目录全摊开的树。没有候选就直接按所选目录添加（自动扫描
 * 模式同样成立），不拿「没有 docs.config.yaml」当拒绝理由。
 */
async function addWorkspace(): Promise<void> {
  const root = await store.pickWorkspace()
  if (!root) return
  const probe = await store.probeWorkspace(root)
  if (!probe) return

  if (probe.candidates.length && !probe.hasConfig) {
    candidateState.value = { open: true, root, candidates: probe.candidates }
    return
  }
  await adoptWorkspace(root)
}

async function adoptWorkspace(root: string): Promise<void> {
  const entry = await store.addWorkspaceAt(root)
  if (entry) await openWorkspaceTab(entry.id)
}

async function removeWorkspace(id: string): Promise<void> {
  const ok = await store.removeWorkspace(id)
  if (!ok) return
  tabs.closeByWorkspace(id)
  if (store.activeWorkspaceId) void searchIndex.index(store.activeWorkspaceId)
}

/* ---------- git 托管工作区 ---------- */

const cloneOpen = ref(false)
/** 分支对话框当前作用的工作区（null = 关闭） */
const branchWorkspace = ref<WorkspaceEntry | null>(null)
/** 正在拉取的工作区 id：按钮转圈用，防重复点击 */
const pullBusy = ref<string | null>(null)

/** 当前标签所属工作区的 git 信息（侧栏状态条用） */
const activeWorkspaceGit = computed(() => {
  const id = activeTab.value?.workspaceId
  if (!id) return null
  return store.workspaces.find(item => item.id === id)?.git ?? null
})

/**
 * 容器读者面：当前标签所属仓库的 portal 状态（分支选择器用）。
 *
 * 本地预览工作区没有 portal（内容在内存里），选择器不应出现；
 * 只有一个分支的仓库也不显示——那没有可选的。
 */
const activePortalWorkspace = computed<PortalWorkspace | null>(() => {
  const id = activeTab.value?.workspaceId
  if (!id) return null
  const portal = store.workspaces.find(item => item.id === id)?.portal
  if (!portal || portal.branches.length <= 1) return null
  return portal
})

function openClone(): void {
  cloneOpen.value = true
  if (!store.gitState) void store.loadGitState()
}

/** 克隆完成：关对话框 → 直接打开这个工作区（用户的下一步必然是看内容） */
async function onCloned(entry: WorkspaceEntry): Promise<void> {
  cloneOpen.value = false
  await store.adoptWorkspace(entry)
  await openWorkspaceTab(entry.id)
}

function openBranchDialog(id: string): void {
  branchWorkspace.value = store.workspaces.find(item => item.id === id) ?? null
}

/**
 * 切分支完成：工作区换了 id，标签、命令面板与搜索索引都要跟着换身份。
 *
 * 顺序很重要——先把标签引用改到新 id，再重扫目录树；反过来会让「恢复当前文档」
 * 用旧 id 去读新工作区，直接读不到。
 */
async function onBranchSwitched(entry: WorkspaceEntry): Promise<void> {
  const previous = branchWorkspace.value
  branchWorkspace.value = null
  if (!previous) return
  tabs.replaceWorkspace(previous.id, { id: entry.id, name: entry.name, root: entry.root })
  tabs.syncWorkspaceNames(new Map(store.workspaces.map(item => [item.id, item.name])))
  // 旧 id 的索引作废、新 id 重新建：切分支后搜索必须查到新分支的内容
  searchIndex.invalidate(previous.id)
  void searchIndex.index(entry.id)
  showNotice(t('git.switchedTo', { branch: entry.git?.branch ?? '' }))

  /*
   * 标签里记的绝对路径指的仍是旧工作树：必须按新根重读，否则阅读区会空白
   * （文档模型按绝对路径索引，旧路径在新根下不存在）。当前文档在新分支上不存在
   * 时退到落地页——分支之间文档集合本来就可能不同。
   */
  const tab = activeTab.value
  if (tab?.kind !== 'workspace' || tab.workspaceId !== entry.id) return
  const loaded = await ensureTabReady(tab)
  if (!loaded) {
    const landing = findLanding(store.tree)
    if (landing) await navigateInTab(tab.id, landing, false)
    else store.setError(t('git.docMissingOnBranch', { branch: entry.git?.branch ?? '' }))
    return
  }
  await restoreScroll()
}

async function pullWorkspace(id: string): Promise<void> {
  if (!id) return
  const target = store.workspaces.find(item => item.id === id)
  if (!target?.git) {
    if (target) store.setError(t('git.notManaged'))
    return
  }
  if (pullBusy.value) return
  pullBusy.value = id
  try {
    const result = await store.pullWorkspace(id)
    if (!result) return
    if (!result.changed) {
      showNotice(t('git.upToDate', { branch: result.branch }))
      return
    }
    showNotice(t('git.pulled', { branch: result.branch, count: result.commits }))
    // 工作树被 reset 过：已装载的文档缓冲区必须按磁盘重读，否则编辑旧内容再保存会覆盖云端
    await reloadOpenDocs(id)
    searchIndex.invalidate(id)
    void searchIndex.index(id)
  } finally {
    pullBusy.value = null
  }
}

/** 拉取后重读该工作区里所有已装载文档（干净的直接采用，脏的标记冲突交给编辑器提示） */
async function reloadOpenDocs(workspaceId: string): Promise<void> {
  const refs = new Map<string, string>()
  for (const tab of tabs.tabs) {
    for (const ref of tab.history) {
      if (ref.workspaceId === workspaceId) refs.set(ref.relPath, ref.title)
    }
  }
  const missing: string[] = []
  for (const relPath of refs.keys()) {
    const payload = await store.readDoc(workspaceId, relPath)
    if (!payload) {
      missing.push(refs.get(relPath) || relPath)
      continue
    }
    const record = documents.load(payload)
    record.workspaceId = workspaceId
  }
  // 云端删掉的文档：必须说一句，否则用户面对的是「标签还在、内容还是旧的」的假象
  if (missing.length) {
    store.setError(t('git.docsGone', { list: missing.slice(0, 3).join('、') }))
  }
}

/* ---------- 临时分享（工作区目录 / 当前文档） ---------- */

/** 分享结果提示条：带链接与复制按钮，不跳走页面 */
const shareToast = ref<{
  url: string
  path: string
  copied: boolean
  /** 生成时局域网是否为关：链接只能本机打开，提示条要说明这点 */
  localOnly: boolean
} | null>(null)
let shareToastTimer: ReturnType<typeof setTimeout> | null = null

function showShareToast(url: string, path: string, localOnly: boolean): void {
  shareToast.value = { url, path, copied: false, localOnly }
  if (shareToastTimer) clearTimeout(shareToastTimer)
  shareToastTimer = setTimeout(() => {
    shareToast.value = null
    shareToastTimer = null
  }, 12000)
}

async function copyShareUrl(): Promise<void> {
  if (!shareToast.value) return
  const ok = await service.copy(shareToast.value.url)
  if (ok && shareToast.value) shareToast.value.copied = true
}

/**
 * 分享一个绝对路径。
 *
 * 服务没在跑时先起服务再重试一次：分享依赖本地服务，让用户自己先去设置页
 * 点「启动」是多余的一步——他要的是链接，不是配置。
 *
 * 局域网没开时先问一句再开：分享的本意是把链接发给别人，只监听回环的话
 * 链接发出去对方也打不开，等于白分享。所以这里不是「提示一下就算了」，
 * 而是把「开启局域网」做成一次确认——用户点确认就顺手开好，不用自己
 * 摸到设置页去翻开关。
 */
async function sharePath(target: string): Promise<void> {
  if (!service.running) {
    await service.restart()
  }
  if (!service.lan) {
    const choice = await askConfirm(t('share.lanTitle'), t('share.lanMessage'), [
      { id: 'enable', label: t('share.lanEnable'), tone: 'primary' },
      { id: 'localOnly', label: t('share.lanLocalOnly') },
    ])
    if (choice === null) return
    // setLan 自己会重绑并等到服务重新监听（主进程里有 5s 上限），
    // 这里不要再加一次 restart——那会把刚绑好的端口又拆一遍。
    if (choice === 'enable') await service.setLan(true)
  }
  const created = await service.createSharePath(target)
  if (!created) return
  showShareToast(created.url, created.path, !service.lan)
  void copyShareUrl()
}

function shareCurrentDoc(): void {
  const ref = activeRef.value
  if (!ref) {
    store.setError(t('error.noDocToShare'))
    return
  }
  void sharePath(ref.absolutePath)
}

function shareWorkspace(id: string): void {
  const workspace = store.workspaces.find(item => item.id === id)
  if (!workspace) return
  void sharePath(workspace.root)
}

/* ---------- 标签历史（Alt+←/→） ---------- */

async function stepHistory(delta: number): Promise<void> {
  const tabId = tabs.activeId
  if (!tabId || !activeTab.value || activeTab.value.kind === 'library') return
  if (readerRef.value && activeRef.value) tabs.setScroll(tabId, readerRef.value.getScroll())
  const next = tabs.step(tabId, delta)
  if (!next) return
  docMode.value = 'read'
  await ensureDocLoaded(next)
  await nextTick()
  readerRef.value?.restoreScroll(next.scrollY)
}

/* ---------- 关闭标签 ---------- */

/** 关闭标签：脏标签先问；取消返回 false */
async function closeTab(id: string): Promise<boolean> {
  const tab = tabs.tabs.find(item => item.id === id)
  if (!tab || tab.kind === 'library') return false
  const ref = tabs.currentDocOf(id)
  const isDirty = ref ? documents.isDirty(ref.absolutePath) : false
  if (isDirty && ref) {
    const choice = await askConfirm(
      t('confirm.closeDirtyTitle'),
      t('confirm.closeDirtyMessage', { name: ref.title }),
      [
        { id: 'save', label: t('confirm.save'), tone: 'primary' },
        { id: 'discard', label: t('confirm.discard'), tone: 'danger' },
        { id: 'cancel', label: t('confirm.cancel'), tone: 'ghost' },
      ],
    )
    if (!choice || choice === 'cancel') return false
    if (choice === 'save') {
      // 只有在编辑态才有编辑器实例；不在编辑态也允许保存缓冲区（直接写盘）
      if (id === tabs.activeId && editorRef.value) {
        await editorRef.value.save()
        if (documents.isDirty(ref.absolutePath)) return false
      } else {
        const record = documents.get(ref.absolutePath)
        if (record) {
          const result = await window.docvi.docWrite({
            absolutePath: record.absolutePath,
            text: record.text,
            baseMtime: record.mtime,
          })
          if (!result.ok || result.data.status === 'conflict') {
            store.setError(t('error.saveBeforeClose'))
            return false
          }
          documents.markSaved(record.absolutePath, {
            mtime: result.data.mtime,
            size: result.data.size,
            text: record.text,
          })
          await window.docvi.draftClear(record.absolutePath)
        }
      }
    }
  }
  const closingActive = tabs.activeId === id
  tabs.close(id)
  /*
   * 标签关掉就释放它的编辑器状态（撤销栈）与锚点。
   * 不释放的话，同一篇文档在本次会话里反复开关会持续堆 EditorState——每个都
   * 含完整 history，长会话下是实打实的内存泄漏；而且重新打开时旧撤销栈还会
   * 复活，用户按 Ctrl+Z 会撤到「上次关闭前」的内容，看起来像文件被改了。
   */
  if (ref) forgetDocument(handoff, ref.absolutePath)
  touched()
  if (closingActive) {
    const next = tabs.activeTab
    if (next) await activateTab(next.id)
    else goLibrary()
  }
  return true
}

async function closeOthers(tabId: string): Promise<void> {
  const victims = tabs.tabs.filter(tab => tab.kind !== 'library' && tab.id !== tabId)
  for (const tab of victims) {
    if (tab.id === tabs.activeId) continue
    await closeTab(tab.id)
  }
}

async function closeRight(tabId: string): Promise<void> {
  const index = tabs.tabs.findIndex(tab => tab.id === tabId)
  if (index < 0) return
  const victims = tabs.tabs.filter((tab, at) => at > index && tab.kind !== 'library')
  for (const tab of victims) await closeTab(tab.id)
}

/**
 * 关闭全部标签页（文档库除外）。
 *
 * 逐个走 closeTab：脏标签会弹「保存 / 丢弃 / 取消」，用户取消时立刻停手——
 * 批量关闭最怕「问了第一个说不，后面还是被关掉」。
 */
async function closeAllTabs(): Promise<void> {
  const victims = tabs.tabs.filter(tab => tab.kind !== 'library')
  for (const tab of victims) {
    // 每关一个都要重新取一次：closeTab 会改数组，闭包里的旧引用会失效
    if (!tabs.tabs.some(item => item.id === tab.id)) continue
    const ok = await closeTab(tab.id)
    if (!ok) return
  }
  goLibrary()
}

/**
 * 复制标签页（当前文档）。
 *
 * 不是「复制标签这个壳」，而是「再开一个指向同一篇文档的标签」：同一篇文档
 * 可以开两个标签、各自停在不同位置——比价两处上下文时这是最直接的用法。
 * 文档缓冲区按绝对路径共享（见 documents store），所以不会有两份内容。
 */
async function copyTab(tabId: string): Promise<void> {
  const tab = tabs.tabs.find(item => item.id === tabId)
  if (!tab) return
  const ref = tabs.currentDocOf(tabId)

  if (!ref) {
    // 页面型标签（设置 / 插件）与空工作区标签：单例语义不允许复制，直接激活
    tabs.activate(tabId)
    return
  }
  if (!tab.workspaceId) {
    // 单文件标签：按绝对路径重开一个（不用 workspace 路径，它可能已不在库内）
    const result = tabs.openFile({ absolutePath: ref.absolutePath, title: ref.title })
    if (!result.tab) {
      store.setError(result.rejected ?? t('error.tabLimit'))
      return
    }
    await ensureDocLoaded(tabs.currentDocOf(result.tab.id) as DocRef)
    return
  }
  // 工作区文档：复用 navigateInTab 的新标签分支，历史与展开状态一并带上
  await navigateInTab(tabId, ref.relPath, true)
}

/** 标签被拖动排序后落地 */
function onTabReorder(fromId: string, toId: string | null): void {
  tabs.reorder(fromId, toId)
}

/* ---------- Ctrl+Tab 浮层（WebStorm 手感） ---------- */

const switcher = ref<{ open: boolean; cursor: number }>({ open: false, cursor: 0 })
const switcherItems = computed(() => tabs.mruTabs)

/** 打开浮层：初始选中「上一次用的标签」= MRU 第二项（因为当前标签在 MRU 首位） */
function openSwitcher(): void {
  const items = switcherItems.value
  if (items.length < 2) {
    // 只有一个候选标签时没有"切换"可言：仍在两个标签之间来回
    switcher.value = { open: items.length === 1, cursor: 0 }
    return
  }
  switcher.value = { open: true, cursor: 1 }
}

function cycleSwitcher(delta: number): void {
  const items = switcherItems.value
  if (!switcher.value.open) {
    openSwitcher()
    return
  }
  if (!items.length) return
  switcher.value = {
    open: true,
    cursor: (switcher.value.cursor + delta + items.length) % items.length,
  }
}

async function commitSwitcher(): Promise<void> {
  if (!switcher.value.open) return
  const target = switcherItems.value[switcher.value.cursor]
  switcher.value = { open: false, cursor: 0 }
  if (target) await activateTab(target.id)
}

function cancelSwitcher(): void {
  switcher.value = { open: false, cursor: 0 }
}

/* ---------- 保存回调 ---------- */

function onRendered(payload: { path: string; title: string }): void {
  const tab = activeTab.value
  const ref = activeRef.value
  if (!tab || !ref) return
  if (payload.title) tabs.setDocTitle(tab.id, payload.title)
  /*
   * 两种恢复来源，优先级分明：
   *  1. 刚切过视图 → 按源行落位（用户「正在看的内容」必须还在视野里）；
   *  2. 否则按标签记忆的像素位置（同视图内切回来）。
   * 锚点在 takeAnchor 里取完即清：渲染完毕会触发多次（高亮 / Mermaid / 组件
   * 挂载各一次），留着会被重放成「页面老是弹回原处」。
   */
  const anchor = takeAnchor(handoff)
  if (anchor !== null && readerRef.value?.scrollToSourceLine(anchor)) return
  readerRef.value?.restoreScroll(ref.scrollY)
}

/** 保存成功：标签标题按新正文的首个 H1 更新（其它状态在文档模型里已同步） */
function onEditorSaved(payload: { text: string }): void {
  const tab = activeTab.value
  if (!tab) return
  /*
   * 保存后作废该文档的编辑器快照（含撤销栈）。
   *
   * 快照里的撤销栈记着「保存前」的步骤：留着它，用户切走再回来按 Ctrl+Z 会撤回
   * 已落盘的内容，脏标记又从「已保存」跳回「未保存」——正是用户报的
   * 「切视图后有时变回未保存」。
   */
  const path = activeRef.value?.absolutePath
  if (path) {
    invalidateState(handoff, path)
    touched()
  }
  // ⚠️ 必须是 `\s`：写成 `s` 会匹配「#sss…」这种字面量，永远取不到真标题
  const h1 = /^#\s+(.+)$/m.exec(payload.text)?.[1]?.trim()
  if (h1) tabs.setDocTitle(tab.id, h1)
}

/** 记住编辑器状态（含撤销栈）：切视图后再进来，Ctrl+Z 仍然生效 */
function rememberEditorState(payload: { absolutePath: string; state: unknown }): void {
  rememberState(handoff, payload?.absolutePath ?? '', payload?.state ?? null)
  touched()
}

/** 编辑器已按锚点落位：清掉锚点，避免下一次普通渲染再被拽回原处 */
function consumeAnchor(): void {
  takeAnchor(handoff)
  touched()
}

/**
 * 切换阅读 / 实时预览 / 源码 / 分屏。
 *
 * 编辑器实例只存在于编辑态；回到阅读时缓冲区由文档模型持有，所以
 * 「编辑 → 阅读」看到的是未保存的最新内容，而不是磁盘版本。
 *
 * 两件必须一起做的事（都关于「切视图不该丢东西」）：
 *  1. **保住阅读位置**：切换前记下视口顶部的源行，切换后在新视图里落到同一行。
 *     用源行不用像素——两个视图的排版高度完全不同，像素搬过去必然偏。
 *  2. **保住撤销栈**：编辑态销毁前把 `EditorState` 存起来，下次进编辑态带回去。
 *     丢了它，用户切一下视图就再也撤不回未保存的改动。
 */
function setDocMode(mode: DocMode): void {
  if (docMode.value === mode) return
  const from = docMode.value

  /*
   * 记锚点：从阅读态切走时读阅读视图的顶部源行；从编辑态切走时读编辑器。
   * 分屏的左栏是源码编辑器、右侧是阅读视图——从分屏切出时以左侧（源码）为准，
   * 因为用户的重心通常在正在编辑的那一侧。
   */
  const position =
    from === 'read'
      ? {
          topLine: readerRef.value?.getTopLine() ?? 0,
          scrollTop: readerRef.value?.getScroll() ?? 0,
        }
      : {
          topLine: editorRef.value?.getTopLine() ?? 0,
          scrollTop: editorRef.value?.getScroll() ?? 0,
        }
  leaveView(handoff, position)
  touched()

  // 编辑态 → 任何视图：先把状态快照留下（含撤销栈），供下次进编辑态复用
  if (from !== 'read' && activeRef.value) {
    rememberState(handoff, activeRef.value.absolutePath, editorRef.value?.getState() ?? null)
    touched()
  }

  docMode.value = mode

  if (mode === 'read') {
    // 阅读视图要等正文渲染完成（高度稳定）才落位，由 onRendered 消费锚点
    return
  }
  void nextTick(() => {
    editorRef.value?.focus()
    /*
     * 编辑器在挂载时已经按 anchor 落过一次位（prop 读的是同一个值）。
     * 这里不再消费锚点——`takeAnchor` 只留给阅读侧；编辑器侧重复消费会把
     * 阅读视图下一次正常渲染的锚点也清掉。
     */
  })
}

/* ---------- 文件操作（目录树右键 / 工具条） ---------- */

/**
 * 剪贴板：只存「哪个工作区的哪一条」，不存内容。
 *
 * 为什么不用系统剪贴板：剪切 / 粘贴的语义是**移动**同一个文件，用系统剪贴板
 * 粘贴文本会把整篇文档塞进去；而跨工作区粘贴不该被允许（两边路径根不同，
 * 复制过去等于往别人的仓库里写）。所以这是应用内的一个引用，只在同工作区内有效。
 */
const clipboard = ref<{ workspaceId: string; relPath: string; mode: 'cut' | 'copy' } | null>(null)

const promptState = ref<{
  open: boolean
  title: string
  label: string
  initial: string
  confirmLabel: string
  suffix?: string
  onConfirm: ((value: string) => void) | null
}>({ open: false, title: '', label: '', initial: '', confirmLabel: '', onConfirm: null })

function askName(options: {
  title: string
  label: string
  initial: string
  confirmLabel: string
  suffix?: string
  onConfirm: (value: string) => void
}): void {
  promptState.value = { open: true, ...options }
}

function closePrompt(): void {
  promptState.value = { ...promptState.value, open: false, onConfirm: null }
}

function confirmPrompt(value: string): void {
  const run = promptState.value.onConfirm
  closePrompt()
  run?.(value)
}

/** 当前工作区 id：树操作只在这个工作区内生效 */
function treeWorkspaceId(): string | null {
  return activeTab.value?.workspaceId ?? null
}

/** 树节点的父目录（`a/b/c.md` → `a/b`；顶层 → 空串） */
function parentDirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash < 0 ? '' : relPath.slice(0, slash)
}

/** 名字最后一段（用于把相对路径还原成文件名） */
function baseNameOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash < 0 ? relPath : relPath.slice(slash + 1)
}

/**
 * 新建：文件或目录。
 *
 * 新建完直接打开文件——用户建一个空文档的目的就是写它，让他再去树里点一次
 * 是多余的步骤。目录建完只刷新树（没有可打开的东西）。
 */
function newEntry(kind: 'file' | 'dir', dirRelPath = ''): void {
  const workspaceId = treeWorkspaceId()
  if (!workspaceId) return
  askName({
    title: kind === 'file' ? t('tree.newFile') : t('tree.newDir'),
    label: t('dialog.name'),
    initial: '',
    confirmLabel: t('dialog.create'),
    suffix: kind === 'file' ? '.md' : undefined,
    onConfirm: async value => {
      const relPath = await store.createEntry(workspaceId, dirRelPath, value, kind)
      if (!relPath || kind !== 'file') return
      // 展开到新文件所在目录，否则它会出现折叠着的父目录里、看不见
      const dir = parentDirOf(relPath)
      if (dir) {
        const expanded = new Set(activeTab.value?.expanded ?? [])
        const segments = dir.split('/')
        for (let i = 1; i <= segments.length; i += 1) expanded.add(segments.slice(0, i).join('/'))
        tabs.setExpanded(activeTab.value?.id ?? '', [...expanded])
      }
      await openDoc(relPath)
    },
  })
}

/** 重命名：改名后如果这个文件正开着，把标签里的路径也一起换掉 */
async function renameEntry(relPath: string): Promise<void> {
  const workspaceId = treeWorkspaceId()
  if (!workspaceId) return
  askName({
    title: t('tree.rename'),
    label: t('dialog.renameLabel'),
    initial: baseNameOf(relPath),
    confirmLabel: t('dialog.rename'),
    onConfirm: async value => {
      const nextPath = await store.renameEntry(workspaceId, relPath, value)
      if (!nextPath) return
      tabs.replacePath(workspaceId, relPath, nextPath)
      // 已打开的记录按新路径重读，否则旧记录会挂在已经不存在的路径上
      if (documents.get(activeRef.value?.absolutePath ?? '')) {
        await reloadAfterMove(workspaceId, nextPath)
      }
    },
  })
}

/** 移动/复制/粘贴后，若目标正被打开则重新载入 */
async function reloadAfterMove(workspaceId: string, relPath: string): Promise<void> {
  const entry = store.workspaces.find(item => item.id === workspaceId)
  if (!entry) return
  const absolute = `${entry.root.replaceAll('\\', '/')}/${relPath}`
  if (!documents.get(absolute)) return
  const payload = await store.readDoc(workspaceId, relPath)
  if (payload) documents.load(payload)
}

/**
 * 剪切 / 复制到应用内剪贴板。
 *
 * 不立即动文件：剪切只记录意图，真正移动发生在粘贴时——「剪切后反悔」
 * 只要粘贴到原处即可，不会留下「已经删了但没粘」的危险窗口。
 */
function clipEntry(mode: 'cut' | 'copy', relPath: string): void {
  const workspaceId = treeWorkspaceId()
  if (!workspaceId) return
  clipboard.value = { workspaceId, relPath, mode }
  notice.value = mode === 'cut' ? t('tree.cutHint') : t('tree.copyHint')
  window.setTimeout(() => (notice.value = null), 2200)
}

/** 粘贴到某目录：剪切走 move，复制走 copy */
async function pasteInto(dirRelPath: string): Promise<void> {
  const clip = clipboard.value
  if (!clip) return
  const workspaceId = treeWorkspaceId()
  if (!workspaceId || workspaceId !== clip.workspaceId) {
    store.setError(t('tree.crossWorkspace'))
    return
  }
  const result =
    clip.mode === 'cut'
      ? await store.moveEntry(workspaceId, clip.relPath, dirRelPath)
      : await store.copyEntry(workspaceId, clip.relPath, dirRelPath)
  if (!result) return
  if (clip.mode === 'cut') clipboard.value = null
  await reloadAfterMove(workspaceId, result)
  notice.value = t('tree.pasted', { name: baseNameOf(result) })
  window.setTimeout(() => (notice.value = null), 2200)
}

/** 删除：进回收站，先问一句（文档是用户手写的内容） */
async function trashEntry(relPath: string): Promise<void> {
  const workspaceId = treeWorkspaceId()
  if (!workspaceId) return
  const choice = await askConfirm(
    t('tree.trashTitle'),
    t('tree.trashMessage', { name: baseNameOf(relPath) }),
    [{ id: 'trash', label: t('tree.trash'), tone: 'danger' }],
  )
  if (choice !== 'trash') return
  const ok = await store.trashEntry(workspaceId, relPath)
  if (!ok) return
  tabs.dropPath(workspaceId, relPath)
  notice.value = t('tree.trashed', { name: baseNameOf(relPath) })
  window.setTimeout(() => (notice.value = null), 2200)
}

/** 目录树右键菜单的总入口 */
function onTreeFsAction(action: TreeFsAction, path: string, dir: string): void {
  if (action === 'newFile') newEntry('file', dir)
  else if (action === 'newDir') newEntry('dir', dir)
  else if (action === 'rename') void renameEntry(path)
  else if (action === 'cut') clipEntry('cut', path)
  else if (action === 'copy') clipEntry('copy', path)
  else if (action === 'paste') void pasteInto(dir)
  else if (action === 'trash') void trashEntry(path)
}

/* ---------- 分屏：分隔条拖动 ---------- */

/**
 * 拖动分隔条改左右比例。
 *
 * 用指针捕获（setPointerCapture）而不是窗口级 mousemove：指针移出窗口、
 * 或者中途经过 iframe 时事件不会丢，松手也一定能收到 pointerup。
 */
function startSplitDrag(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement
  const container = handle.parentElement
  if (!container) return
  handle.setPointerCapture(event.pointerId)
  const rect = container.getBoundingClientRect()
  const onMove = (move: PointerEvent): void => {
    const ratio = (move.clientX - rect.left) / rect.width
    // 两侧各留三成：再窄就既读不了源码也看不全渲染结果
    splitRatio.value = Math.min(0.7, Math.max(0.3, ratio))
  }
  const onUp = (): void => {
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
}

/**
 * 分屏滚动同步：左侧源码是基准，右侧预览跟随。
 *
 * 方向只有一个（源码 → 预览）。反向会让打字时打架：用户在左侧输入、光标
 * 下移，若右侧滚动也回写左侧，光标会跟着跳。右侧仍可手动滚（看后面长什么样），
 * 下一次左侧滚动就重新对齐。
 *
 * 用比例而不是像素：两侧内容高度差很大（源码里一个块可能只有一行，渲染后
 * 是几十行表格），像素对齐会越滚越偏。
 */
const viewerRef = ref<InstanceType<typeof ReaderView> | null>(null)

function onEditorScrolled(payload: { topLine: number; ratio: number }): void {
  if (docMode.value !== 'split') return
  // 源行优先：两侧内容高度比例不同，百分比同步会随文档变长越滚越偏
  if (viewerRef.value?.scrollToSourceLine(payload.topLine)) return
  viewerRef.value?.scrollToRatio(payload.ratio)
}

/**
 * 分屏右侧渲染完成后：把右侧滚回左侧当前的相对位置。
 *
 * 必须有这一步：右侧重新渲染会把 scrollTop 归零，不补的话每次输入过后
 * 右窗格都会跳回顶部。
 */
function onSplitRendered(): void {
  if (docMode.value !== 'split') return
  const topLine = editorRef.value?.getTopLine() ?? 0
  if (viewerRef.value?.scrollToSourceLine(topLine)) return
  viewerRef.value?.scrollToRatio(editorRef.value?.getScrollRatio() ?? 0)
}

/* ---------- 拖放 ---------- */

async function onDrop(event: DragEvent): Promise<void> {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (!files.length) return
  const paths = window.docvi.pathsForFiles(files)
  if (!paths.length) {
    store.setError(t('error.dropPath'))
    return
  }
  const markdown = paths.find(path => /\.md$/i.test(path))
  if (markdown) {
    await openStandalone(markdown)
    return
  }
  store.setError(t('error.dropNotMarkdown'))
}

/* ---------- 命令 ---------- */

function registerCommands(): void {
  /**
   * 容器版不可用的命令 id。
   *
   * 这些动作全部依赖本地磁盘 / git / 本地服务进程，在读者面按了只会拿到
   * E_FORBIDDEN。不是「先隐藏再说」——命令面板是入口，留下一条必然失败的
   * 命令会让用户以为容器坏了。
   */
  const webHidden = new Set([
    'file.open',
    'workspace.add',
    'workspace.clone',
    'workspace.pull',
    'workspace.switchBranch',
    'doc.editLive',
    'doc.editSource',
    'doc.split',
    'doc.save',
    'doc.share',
    'doc.exportMarkdown',
    'doc.exportHtml',
    'doc.exportPdf',
    'app.service',
    'tab.copyPath',
  ])

  /**
   * 只在容器读者面出现的命令 id。
   *
   * 平台运维页、MCP 端点、本地 Markdown 预览都是部署器侧的入口，桌面端没有
   * 对应物——反过来隐藏，桌面版不该出现点了没反应的入口。
   */
  const webOnly = new Set(['app.ops', 'app.mcpCopy', 'app.localPreview'])
  const list = [
    {
      id: 'library.open',
      title: t('app.library'),
      keywords: 'library home 首页',
      group: t('group.general'),
      hint: 'Ctrl+1',
      run: () => goLibrary(),
    },
    {
      id: 'file.open',
      title: t('cmd.openFile'),
      keywords: 'open file markdown 文件',
      group: t('group.general'),
      hint: 'Ctrl+O',
      run: () => openFileDialog(),
    },
    {
      id: 'workspace.add',
      title: t('cmd.openFolder'),
      keywords: 'workspace folder 工作区 目录 文件夹',
      group: t('group.general'),
      run: () => addWorkspace(),
    },
    {
      id: 'workspace.clone',
      title: t('cmd.cloneRepo'),
      keywords: 'git clone repo clone 克隆 仓库',
      group: t('group.general'),
      run: () => openClone(),
    },
    {
      id: 'workspace.pull',
      title: t('cmd.pullWorkspace'),
      keywords: 'git pull fetch sync 拉取 更新 同步',
      group: t('group.general'),
      run: () => {
        const id = activeTab.value?.workspaceId ?? store.activeWorkspaceId
        if (id) void pullWorkspace(id)
      },
    },
    {
      id: 'workspace.switchBranch',
      title: t('cmd.switchBranch'),
      keywords: 'git branch checkout 分支 切换',
      group: t('group.general'),
      run: () => {
        const id = activeTab.value?.workspaceId ?? store.activeWorkspaceId
        if (id) openBranchDialog(id)
      },
    },
    {
      id: 'tab.close',
      title: t('tabmenu.close'),
      keywords: 'close tab 关闭 标签',
      group: t('group.tabs'),
      hint: 'Ctrl+W',
      run: () => {
        if (tabs.activeId) void closeTab(tabs.activeId)
      },
    },
    {
      id: 'tab.closeOthers',
      title: t('tabmenu.closeOthers'),
      keywords: 'close others 关闭其他',
      group: t('group.tabs'),
      run: () => {
        if (tabs.activeId) void closeOthers(tabs.activeId)
      },
    },
    {
      id: 'tab.closeRight',
      title: t('tabmenu.closeRight'),
      keywords: 'close right 关闭右侧',
      group: t('group.tabs'),
      run: () => {
        if (tabs.activeId) void closeRight(tabs.activeId)
      },
    },
    {
      id: 'tab.copyPath',
      title: t('tabmenu.copyPath'),
      keywords: 'copy path 复制 路径',
      group: t('group.tabs'),
      run: async () => {
        const ref = activeRef.value
        if (!ref) return
        try {
          await navigator.clipboard.writeText(ref.absolutePath)
        } catch {
          store.setError(t('error.clipboard'))
        }
      },
    },
    {
      id: 'tab.next',
      title: t('cmd.nextTab'),
      keywords: 'next tab 下一个标签',
      group: t('group.tabs'),
      hint: 'Ctrl+Tab',
      run: () => openSwitcher(),
    },
    {
      id: 'tab.settings',
      title: t('tabmenu.settings'),
      keywords: 'tab settings 标签页设置',
      group: t('group.tabs'),
      run: () => openSettings('tabs'),
    },
    {
      id: 'nav.back',
      title: t('cmd.back'),
      keywords: 'back history 后退 返回',
      group: t('group.document'),
      hint: 'Alt+←',
      run: () => stepHistory(-1),
    },
    {
      id: 'nav.forward',
      title: t('cmd.forward'),
      keywords: 'forward history 前进',
      group: t('group.document'),
      hint: 'Alt+→',
      run: () => stepHistory(1),
    },
    {
      id: 'view.contentWidth',
      title: t('cmd.toggleContentWidth'),
      keywords: 'width measure full 宽度 收窄 限宽 铺满 版心',
      group: t('group.appearance'),
      hint: 'Ctrl+Alt+W',
      run: () => toggleContentWidth(),
    },
    {
      id: 'outline.toggle',
      title: t('cmd.toggleOutline'),
      keywords: 'outline toc 大纲 目录',
      group: t('group.appearance'),
      hint: 'Ctrl+Alt+B',
      run: () => {
        if (outlineAvailable.value) showOutline.value = !showOutline.value
      },
    },
    {
      id: 'tree.toggle',
      title: t('cmd.toggleTree'),
      keywords: 'tree sidebar explorer 目录树 侧栏 折叠',
      group: t('group.appearance'),
      hint: 'Ctrl+B',
      run: () => {
        if (treeAvailable.value) showTree.value = !showTree.value
      },
    },
    {
      id: 'doc.editLive',
      title: t('cmd.editLive'),
      keywords: 'edit live preview 编辑 实时预览',
      group: t('group.document'),
      hint: 'Ctrl+E',
      run: () => setDocMode(docMode.value === 'read' ? 'live' : 'read'),
    },
    {
      id: 'doc.editSource',
      title: t('cmd.editSource'),
      keywords: 'edit source 源码 编辑',
      group: t('group.document'),
      run: () => setDocMode('source'),
    },
    {
      id: 'doc.split',
      title: t('cmd.split'),
      keywords: 'split preview 分屏 预览 并排 side',
      group: t('group.document'),
      hint: 'Ctrl+\\',
      run: () => setDocMode(docMode.value === 'split' ? 'read' : 'split'),
    },
    {
      id: 'doc.save',
      title: t('cmd.save'),
      keywords: 'save write 保存',
      group: t('group.document'),
      hint: 'Ctrl+S',
      run: () => (editing.value ? editorRef.value?.save() : undefined),
    },
    {
      id: 'doc.share',
      title: t('cmd.share'),
      keywords: 'share link 分享 链接',
      group: t('group.document'),
      run: () => void shareCurrentDoc(),
    },
    {
      id: 'doc.exportMarkdown',
      title: t('cmd.exportMarkdown'),
      keywords: 'export markdown download 导出 下载 源文件',
      group: t('group.document'),
      run: () => exportDoc('markdown'),
    },
    {
      id: 'doc.exportHtml',
      title: t('cmd.exportHtml'),
      keywords: 'export html webpage 导出 网页',
      group: t('group.document'),
      run: () => exportDoc('html'),
    },
    {
      id: 'doc.exportPdf',
      title: t('cmd.exportPdf'),
      keywords: 'export pdf print 导出 打印',
      group: t('group.document'),
      run: () => exportDoc('pdf'),
    },
    {
      id: 'app.shortcuts',
      title: t('cmd.shortcuts'),
      keywords: 'keys shortcut help 快捷键 帮助',
      group: t('group.help'),
      hint: 'Ctrl+/',
      run: () => {
        shortcutsOpen.value = true
      },
    },
    {
      id: 'app.settings',
      title: t('cmd.settings'),
      keywords: 'settings preferences 设置 偏好',
      group: t('group.general'),
      run: () => openSettings('general'),
    },
    {
      id: 'app.about',
      title: t('cmd.about'),
      keywords: 'about version update 关于 版本 更新',
      group: t('group.general'),
      run: () => openSettings('about'),
    },
    {
      id: 'app.plugins',
      title: t('cmd.plugins'),
      keywords: 'plugins extensions 插件 扩展',
      group: t('group.general'),
      run: () => openPlugins(),
    },
    {
      id: 'app.service',
      title: t('cmd.service'),
      keywords: 'mcp service share server 本地服务 分享 状态',
      group: t('group.general'),
      run: () => openSettings('service'),
    },
    {
      // 容器读者面：平台级运维页在站点根下，与壳同源；开新窗口不打断阅读
      id: 'app.ops',
      title: t('portal.ops'),
      keywords: 'ops admin deploy 运维 管理 仓库',
      group: t('group.general'),
      run: () => window.open('/_/admin', '_blank', 'noopener'),
    },
    {
      id: 'app.mcpCopy',
      title: t('portal.mcpTitle'),
      keywords: 'mcp ai client 接入 复制 地址',
      group: t('group.general'),
      run: async () => {
        try {
          await navigator.clipboard.writeText(`${location.origin}/mcp`)
          store.setError(t('portal.mcpCopied'))
        } catch {
          store.setError(t('error.clipboard'))
        }
      },
    },
    {
      // 本地预览的装载入口在文档库卡片上；命令面板给一条等价入口，方便键盘操作
      id: 'app.localPreview',
      title: t('portal.localTitle'),
      keywords: 'local preview markdown 本地 预览 拖入',
      group: t('group.general'),
      run: () => {
        goLibrary()
        nextTick(() => pickLocalFiles())
      },
    },
    {
      id: 'doc.find',
      title: t('cmd.find'),
      keywords: 'find search 查找 搜索',
      group: t('group.document'),
      hint: 'Ctrl+F',
      run: () => {
        readerRef.value?.openFind()
      },
    },
    {
      id: 'recent.clear',
      title: t('cmd.clearRecent'),
      keywords: 'recent clear 最近 清空',
      group: t('group.document'),
      run: () => store.clearRecent(),
    },
  ]
  for (const command of list) {
    if (isWebHost && webHidden.has(command.id)) continue
    if (!isWebHost && webOnly.has(command.id)) continue
    unregisters.push(register(command))
  }
  syncThemeCommands()
}

/**
 * 把「切到某套主题」注册成命令，一套主题一条。
 *
 * 为什么不是一条「切换主题」命令：主题超过两套之后，「切换」没有确定的下一站。
 * 拆成每套一条，命令面板里能直接搜名字跳过去（「纸张」「海岬」），
 * 也顺带让主题选择不依赖鼠标找下拉。
 *
 * 主题清单随插件启停变化，所以每次变化都要整体重建这批命令。
 */
const themeOptions = useThemeOptions()

function syncThemeCommands(): void {
  for (const off of themeCommandUnregisters) off()
  themeCommandUnregisters = themeOptions.value.map(option =>
    register({
      id: `theme.use.${option.id}`,
      title: t('cmd.useTheme', { name: option.title }),
      keywords: 'theme 主题 外观',
      group: t('group.appearance'),
      run: () => theme.setTheme(option.id),
    }),
  )
}

watch(themeOptions, syncThemeCommands)

// 命令标题里带主题名，切语言要重建成新语言
watch(locale, syncThemeCommands)

/* ---------- 导出 ---------- */

/**
 * 导出构建期注册表：与阅读视图同一套构造规则。
 *
 * 不复用 ReaderView 里那份实例——它随标签重建、且只包含当前文档相关的状态；
 * 导出需要的是一个干净的注册表。构造开销很小（只是 Map 填充）。
 */
function exportRegistry(): ComponentRegistry {
  const registry = new ComponentRegistry()
  const disabled = new Set(
    plugins.records.filter(record => !record.enabled || record.error).map(record => record.name),
  )
  for (const item of BUILTIN_KINDS) {
    if (disabled.has(item.plugin)) continue
    registry.register(item.kind, item.component, {
      title: item.title,
      description: item.description,
      packageName: item.plugin,
    })
  }
  return registry
}

/**
 * 导出当前文档。
 *
 * 读的是**缓冲区**（`documents.get(...).text`）而不是 `currentDoc.text`，
 * 后者可能是磁盘快照——用户刚改了没保存就导出，导出的必须是他看到的版本。
 */
async function exportDoc(format: ExportFormat): Promise<void> {
  const ref = activeRef.value
  if (!ref) {
    store.setError(t('error.noDocToExport'))
    return
  }
  const record = documents.get(ref.absolutePath)
  const text = record?.text ?? currentDoc.value?.text ?? ''
  if (!text) {
    store.setError(t('error.noDocToExport'))
    return
  }

  const title = record?.name || currentDoc.value?.title || ref.title || 'docvi'
  const rich = countRichComponents(text)

  let payload = text
  if (format === 'html' || format === 'pdf') {
    payload = await buildExportHtml({
      text,
      // 文档路径决定相对资源（图片）怎么解析：优先用 DocPayload 的 path，
      // 单文件时它是绝对路径，工作区内是库内相对路径，与阅读态渲染口径一致
      docPath: currentDoc.value?.path ?? ref.relPath,
      registry: exportRegistry(),
      containerSyntax: plugins.syntax.map(item => ({
        name: item.name,
        component: item.component,
        form: item.form,
      })),
      docTheme: theme.theme,
      title,
      locale: locale.value,
    })
  }

  const result = await window.docvi.docExport({
    format,
    suggestedName: suggestedName(title),
    text: payload,
    richComponents: rich,
  })
  if (!result.ok) {
    store.setError(result.error.message)
    return
  }
  if (result.data.canceled) return
  store.setError(exportNotice(format, result.data.path, rich, t))
}

/* ---------- 导航 ---------- */

/** 设置页分区深链（右键标签 → 标签页设置） */
type SettingsSection = 'general' | 'tabs' | 'service' | 'about'
const settingsSection = ref<SettingsSection>('general')

/**
 * 打开设置页标签（单例）。
 *
 * 设置不是「全局视图切换」而是**可关闭的应用页面标签**：这样标签条永远如实反映
 * 当前内容，不会出现「标签高亮文档库、画布却是设置页」的两处矛盾。
 */
function openSettings(section: SettingsSection = 'general'): void {
  settingsSection.value = section
  const result = tabs.openPage('settings', t('app.settings'))
  if (!result.tab) store.setError(result.rejected ?? t('error.tabLimit'))
}

/** 打开插件页标签（单例） */
function openPlugins(): void {
  const result = tabs.openPage('plugins', t('app.plugins'))
  if (!result.tab) store.setError(result.rejected ?? t('error.tabLimit'))
}

/**
 * 正文宽度切换（铺满 / 收窄）。
 *
 * 宽度是全局偏好而不是每标签状态：同一篇文档在阅读态和源码态必须一样宽，
 * 长期使用习惯也不该随标签变。写回 settings.json，重启后保留。
 */
function toggleContentWidth(): void {
  theme.contentWidth = theme.contentWidth === 'full' ? 'measure' : 'full'
}

/** 源码折行开关：改的是设置（settings.json），编辑器按 watch 重配隔间 */
function toggleEditorWrap(): void {
  theme.editorWrap = theme.editorWrap === 'wrap' ? 'nowrap' : 'wrap'
}

/** 插件启停代数：变化时强制重建 ReaderView，让组件注册表按新状态重建 */
const pluginEpoch = ref(0)

watch(
  () => plugins.records,
  async records => {
    await pluginThemes.load(records)
    theme.dropPluginThemes(key => !pluginThemes.themes.value.some(item => item.id === key))
    pluginEpoch.value += 1
  },
  { deep: true },
)

/* ---------- 标签条菜单 ---------- */

function onTabCommand(id: string, tabId: string): void {
  if (id === 'tab.close') void closeTab(tabId)
  else if (id === 'tab.closeOthers') void closeOthers(tabId)
  else if (id === 'tab.closeRight') void closeRight(tabId)
  else if (id === 'tab.closeAll') void closeAllTabs()
  else if (id === 'tab.copy') void copyTab(tabId)
  else if (id === 'tab.settings') {
    openSettings('tabs')
  } else if (id === 'tab.copyPath') {
    const ref = tabs.currentDocOf(tabId)
    if (ref) {
      void navigator.clipboard.writeText(ref.absolutePath).catch(() => {
        store.setError(t('error.clipboard'))
      })
    }
  }
}

/* ---------- 全局快捷键 ---------- */

function isMod(event: KeyboardEvent): boolean {
  return event.ctrlKey || event.metaKey
}

function onKeydown(event: KeyboardEvent): void {
  // Ctrl+Tab / Ctrl+Shift+Tab：浮层切换（按住期间循环，松手落地）
  if (event.ctrlKey && event.key === 'Tab') {
    event.preventDefault()
    if (switcher.value.open) cycleSwitcher(event.shiftKey ? -1 : 1)
    else if (event.shiftKey) {
      // 反向按下时初始也选 MRU 第二项，然后再后退一格
      openSwitcher()
      const items = switcherItems.value
      if (items.length) {
        switcher.value = {
          open: true,
          cursor: (switcher.value.cursor - 1 + items.length) % items.length,
        }
      }
    } else openSwitcher()
    return
  }
  // 浮层打开时 Esc 取消；其余键不拦（否则会吃掉方向键）
  if (switcher.value.open && event.key === 'Escape') {
    event.preventDefault()
    cancelSwitcher()
    return
  }
  if (paletteOpen.value || shortcutsOpen.value || confirmState.value.open) return

  if (isMod(event) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'b') {
    // 编辑器内的 Ctrl+B 是加粗，不能被面板开关抢走
    if ((event.target as HTMLElement | null)?.closest('.cm-editor')) return
    event.preventDefault()
    if (treeAvailable.value) showTree.value = !showTree.value
    return
  }
  if (isMod(event) && event.altKey && event.key.toLowerCase() === 'w') {
    event.preventDefault()
    toggleContentWidth()
    return
  }
  if (isMod(event) && event.altKey && event.key.toLowerCase() === 'b') {
    event.preventDefault()
    if (outlineAvailable.value) showOutline.value = !showOutline.value
    return
  }
  if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  if (isMod(event) && event.key === '/') {
    event.preventDefault()
    shortcutsOpen.value = true
    return
  }
  if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'f') {
    if (editing.value) return
    event.preventDefault()
    readerRef.value?.openFind()
    return
  }
  if (isMod(event) && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    void openFileDialog()
    return
  }
  if (isMod(event) && event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault()
    // 主题超过两套，「翻到下一套」没有明确语义；这个键改为直接展开选择器
    statusBarRef.value?.openThemeMenu()
    return
  }
  if (isMod(event) && !event.shiftKey && event.key.toLowerCase() === 'e') {
    event.preventDefault()
    if (!currentDoc.value) return
    setDocMode(docMode.value === 'read' ? 'live' : 'read')
    return
  }
  // Ctrl+\ ：分屏预览。与「源码模式」分开——它要同时看得见源码与结果
  if (isMod(event) && event.key === '\\') {
    event.preventDefault()
    if (!currentDoc.value) return
    setDocMode(docMode.value === 'split' ? 'read' : 'split')
    return
  }
  // Alt+←/→：标签内文档历史
  if (event.altKey && event.key === 'ArrowLeft') {
    event.preventDefault()
    void stepHistory(-1)
    return
  }
  if (event.altKey && event.key === 'ArrowRight') {
    event.preventDefault()
    void stepHistory(1)
    return
  }
  if (isMod(event) && event.key.toLowerCase() === 's') {
    if (!editing.value) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.cm-editor')) return
    event.preventDefault()
    void editorRef.value?.save()
    return
  }
  if (isMod(event) && event.key.toLowerCase() === 'w') {
    if (!tabs.activeId) return
    const tab = tabs.tabs.find(item => item.id === tabs.activeId)
    if (tab?.kind === 'library') return
    event.preventDefault()
    void closeTab(tabs.activeId)
  }
}

/** 松开 Ctrl 才落地：这是 WebStorm 手感的核心（按住预览、松手切换） */
function onKeyup(event: KeyboardEvent): void {
  if (event.key === 'Control' && switcher.value.open) {
    void commitSwitcher()
  }
}
/** 窗口失焦时兜底落地：切到别的应用再回来，浮层不应该挂在屏幕上 */
function onWindowBlur(): void {
  if (switcher.value.open) void commitSwitcher()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onWindowBlur)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  window.removeEventListener('blur', onWindowBlur)
})
</script>

<template>
  <div class="shell" @dragover.prevent @drop.prevent="onDrop">
    <TitleBar
      :tree-available="treeAvailable"
      :tree-visible="showTree"
      :outline-available="outlineAvailable"
      :outline-visible="showOutline"
      @open-palette="paletteOpen = true"
      @open-settings="openSettings('general')"
      @open-plugins="openPlugins"
      @toggle-tree="showTree = !showTree"
      @toggle-outline="showOutline = !showOutline"
    />

    <!--
      组件预览是独立视图：不挂标签栏。它不属于任何标签（从运维页跳进来、看完
      就回），把整条标签栏摆在上面会让读者以为这是「又一个文档标签」，还会
      顶掉本来就有的标签高亮。
    -->
    <TabBar
      v-if="view !== 'preview'"
      ref="tabBarRef"
      :tabs="tabs.tabs"
      :active-id="tabs.activeId"
      :max-width="tabs.preferences.maxWidth"
      :wrap="tabs.preferences.layout === 'wrap'"
      :overflow-x="tabs.preferences.overflowX"
      :dirty="dirty"
      @activate="activateTab"
      @close="closeTab"
      @command="onTabCommand"
      @switcher="openSwitcher"
      @reorder="onTabReorder"
    />

    <div class="shell__body">
      <aside v-if="showSidebar" class="sidebar">
        <GitBar
          v-if="activeWorkspaceGit && !isWebHost"
          :git="activeWorkspaceGit"
          :busy="pullBusy === activeTab?.workspaceId"
          @switch-branch="openBranchDialog(activeTab?.workspaceId ?? '')"
          @pull="pullWorkspace(activeTab?.workspaceId ?? '')"
        />
        <!--
          容器读者面：分支选择器放在侧栏顶部。
          读者翻到一半想换个分支对照着看，不该被赶回首页——这里与文档库卡片
          上是同一个组件、同一份数据。
        -->
        <div v-if="isWebHost && activePortalWorkspace" class="sidebar__branch">
          <BranchPicker
            :workspace="activePortalWorkspace"
            :current="readBranch()"
            @select="selectBranch({ slug: activeTab?.workspaceId ?? '', branch: $event })"
          />
        </div>
        <!--
          工作区级新建入口：即便目录树为空（空工作区）也必须有地方新建第一篇
          文档，否则只能去磁盘上手工建文件再回来。所以工具条放在空状态之外。
          容器版文档只读，这一组入口整体不出现。
        -->
        <div v-if="activeTab?.workspaceId && !isReadOnlyHost" class="tree-tools">
          <button
            v-tooltip="t('tree.newFile')"
            class="tree-tools__btn"
            type="button"
            :aria-label="t('tree.newFile')"
            @click="newEntry('file')"
          >
            <FilePlus2 :size="13" :stroke-width="1.8" />
          </button>
          <button
            v-tooltip="t('tree.newDir')"
            class="tree-tools__btn"
            type="button"
            :aria-label="t('tree.newDir')"
            @click="newEntry('dir')"
          >
            <FolderPlus :size="13" :stroke-width="1.8" />
          </button>
        </div>
        <div v-if="!store.tree.length" class="sidebar__empty">{{ t('empty.tree') }}</div>
        <DocTree
          v-else
          :nodes="store.tree"
          :selected-path="activeRef?.relPath ?? null"
          :expanded="activeTab?.expanded ?? []"
          :scope-label="activeScopeLabel"
          :can-paste="clipboard !== null"
          :readonly="isReadOnlyHost"
          @open="openDoc"
          @open-new-tab="openDocNewTab"
          @update-expanded="tabs.setExpanded(activeTab?.id ?? '', $event)"
          @fs-action="onTreeFsAction"
        />
      </aside>

      <main class="canvas">
        <PreviewPage
          v-if="view === 'preview' && previewRoute"
          :plugin="previewRoute.plugin"
          :kind="previewRoute.kind"
        />
        <LibraryView
          v-else-if="view === 'library'"
          ref="libraryRef"
          :workspaces="store.workspaces"
          :active-id="store.activeWorkspaceId"
          :recent="store.recent"
          :readonly="isReadOnlyHost"
          :loading="store.loading"
          :branch-of="readBranch"
          @add="addWorkspace"
          @clone="openClone"
          @open="openWorkspaceTab"
          @remove="removeWorkspace"
          @switch-branch="openBranchDialog"
          @pull="pullWorkspace"
          @share="shareWorkspace"
          @open-file="openFileDialog"
          @open-recent="openRecent"
          @clear-recent="store.clearRecent()"
          @select-branch="selectBranch"
          @local-preview="loadLocalPreview"
          @copy-mcp="() => undefined"
        />
        <PluginsView v-else-if="view === 'plugins'" :readonly="isReadOnlyHost" />
        <SettingsView
          v-else-if="view === 'settings'"
          :section="settingsSection"
          :readonly="isReadOnlyHost"
          @open-section="settingsSection = $event"
        />
        <div v-else-if="activeTab?.kind === 'file' && !currentDoc" class="canvas__empty">
          {{ t('file.outsideHint') }}
        </div>
        <!--
          分屏：左源码 + 右渲染。
          两块共用同一个文档缓冲区（documents store），所以左侧打字右侧立刻能看到
          语义结果；右侧只挂阅读视图，不挂 CM6——同一份文档开两个编辑器实例会让
          撤销栈与光标互相打架。
        -->
        <div v-else-if="docMode === 'split' && currentDoc" class="split">
          <div class="split__pane" :style="{ flexBasis: `${splitRatio * 100}%` }">
            <EditorView
              ref="editorRef"
              :absolute-path="currentDoc.absolutePath"
              mode="source"
              :doc-theme="theme.theme"
              :wrap="theme.editorWrap === 'wrap'"
              :workspace-id="activeTab?.workspaceId ?? null"
              :doc-path="currentDoc.path"
              :initial-state="currentEditorState"
              :restore-to-line="restoreAnchor"
              @error="store.setError($event)"
              @saved="onEditorSaved"
              @scrolled="onEditorScrolled"
              @state-snapshot="rememberEditorState"
              @restored="consumeAnchor"
            />
          </div>
          <div
            class="split__divider"
            role="separator"
            aria-orientation="vertical"
            :aria-valuenow="Math.round(splitRatio * 100)"
            tabindex="0"
            @pointerdown="startSplitDrag"
            @keydown.left.prevent="splitRatio = Math.max(0.3, splitRatio - 0.05)"
            @keydown.right.prevent="splitRatio = Math.min(0.7, splitRatio + 0.05)"
          />
          <div class="split__pane split__pane--preview">
            <ReaderView
              ref="viewerRef"
              :key="`split-${pluginEpoch}-${activeTab?.id ?? ''}`"
              :doc="splitDoc"
              :doc-theme="theme.theme"
              :link-prefix="docLinkPrefix"
              :asset-prefix="docAssetPrefix"
              source-lines
              @outline="outline = $event"
              @error="store.setError($event)"
              @rendered="onSplitRendered"
            />
          </div>
        </div>
        <ReaderView
          v-else-if="!editing"
          :key="`${pluginEpoch}-${activeTab?.id ?? ''}`"
          ref="readerRef"
          :doc="currentDoc"
          :doc-theme="theme.theme"
          :show-tree-hint="activeTab?.kind === 'file'"
          :link-prefix="docLinkPrefix"
          :asset-prefix="docAssetPrefix"
          @outline="outline = $event"
          @error="store.setError($event)"
          @pick-file="openFileDialog"
          @share="shareCurrentDoc"
          @navigate="onContentNavigate"
          @rendered="onRendered"
        />
        <EditorView
          v-else-if="currentDoc"
          ref="editorRef"
          :absolute-path="currentDoc.absolutePath"
          :mode="docMode === 'source' ? 'source' : 'live'"
          :doc-theme="theme.theme"
          :wrap="theme.editorWrap === 'wrap'"
          :doc-path="currentDoc.path"
          :asset-prefix="docAssetPrefix"
          :workspace-id="activeTab?.workspaceId ?? null"
          :initial-state="currentEditorState"
          :restore-to-line="restoreAnchor"
          @error="store.setError($event)"
          @saved="onEditorSaved"
          @state-snapshot="rememberEditorState"
          @restored="consumeAnchor"
        />
      </main>

      <OutlinePanel v-if="showOutlinePanel" :entries="outline" scroll-selector=".reader" />
    </div>

    <StatusBar
      ref="statusBarRef"
      :doc="currentDoc"
      :workspace-root="store.activeWorkspace?.root ?? null"
      :doc-theme="theme.theme"
      :mode="docMode"
      :dirty="dirty"
      :service-running="service.running"
      :service-port="service.state?.port ?? null"
      :content-width="theme.contentWidth"
      :editor-wrap="theme.editorWrap"
      :readonly="isReadOnlyHost"
      @select-theme="theme.setTheme($event)"
      @set-mode="setDocMode"
      @open-service="openSettings('service')"
      @toggle-content-width="toggleContentWidth()"
      @toggle-editor-wrap="toggleEditorWrap()"
    />

    <CommandPalette
      :open="paletteOpen"
      :active-workspace-id="activeTab?.workspaceId ?? store.activeWorkspaceId"
      :workspace-names="workspaceNames"
      @close="paletteOpen = false"
      @open-doc="openDoc"
      @open-doc-in-workspace="openDocInWorkspace"
    />
    <ShortcutsPanel :open="shortcutsOpen" @close="shortcutsOpen = false" />
    <TabSwitcher
      :open="switcher.open"
      :items="switcherItems"
      :cursor="switcher.cursor"
      @select="
        (id: string) => {
          if (id) void activateTab(id)
          cancelSwitcher()
        }
      "
      @hover="switcher.cursor = $event"
    />
    <ConfirmDialog
      :open="confirmState.open"
      :title="confirmState.title"
      :message="confirmState.message"
      :actions="confirmState.actions"
      @close="resolveConfirm('cancel')"
      @choose="resolveConfirm"
    />

    <PromptDialog
      :open="promptState.open"
      :title="promptState.title"
      :label="promptState.label"
      :initial="promptState.initial"
      :confirm-label="promptState.confirmLabel"
      :suffix="promptState.suffix"
      @confirm="confirmPrompt"
      @close="closePrompt"
    />

    <ContentRootDialog
      :open="candidateState.open"
      :root="candidateState.root"
      :candidates="candidateState.candidates"
      @choose="pickCandidate"
      @keep="keepPickedRoot"
      @close="candidateState = { open: false, root: '', candidates: [] }"
    />

    <CloneRepoDialog
      :open="cloneOpen"
      :git="store.gitState"
      @done="onCloned"
      @close="cloneOpen = false"
    />

    <BranchDialog
      :open="!!branchWorkspace"
      :workspace="branchWorkspace"
      @switched="onBranchSwitched"
      @close="branchWorkspace = null"
    />

    <div v-if="notice" class="notice" role="status" aria-live="polite">
      <CheckCircle2 :size="15" :stroke-width="1.8" aria-hidden="true" />
      <span class="notice__text">{{ notice }}</span>
    </div>

    <!--
      分享结果提示条：链接必须当场可见可复制。
      跳去设置页看列表是反的——用户点「分享」要的是这条链接，不是分享管理页。
    -->
    <div v-if="shareToast" class="share-toast" role="status" aria-live="polite">
      <Link2 :size="14" :stroke-width="1.8" aria-hidden="true" class="share-toast__icon" />
      <div class="share-toast__main">
        <span class="share-toast__title">
          {{ shareToast.localOnly ? t('share.lanOnlyHint') : t('share.toastTitle') }}
        </span>
        <input
          class="share-toast__url"
          type="text"
          readonly
          :value="shareToast.url"
          @focus="($event.target as HTMLInputElement).select()"
        />
      </div>
      <button class="share-toast__btn" type="button" @click="copyShareUrl">
        {{ shareToast.copied ? t('settings.copied') : t('settings.copy') }}
      </button>
      <button
        class="share-toast__close"
        type="button"
        :aria-label="t('shortcuts.close')"
        @click="shareToast = null"
      >
        <X :size="13" :stroke-width="2" />
      </button>
    </div>

    <div v-if="store.error" class="toast" role="alert" aria-live="assertive">
      <AlertCircle :size="15" :stroke-width="1.8" aria-hidden="true" />
      <span class="toast__text">{{ store.error }}</span>
      <button
        class="toast__close"
        type="button"
        :aria-label="t('shortcuts.close')"
        @click="store.setError(null)"
      >
        <X :size="13" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.shell {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--dv-ui-bg);
}

.shell__body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.sidebar {
  width: var(--dv-ui-sidebar-w);
  flex: none;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--dv-ui-surface-1);
  border-right: 1px solid var(--dv-ui-line-soft);
}

.sidebar__empty {
  padding: 18px 16px;
  font-size: 12px;
  color: var(--dv-ui-text-dim);
}

/* 容器读者面的分支条：贴在侧栏顶部，与目录树共用一条分隔线 */
.sidebar__branch {
  display: flex;
  align-items: center;
  padding: 6px 8px;
  border-bottom: 1px solid var(--dv-ui-line-soft);
}

/*
 * 目录树工具条：新建文档 / 新建目录。
 * 靠右放，让它在树顶部不抢「工作区名」的位置；只在有工作区时出现。
 */
.tree-tools {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  padding: 4px 8px 0;
}

.tree-tools__btn {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: var(--dv-ui-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
  transition:
    background var(--dv-ui-dur-1) var(--dv-ui-ease),
    color var(--dv-ui-dur-1) var(--dv-ui-ease);
}

.tree-tools__btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.canvas {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.canvas > * {
  height: 100%;
}

/*
 * 分屏：左右两块各自滚动，分隔条可拖动。
 * 用 flex-basis 表达比例而不是 width，右侧才能自动吃掉剩余宽度。
 */
.split {
  display: flex;
  height: 100%;
  min-height: 0;
}

.split__pane {
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.split__pane--preview {
  flex: 1 1 auto;
  border-left: 1px solid var(--dv-ui-line-soft);
}

/*
 * 分屏里的阅读页要收内边距。
 *
 * 单栏时 40px/32px 是给整窗留的呼吸；但分屏后这块只剩半屏宽，
 * 同样的内边距会吃掉近一成可用宽度，正文被压得比左侧源码还窄。
 */
.split__pane--preview :deep(.reader__page) {
  padding: 28px 22px 64px;
}

.split__divider {
  flex: none;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  position: relative;
}

.split__divider:hover,
.split__divider:focus-visible {
  background: color-mix(in srgb, var(--dv-ui-accent) 30%, transparent);
  outline: none;
}

.canvas__empty {
  display: grid;
  place-items: center;
  font-size: 12.5px;
  color: var(--dv-ui-text-dim);
}

.toast {
  position: fixed;
  right: 16px;
  bottom: calc(var(--dv-ui-statusbar-h) + 14px);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 460px;
  padding: 9px 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
  font-size: 12.5px;
  color: var(--dv-ui-text);
}

.toast__close {
  margin-left: 4px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

/* 成功提示与错误提示同位置但不抢焦点：错误用红色图标、成功用强调色，形状一致。
   高度上抬一格，两者同时出现时不叠在一起。 */
.notice {
  position: fixed;
  right: 16px;
  bottom: calc(var(--dv-ui-statusbar-h) + 62px);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 460px;
  padding: 9px 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
  font-size: 12.5px;
  color: var(--dv-ui-text);
}

.notice > svg {
  flex: none;
  color: var(--dv-ui-accent);
}

.notice__text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/*
 * 分享提示条：堆叠顺序 = 错误提示 > 分享条 > 成功提示。
 * 分享条要长期停留（用户可能要复制好几次），所以给足宽度、链接可选中，
 * 并单独占位而不是与 toast 抢同一个角落。
 */
.share-toast {
  position: fixed;
  right: 16px;
  bottom: calc(var(--dv-ui-statusbar-h) + 110px);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  width: min(520px, calc(100vw - 32px));
  padding: 10px 12px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-radius-md);
  background: var(--dv-ui-surface-2);
  box-shadow: var(--dv-ui-shadow-2);
}

.share-toast__icon {
  flex: none;
  color: var(--dv-ui-accent);
}

.share-toast__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.share-toast__title {
  font-size: 11.5px;
  color: var(--dv-ui-text-muted);
}

.share-toast__url {
  width: 100%;
  height: 24px;
  padding: 0 7px;
  border: 1px solid var(--dv-ui-line-soft);
  border-radius: var(--dv-radius-sm);
  background: var(--dv-ui-surface-1);
  color: var(--dv-ui-text-2);
  font-family: var(--dv-font-mono, ui-monospace, monospace);
  font-size: 11px;
}

.share-toast__url:focus {
  outline: none;
  border-color: var(--dv-ui-accent);
}

.share-toast__btn {
  flex: none;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--dv-ui-line);
  border-radius: var(--dv-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-2);
  font-size: 11.5px;
  cursor: pointer;
}

.share-toast__btn:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}

.share-toast__close {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--dv-radius-sm);
  background: transparent;
  color: var(--dv-ui-text-dim);
  cursor: pointer;
}

.share-toast__close:hover {
  background: var(--dv-ui-surface-3);
  color: var(--dv-ui-text);
}
</style>
