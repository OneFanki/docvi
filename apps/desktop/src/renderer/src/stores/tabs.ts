import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import type { TabPreferences } from '@docvi/shared'

/**
 * 标签页模型 v2：一个标签 = 一个独立工作现场。
 *
 * 三条与旧模型（全局扁平文档标签）的本质区别：
 *  1. 标签属于**工作区**（或单文件），标签内部的文档切换不会跨到别的工作区；
 *  2. 标签内部有自己的**文档历史**，所以「点两篇文档」是替换而不是堆标签，
 *     同时还能前后来回（Alt+←/→）；
 *  3. 文档库是钉住的首页标签，从它打开工作区 = 新建标签（点两次 = 两个标签，不去重）。
 *
 * 持久化到 `session.json`（不是 settings.json）：标签是窗口状态，不该进配置导出。
 */

/**
 * 标签类型。
 *
 * library / workspace / file 是「文档现场」；settings / plugins 是**应用页面**。
 * 应用页面也走标签，而不是像旧版那样用一个独立视图状态：
 *  - 否则标签条会高亮着「文档库」而画布显示设置页，等于两处都说自己是对的；
 *  - 页面标签是**单例**（同一页面只会有一个），点第二次就激活它。
 */
export type TabKind = 'library' | 'workspace' | 'file' | 'settings' | 'plugins'

/** 应用页面标签（不属于任何工作区、没有文档历史） */
export type PageTabKind = 'settings' | 'plugins'

export function isPageKind(kind: TabKind): kind is PageTabKind {
  return kind === 'settings' || kind === 'plugins'
}

/** 标签内的一个文档位置（历史栈的条目） */
export interface DocRef {
  /** `workspace:<wsId>:<relPath>` 或 `file:<绝对路径小写>` */
  key: string
  workspaceId: string | null
  relPath: string
  absolutePath: string
  title: string
  /** 这一篇读到哪里了 */
  scrollY: number
}

export interface TabRecord {
  id: string
  kind: TabKind
  /** workspace 标签所属工作区；library / file / 应用页面 为 null */
  workspaceId: string | null
  /** 显示用的作用域名：工作区名或文件名（应用页面用固定文案） */
  scopeLabel: string
  /** 文档历史（library 与应用页面标签恒为空） */
  history: DocRef[]
  /** 当前在历史的哪一项；-1 表示还没打开任何文档 */
  historyIndex: number
  /** file 标签的绝对路径（其余为 null） */
  absolutePath: string | null
  /** 目录树展开状态（每个标签独立） */
  expanded: string[]
  /** 是否已按「顶层目录默认展开」播种过（用户手动折叠后不再重置） */
  expandedSeeded: boolean
  createdAt: number
  lastActiveAt: number
}

export const TAB_SESSION_VERSION = 2
const LEGACY_KEY = 'docvi.tabs.v1'
const MAX_HISTORY = 50

let seq = 0
function newId(): string {
  seq += 1
  return `t${Date.now().toString(36)}${seq.toString(36)}`
}

export function docKeyOf(
  workspaceId: string | null,
  absolutePath: string,
  relPath: string,
): string {
  // Windows 路径大小写不敏感：统一小写，否则同一文件会攒出多个标签/历史项
  return workspaceId ? `workspace:${workspaceId}:${relPath}` : `file:${absolutePath.toLowerCase()}`
}

function currentDocOf(tab: TabRecord): DocRef | null {
  return tab.history[tab.historyIndex] ?? null
}

/** 标签标题需要的固定文案（由视图层按当前语言传入） */
export interface TabLabels {
  library: string
  settings: string
  plugins: string
}

/**
 * 标签标题。
 *
 * 标签上只显示**文档名**：标签是拿来扫读「我在看哪篇」的，前面再挂一段工作区名
 * （或更糟，工作区 id）会把真正要找的信息挤掉。工作区身份显示在标签内的树顶部。
 *
 * `scope` 仍然返回给 tooltip 与切换浮层用，但绝不参与主标题——尤其不能拿
 * workspaceId 当兜底文本：那串 12 位哈希曾原样出现在标签上。
 */
export function tabTitleOf(
  tab: TabRecord,
  labels: TabLabels,
): { scope: string; doc: string | null; label: string } {
  if (tab.kind === 'library') {
    return { scope: labels.library, doc: null, label: labels.library }
  }
  if (tab.kind === 'settings' || tab.kind === 'plugins') {
    const label = tab.kind === 'settings' ? labels.settings : labels.plugins
    return { scope: label, doc: null, label }
  }
  const doc = currentDocOf(tab)
  const docTitle = doc?.title?.trim() || null
  return { scope: tab.scopeLabel, doc: docTitle, label: docTitle ?? tab.scopeLabel }
}

/** 12 位十六进制 = workspaceId 的形状（见主进程 workspaceAdd 的 id 生成） */
const WORKSPACE_ID_SHAPE = /^[0-9a-f]{12}$/i

/** 标签上的作用域名是否可信（空串与哈希都不是真实名字） */
export function isRealScopeLabel(label: string): boolean {
  return Boolean(label) && !WORKSPACE_ID_SHAPE.test(label)
}

interface Persisted {
  schemaVersion: number
  activeId: string | null
  tabs: TabRecord[]
  mru: string[]
}

function normalizeDocRef(value: unknown): DocRef | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.key !== 'string' || typeof raw.absolutePath !== 'string') return null
  return {
    key: raw.key,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
    relPath: typeof raw.relPath === 'string' ? raw.relPath : '',
    absolutePath: raw.absolutePath,
    title:
      typeof raw.title === 'string'
        ? raw.title
        : typeof raw.relPath === 'string'
          ? raw.relPath
          : raw.absolutePath,
    scrollY: Number(raw.scrollY) || 0,
  }
}

function normalizeTab(value: unknown): TabRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string') return null
  const kind = raw.kind
  if (
    kind !== 'library' &&
    kind !== 'workspace' &&
    kind !== 'file' &&
    kind !== 'settings' &&
    kind !== 'plugins'
  ) {
    return null
  }
  const history = Array.isArray(raw.history)
    ? raw.history.map(normalizeDocRef).filter((item): item is DocRef => item !== null)
    : []
  const index = Number(raw.historyIndex)
  return {
    id: raw.id,
    kind,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
    scopeLabel: typeof raw.scopeLabel === 'string' ? raw.scopeLabel : '',
    history,
    historyIndex:
      history.length === 0
        ? -1
        : Math.min(Math.max(0, Number.isFinite(index) ? index : 0), history.length - 1),
    absolutePath: typeof raw.absolutePath === 'string' ? raw.absolutePath : null,
    expanded: Array.isArray(raw.expanded)
      ? raw.expanded.filter((item): item is string => typeof item === 'string')
      : [],
    expandedSeeded: raw.expandedSeeded === true,
    createdAt: Number(raw.createdAt) || Date.now(),
    lastActiveAt: Number(raw.lastActiveAt) || Date.now(),
  }
}

/**
 * 恢复会话。
 *
 * v1（全局文档标签）→ v2 迁移：把每个 doc 标签转成一个 workspace 标签
 * （各自带一篇文档），这样升级后原来的阅读现场还在，只是变成了「每文档一标签」——
 * 这是旧模型语义下能还原的最大信息量。
 */
function restoreSession(raw: unknown): Persisted | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (Number(data.schemaVersion) === TAB_SESSION_VERSION && Array.isArray(data.tabs)) {
    const tabs = data.tabs.map(normalizeTab).filter((item): item is TabRecord => item !== null)
    if (!tabs.length) return null
    const mru = Array.isArray(data.mru)
      ? data.mru.filter((item): item is string => typeof item === 'string')
      : []
    const activeId =
      typeof data.activeId === 'string' && tabs.some(tab => tab.id === data.activeId)
        ? data.activeId
        : (tabs[0]?.id ?? null)
    return { schemaVersion: TAB_SESSION_VERSION, activeId, tabs, mru }
  }
  return null
}

function migrateLegacy(): Persisted | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { tabs?: unknown[] }
    const tabs = Array.isArray(data.tabs) ? data.tabs : []
    const converted: TabRecord[] = []
    for (const item of tabs) {
      const tab = item as Record<string, unknown>
      if (!tab || typeof tab !== 'object') continue
      if (tab.kind === 'root') continue
      const source = tab.source as Record<string, unknown> | undefined
      if (!source || typeof source.absolutePath !== 'string') continue
      const ref = normalizeDocRef({
        key: source.key,
        workspaceId: source.workspaceId ?? null,
        relPath: source.relPath ?? '',
        absolutePath: source.absolutePath,
        title: tab.title ?? '',
        scrollY: tab.scrollY ?? 0,
      })
      if (!ref) continue
      const isFile = ref.workspaceId === null
      converted.push({
        id: newId(),
        kind: isFile ? 'file' : 'workspace',
        workspaceId: ref.workspaceId,
        scopeLabel: isFile
          ? (ref.absolutePath.split(/[/\\]/).pop() ?? '').replace(/\.md$/i, '')
          : '',
        history: [ref],
        historyIndex: 0,
        absolutePath: isFile ? ref.absolutePath : null,
        expanded: [],
        expandedSeeded: false,
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      })
    }
    localStorage.removeItem(LEGACY_KEY)
    if (!converted.length) return null
    return {
      schemaVersion: TAB_SESSION_VERSION,
      activeId: converted[0]?.id ?? null,
      tabs: converted,
      mru: converted.map(tab => tab.id),
    }
  } catch {
    return null
  }
}

export interface OpenResult {
  tab: TabRecord | null
  /** 被拒绝时的可读原因（达到上限且全是脏标签） */
  rejected?: string
  /** 因上限被自动关闭的标签（调用方需清理其草稿外的内存状态） */
  evicted?: string[]
}

/**
 * 标签存储。
 *
 * 关于「脏标签」：store 不持有文档缓冲区，所以上限策略需要的「是否有未保存修改」
 * 由调用方通过 `isDirty(tab)` 注入——这样标签模型与文档模型保持解耦。
 */
export const useTabsStore = defineStore('tabs', () => {
  const restored = migrateLegacy()
  const tabs = ref<TabRecord[]>(restored?.tabs ?? [])
  const activeId = ref<string | null>(restored?.activeId ?? null)
  const mru = ref<string[]>(restored?.mru ?? [])
  /** 上限策略（由 App 从设置同步进来） */
  const preferences = ref<TabPreferences>({
    maxTabs: 0,
    overflow: 'least-recent',
    layout: 'single',
    overflowX: 'scroll',
    maxWidth: 200,
  })
  /** 注入的脏检查（App 提供） */
  let dirtyCheck: (tab: TabRecord) => boolean = () => false

  const activeTab = computed(() => tabs.value.find(tab => tab.id === activeId.value) ?? null)
  const activeDoc = computed(() => {
    const tab = activeTab.value
    return tab ? currentDocOf(tab) : null
  })
  /** 文档库标签：恒在首位 */
  const libraryTab = computed(() => tabs.value.find(tab => tab.kind === 'library') ?? null)
  const workspaceTabs = computed(() => tabs.value.filter(tab => tab.kind !== 'library'))

  function setDirtyCheck(check: (tab: TabRecord) => boolean): void {
    dirtyCheck = check
  }

  function setPreferences(next: TabPreferences): void {
    preferences.value = next
  }

  function touchMru(id: string): void {
    mru.value = [id, ...mru.value.filter(item => item !== id)]
  }

  function activate(id: string): void {
    const tab = tabs.value.find(item => item.id === id)
    if (!tab) return
    tab.lastActiveAt = Date.now()
    activeId.value = id
    if (tab.kind !== 'library') touchMru(id)
  }

  /** 文档库标签：不存在则创建（启动调用一次），永远第一位 */
  function ensureLibrary(label = '文档库'): TabRecord {
    const existing = tabs.value.find(tab => tab.kind === 'library')
    if (existing) {
      if (existing.scopeLabel !== label) existing.scopeLabel = label
      // 文档库必须在首位：从会话恢复的顺序可能被打乱
      if (tabs.value[0]?.id !== existing.id) {
        tabs.value = [existing, ...tabs.value.filter(tab => tab.id !== existing.id)]
      }
      if (!activeId.value) activeId.value = existing.id
      return existing
    }
    const tab: TabRecord = {
      id: newId(),
      kind: 'library',
      workspaceId: null,
      scopeLabel: label,
      history: [],
      historyIndex: -1,
      absolutePath: null,
      expanded: [],
      expandedSeeded: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    tabs.value = [tab, ...tabs.value]
    if (!activeId.value) activeId.value = tab.id
    return tab
  }

  /**
   * 上限策略：需要腾位置时返回被关闭的标签 id。
   *
   * 规则：
   *  - maxTabs = 0 → 不限，永远允许；
   *  - 优先关「脏标签之外」的候选；全是脏标签 → 拒绝（不能静默丢用户修改）；
   *  - overflow = 'reject' → 直接拒绝。
   */
  function makeRoom(): { allowed: boolean; evicted: string[]; rejected?: string } {
    const limit = preferences.value.maxTabs
    if (!limit || tabs.value.length < limit) return { allowed: true, evicted: [] }
    if (preferences.value.overflow === 'reject') {
      return {
        allowed: false,
        evicted: [],
        rejected: `已达到标签页上限（${limit}），可在设置中调整`,
      }
    }
    const candidates = tabs.value.filter(tab => tab.kind !== 'library' && !dirtyCheck(tab))
    if (!candidates.length) {
      return {
        allowed: false,
        evicted: [],
        rejected: '已达到标签页上限，且所有标签都有未保存修改',
      }
    }
    const victim =
      preferences.value.overflow === 'oldest'
        ? [...candidates].sort((a, b) => a.createdAt - b.createdAt)[0]
        : [...candidates].sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
    if (!victim) return { allowed: false, evicted: [], rejected: '无法腾出标签位置' }

    tabs.value = tabs.value.filter(tab => tab.id !== victim.id)
    mru.value = mru.value.filter(item => item !== victim.id)
    if (activeId.value === victim.id) {
      activeId.value = libraryTab.value?.id ?? tabs.value[0]?.id ?? null
    }
    return { allowed: true, evicted: [victim.id] }
  }

  /**
   * 打开应用页面标签（设置 / 插件）。
   *
   * **单例**：同一页面永远只有一个标签，再点就是激活它。应用页面没有「同一页面
   * 开两份」的需求，重复开只会把标签条撑满。这与工作区标签「不去重」是两种语义，
   * 别混：工作区是工作现场，页面是全局工具。
   */
  function openPage(kind: PageTabKind, label: string): OpenResult {
    const existing = tabs.value.find(tab => tab.kind === kind)
    if (existing) {
      if (label && existing.scopeLabel !== label) existing.scopeLabel = label
      activate(existing.id)
      return { tab: existing, evicted: [] }
    }
    const room = makeRoom()
    if (!room.allowed) return { tab: null, rejected: room.rejected, evicted: room.evicted }
    const tab: TabRecord = {
      id: newId(),
      kind,
      workspaceId: null,
      scopeLabel: label,
      history: [],
      historyIndex: -1,
      absolutePath: null,
      expanded: [],
      expandedSeeded: true,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    tabs.value = [...tabs.value, tab]
    activate(tab.id)
    return { tab, evicted: room.evicted }
  }

  /** 新开 workspace 标签（不去重：同一工作区点两次就是两个标签） */
  function openWorkspace(workspace: { id: string; name: string }): OpenResult {
    const room = makeRoom()
    if (!room.allowed) return { tab: null, rejected: room.rejected, evicted: room.evicted }
    const tab: TabRecord = {
      id: newId(),
      kind: 'workspace',
      workspaceId: workspace.id,
      scopeLabel: workspace.name,
      history: [],
      historyIndex: -1,
      absolutePath: null,
      expanded: [],
      expandedSeeded: false,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    tabs.value = [...tabs.value, tab]
    activate(tab.id)
    return { tab, evicted: room.evicted }
  }

  /** 新开单文件标签 */
  function openFile(input: { absolutePath: string; title: string }): OpenResult {
    const room = makeRoom()
    if (!room.allowed) return { tab: null, rejected: room.rejected, evicted: room.evicted }
    const ref: DocRef = {
      key: docKeyOf(null, input.absolutePath, ''),
      workspaceId: null,
      relPath: '',
      absolutePath: input.absolutePath,
      title: input.title,
      scrollY: 0,
    }
    const tab: TabRecord = {
      id: newId(),
      kind: 'file',
      workspaceId: null,
      scopeLabel: (input.absolutePath.split(/[/\\]/).pop() ?? input.title).replace(/\.md$/i, ''),
      history: [ref],
      historyIndex: 0,
      absolutePath: input.absolutePath,
      expanded: [],
      expandedSeeded: false,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    tabs.value = [...tabs.value, tab]
    activate(tab.id)
    return { tab, evicted: room.evicted }
  }

  /** 标签内导航：push 进历史（截断前进分支）；同一篇只更新 scrollY 不重复入栈 */
  function navigate(tabId: string, ref: DocRef): void {
    const tab = tabs.value.find(item => item.id === tabId)
    if (!tab) return
    const current = currentDocOf(tab)
    if (current && current.key === ref.key) {
      current.title = ref.title || current.title
      return
    }
    const kept = tab.history.slice(0, tab.historyIndex + 1)
    kept.push(ref)
    // 上限：丢最旧，保持 historyIndex 指向新项
    const overflow = Math.max(0, kept.length - MAX_HISTORY)
    tab.history = overflow ? kept.slice(overflow) : kept
    tab.historyIndex = tab.history.length - 1
  }

  /** 前进 / 后退（Alt+←/→）；返回新位置 */
  function step(tabId: string, delta: number): DocRef | null {
    const tab = tabs.value.find(item => item.id === tabId)
    if (!tab) return null
    const next = tab.historyIndex + delta
    if (next < 0 || next >= tab.history.length) return null
    tab.historyIndex = next
    return currentDocOf(tab)
  }

  function canStep(tabId: string, delta: number): boolean {
    const tab = tabs.value.find(item => item.id === tabId)
    if (!tab) return false
    const next = tab.historyIndex + delta
    return next >= 0 && next < tab.history.length
  }

  /** 回写某篇的滚动位置 */
  function setScroll(tabId: string, scrollY: number): void {
    const tab = tabs.value.find(item => item.id === tabId)
    const ref = tab ? currentDocOf(tab) : null
    if (ref) ref.scrollY = scrollY
  }

  /** 更新当前文档标题（正文渲染完成后首个 H1 才知道） */
  function setDocTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(item => item.id === tabId)
    const ref = tab ? currentDocOf(tab) : null
    if (ref && title && ref.title !== title) ref.title = title
  }

  /**
   * 首次装载某个工作区标签的树时，把顶层目录展开。
   *
   * 为什么放在 App 而不是 store：store 不知道树的结构。用 expandedSeeded
   * 区分「还没播种」和「用户主动全折叠」，否则用户每次切回来都会被打回展开态。
   */
  function seedExpanded(tabId: string, topLevel: string[]): void {
    const tab = tabs.value.find(item => item.id === tabId)
    if (!tab || tab.expandedSeeded) return
    tab.expanded = topLevel
    tab.expandedSeeded = true
  }

  function setExpanded(tabId: string, expanded: string[]): void {
    const tab = tabs.value.find(item => item.id === tabId)
    if (tab) tab.expanded = expanded
  }

  function setScopeLabel(tabId: string, label: string): void {
    const tab = tabs.value.find(item => item.id === tabId)
    if (tab && label) tab.scopeLabel = label
  }

  /**
   * 用工作区注册表校正所有标签上的作用域名。
   *
   * 名字的真实来源永远是注册表；标签里存的只是快照，可能来自旧会话文件（空串）
   * 或早期「用 id 兜底」的代码（12 位哈希）。启动装载后调一次即可全部对齐。
   */
  function syncWorkspaceNames(names: Map<string, string>): void {
    for (const tab of tabs.value) {
      if (tab.kind !== 'workspace' || !tab.workspaceId) continue
      const name = names.get(tab.workspaceId)
      if (!name) continue
      if (!isRealScopeLabel(tab.scopeLabel) || tab.scopeLabel !== name) tab.scopeLabel = name
    }
  }

  /** 关闭：文档库不可关；关掉激活项后落到 MRU 里最近用过的 */
  function close(id: string): void {
    const index = tabs.value.findIndex(tab => tab.id === id)
    const tab = tabs.value[index]
    if (!tab || tab.kind === 'library') return
    tabs.value = tabs.value.filter(item => item.id !== id)
    mru.value = mru.value.filter(item => item !== id)
    if (activeId.value !== id) return
    const recent = mru.value.find(item => tabs.value.some(candidate => candidate.id === item))
    const neighbour = tabs.value[index] ?? tabs.value[index - 1] ?? libraryTab.value
    activeId.value = recent ?? neighbour?.id ?? null
  }

  function closeOthers(id: string): string[] {
    const keep = tabs.value.filter(tab => tab.kind === 'library' || tab.id === id)
    const removed = tabs.value
      .filter(tab => !keep.some(item => item.id === tab.id))
      .map(tab => tab.id)
    tabs.value = keep
    mru.value = mru.value.filter(item => keep.some(tab => tab.id === item))
    activeId.value = id
    return removed
  }

  /**
   * 关闭全部标签页。
   *
   * 文档库是钉住的首页，不参与关闭——全关之后落回文档库，而不是留一个空白窗口。
   * 有未保存修改的标签不在这里拦：调用方（App）已经在关闭前逐个确认过。
   */
  function closeAll(): string[] {
    const removed = tabs.value.filter(tab => tab.kind !== 'library').map(tab => tab.id)
    tabs.value = tabs.value.filter(tab => tab.kind === 'library')
    mru.value = []
    const library = libraryTab.value
    if (library) {
      activate(library.id)
    } else {
      activeId.value = null
    }
    return removed
  }

  /**
   * 拖动排序：把 fromId 移到 toId 的位置。
   *
   * 文档库固定在首位，不参与排序——它是「永远在第一眼」的锚点，
   * 允许它被拖走会让用户下次找不到回首页的路。`toId` 为 null 表示拖到末尾。
   */
  function reorder(fromId: string, toId: string | null): void {
    const list = tabs.value
    const fromIndex = list.findIndex(tab => tab.id === fromId)
    const moving = list[fromIndex]
    if (!moving || moving.kind === 'library') return
    const without = list.filter(tab => tab.id !== fromId)
    const toIndex = toId === null ? without.length : without.findIndex(tab => tab.id === toId)
    if (toIndex < 0) return
    // 文档库恒在首位：落点最小为 1
    const insertAt = Math.max(1, toIndex)
    without.splice(insertAt, 0, moving)
    tabs.value = without
  }

  function closeRight(id: string): string[] {
    const index = tabs.value.findIndex(tab => tab.id === id)
    if (index < 0) return []
    const removed: string[] = []
    tabs.value = tabs.value.filter((tab, at) => {
      if (at <= index || tab.kind === 'library') return true
      removed.push(tab.id)
      return false
    })
    mru.value = mru.value.filter(item => tabs.value.some(tab => tab.id === item))
    if (activeId.value && removed.includes(activeId.value)) activeId.value = id
    return removed
  }

  /** 工作区被移除：关掉它的所有标签 */
  function closeByWorkspace(workspaceId: string): string[] {
    const removed = tabs.value.filter(tab => tab.workspaceId === workspaceId).map(tab => tab.id)
    if (!removed.length) return []
    tabs.value = tabs.value.filter(tab => !removed.includes(tab.id))
    mru.value = mru.value.filter(item => !removed.includes(item))
    if (activeId.value && removed.includes(activeId.value)) {
      activeId.value = libraryTab.value?.id ?? tabs.value[0]?.id ?? null
    }
    return removed
  }

  /**
   * 工作区身份变了：把标签与历史里的引用原地换到新 id。
   *
   * 只有一个场景会走到这里——git 工作区切分支。切分支换了一棵工作树，工作区
   * 的 id 与 root 都变了，但「用户正在看的是一篇叫 guide.md 的文档」这件事没变。
   * 直接关标签再重开会把浏览现场丢掉；所以重写引用而不是重建标签。
   */
  function replaceWorkspace(oldId: string, next: { id: string; name: string; root: string }): void {
    const root = next.root.replace(/[/\\]+$/, '')
    const sep = root.includes('\\') ? '\\' : '/'
    for (const tab of tabs.value) {
      if (tab.workspaceId === oldId) {
        tab.workspaceId = next.id
        tab.scopeLabel = next.name
      }
      for (const ref of tab.history) {
        if (ref.workspaceId !== oldId) continue
        ref.workspaceId = next.id
        ref.key = `workspace:${next.id}:${ref.relPath}`
        if (ref.relPath) ref.absolutePath = `${root}${sep}${ref.relPath.replace(/[\\/]+/g, sep)}`
      }
    }
  }

  /** MRU 列表（不含文档库），供 Ctrl+Tab 浮层使用 */
  const mruTabs = computed(() => {
    const byId = new Map(tabs.value.map(tab => [tab.id, tab]))
    return mru.value
      .map(id => byId.get(id))
      .filter((tab): tab is TabRecord => tab !== undefined && tab.kind !== 'library')
  })

  /**
   * 会话快照必须**脱离响应式代理**。
   *
   * `tabs.value` 是 Vue 的 reactive 数组，直接传给 ipcRenderer.invoke 会走
   * structured clone——Proxy 不可克隆，异常被 Promise 吃掉，结果是
   * session.json 永远不写（实测：直接调 IPC 能写，watch 里写不出来）。
   * 走一遍 JSON 序列化既去掉代理，也顺便剔除 undefined。
   */
  function serialize(): Persisted {
    return JSON.parse(
      JSON.stringify({
        schemaVersion: TAB_SESSION_VERSION,
        activeId: activeId.value,
        tabs: tabs.value,
        mru: mru.value,
      }),
    ) as Persisted
  }

  // 会话持久化：600ms 防抖写 session.json（滚动位置变化很频繁，不能每次都写盘）
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    [tabs, activeId, mru],
    () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        void window.docvi.sessionWrite(serialize())
      }, 600)
    },
    { deep: true },
  )

  /** 启动时用 session.json 覆盖（localStorage 迁移只在没有会话文件时生效） */
  function hydrate(raw: unknown): void {
    const restoredSession = restoreSession(raw)
    if (!restoredSession) return
    tabs.value = restoredSession.tabs
    activeId.value = restoredSession.activeId
    mru.value = restoredSession.mru
  }

  /**
   * 文件被改名 / 移动后，把所有标签历史里指向旧路径的条目换成新路径。
   *
   * 不换的话标签还指着一个已不存在的路径：切回去读失败，历史前进/后退里
   * 也留着一条死链接。key 由绝对路径与 relPath 派生，所以一并重算。
   */
  function replacePath(workspaceId: string, fromRel: string, toRel: string): void {
    for (const tab of tabs.value) {
      if (tab.workspaceId !== workspaceId) continue
      for (const ref of tab.history) {
        if (ref.relPath !== fromRel) continue
        const absolute = ref.absolutePath.replaceAll('\\', '/')
        const suffix = `/${fromRel}`.toLowerCase()
        const base = absolute.toLowerCase().endsWith(suffix)
          ? absolute.slice(0, absolute.length - fromRel.length)
          : ''
        ref.relPath = toRel
        ref.key = docKeyOf(workspaceId, base ? `${base}${toRel}` : absolute, toRel)
      }
    }
  }

  /**
   * 文件被删除后，把标签历史里指向它的条目移除。
   *
   * 当前停在被删文档上的标签，历史会被截断；已经空了就退回文档库，
   * 而不是留下一个打开着「文件不存在」的标签。
   */
  function dropPath(workspaceId: string, relPath: string): void {
    for (const tab of tabs.value) {
      if (tab.workspaceId !== workspaceId) continue
      const before = tab.history.length
      tab.history = tab.history.filter(ref => ref.relPath !== relPath)
      if (tab.history.length === before) continue
      tab.historyIndex = Math.min(tab.historyIndex, tab.history.length - 1)
      if (!tab.history.length && tab.kind !== 'library') {
        activate(libraryTab.value?.id ?? tabs.value[0]?.id ?? '')
      }
    }
  }

  return {
    tabs,
    activeId,
    activeTab,
    activeDoc,
    libraryTab,
    workspaceTabs,
    mruTabs,
    preferences,
    ensureLibrary,
    openWorkspace,
    openPage,
    openFile,
    navigate,
    step,
    canStep,
    setScroll,
    setDocTitle,
    setExpanded,
    seedExpanded,
    setScopeLabel,
    syncWorkspaceNames,
    activate,
    close,
    closeOthers,
    closeRight,
    closeAll,
    reorder,
    closeByWorkspace,
    replaceWorkspace,
    replacePath,
    dropPath,
    setDirtyCheck,
    setPreferences,
    serialize,
    hydrate,
    currentDocOf: (tabId: string) => {
      const tab = tabs.value.find(item => item.id === tabId)
      return tab ? currentDocOf(tab) : null
    },
  }
})
