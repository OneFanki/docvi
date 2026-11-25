/**
 * 标签模型：**一个标签 = 一个工作现场**（ADR-0008）。
 *
 * 三种标签：
 *  - `workspace`：某个工作区里的文档，带文档历史（Alt+←/→）；
 *  - `file`：工作区之外的单文件（拖入 / 关联打开 / 最近打开）；
 *  - `settings` / `plugins`：应用页面，单例。
 *
 * 1.0 起没有「文档库」标签——启动不再经过首屏，左栏是常驻的工作区导航。
 *
 * 树（目录展开态）**不属于标签**：它是工作区的属性，切标签时不该重排。
 * 这条是 ADR-0008 的核心解耦，别把 `expanded` 加回 `TabRecord`。
 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import type { TabPreferences } from '@docvi/shared'

/**
 * 标签类型。
 *
 * workspace / file 是「文档现场」；settings / plugins 是**应用页面**。
 * 应用页面也走标签：页面标签是**单例**（同一页面只会有一个），点第二次就激活它。
 */
export type TabKind = 'workspace' | 'file' | 'settings' | 'plugins'

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
  /**
   * 这一篇读到哪里了：像素位置与源行各存一份。
   *
   * 为什么不能只存 `scrollY`：字体、字号、正文宽度一改，整篇的排版高度就变了，
   * 同一个像素值指向的是**别的内容**；新排版更短时还会被浏览器 clamp 到顶部。
   * 源行是内容坐标，排版怎么变都指向同一段文字，所以恢复时优先用它，
   * `scrollY` 只作退化兜底（比如文档没有 `data-source-line` 的情况）。
   */
  scrollY: number
  /** 视口顶部的源行（1 基）。0 表示没记过 */
  topLine: number
  /**
   * 保存 `scrollY` 时的排版签名（字体 + 正文宽度 + 文档长度）。
   *
   * 用途：恢复时判断「像素值还能不能信」。
   *  - 签名一致 → 排版没变，像素精确，直接用（块级源行定位在高块内部会有
   *    几十到几百像素误差，像素反而更准）；
   *  - 签名变了 → 排版重排过，像素失效，退回源行定位。
   *
   * 空串表示旧会话没有这个字段，按「未知」处理（走源行）。
   */
  layoutKey: string
}

export interface TabRecord {
  id: string
  kind: TabKind
  /** workspace 标签所属工作区；file / 应用页面 为 null */
  workspaceId: string | null
  /** 显示用的作用域名：工作区名或文件名（应用页面用固定文案） */
  scopeLabel: string
  /** 文档历史（应用页面标签恒为空） */
  history: DocRef[]
  /** 当前在历史的哪一项；-1 表示还没打开任何文档 */
  historyIndex: number
  /** file 标签的绝对路径（其余为 null） */
  absolutePath: string | null
  /**
   * 预览标签（斜体标题）：单击文档时打开，下一次单击别的文档就**替换**它。
   *
   * 这是 VSCode 的「预览 → 固定」模型：单击只表示「我想看一眼」，
   * 不该在标签条上堆积；双击（或编辑、拖动、手动固定）才升格为正式标签。
   * 应用页面标签恒为 false。
   */
  preview: boolean
  createdAt: number
  lastActiveAt: number
}

/*
 * 会话版本 3：v2 的标签里带 `expanded` / `expandedSeeded`（树挂在标签上），
 * 且可能含 `library` 标签。两者都在 v3 被移除。旧版本会话直接丢弃标签列表
 * （只保留能解析出的文档位置意义不大——用户重启后重新打开一两篇即可），
 * 所以这里不做迁移，`restoreSession` 只认 v3。
 */
export const TAB_SESSION_VERSION = 3
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
  settings: string
  plugins: string
}

/**
 * 标签标题。
 *
 * 标签上只显示**文档名**：标签是拿来扫读「我在看哪篇」的，前面再挂一段工作区名
 * （或更糟，工作区 id）会把真正要找的信息挤掉。工作区身份由左栏的切换器承担。
 *
 * `scope` 仍然返回给 tooltip 与切换浮层用，但绝不参与主标题——尤其不能拿
 * workspaceId 当兜底文本：那串 12 位哈希曾原样出现在标签上。
 */
export function tabTitleOf(
  tab: TabRecord,
  labels: TabLabels,
): { scope: string; doc: string | null; label: string } {
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
    /*
     * 老会话文件没有这个字段：用 -1 表示「不知道」，恢复时直接走像素兜底。
     * 不能填 0——那等于谎称「用户当时在最顶上」，会把人拽回开头。
     */
    topLine: Number.isFinite(Number(raw.topLine)) ? Number(raw.topLine) : -1,
    /* 老会话没有签名字段：空串表示「不知道当时的排版」，恢复时走源行 */
    layoutKey: typeof raw.layoutKey === 'string' ? raw.layoutKey : '',
  }
}

function normalizeTab(value: unknown): TabRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== 'string') return null
  const kind = raw.kind
  // v2 会话里的 `library` 落到这里，一律丢弃（1.0 不再有文档库标签）
  if (kind !== 'workspace' && kind !== 'file' && kind !== 'settings' && kind !== 'plugins') {
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
    /*
     * 预览标签不跨重启存活：它是「临时看一眼」的语义，重启后还把上次的
     * 临时页恢复成临时页，用户下一次单击就会把它顶掉，等于什么都没留住。
     * 所以这里恒为 false，不读 `raw.preview`。
     */
    preview: false,
    createdAt: Number(raw.createdAt) || Date.now(),
    lastActiveAt: Number(raw.lastActiveAt) || Date.now(),
  }
}

/**
 * 恢复会话。
 *
 * 只认当前版本：v2 及更早的会话带着已删除的 `expanded` / `library` 概念，
 * 强行迁移只会把「模型已变」这件事藏起来。用户重启后重新打开一两篇即可，
 * 而 `recent.json` 里的最近打开列表仍然完整。
 */
function restoreSession(raw: unknown): Persisted | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  if (Number(data.schemaVersion) !== TAB_SESSION_VERSION) return null
  if (!Array.isArray(data.tabs)) return null
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
        topLine: tab.topLine ?? -1,
        layoutKey: '',
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
        preview: false,
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
    touchMru(id)
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
    const candidates = tabs.value.filter(tab => !dirtyCheck(tab))
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
      activeId.value = mru.value.find(id => tabs.value.some(tab => tab.id === id)) ?? null
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
      preview: false,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    tabs.value = [...tabs.value, tab]
    activate(tab.id)
    return { tab, evicted: room.evicted }
  }

  /**
   * 打开一篇文档，按 VSCode 的「预览 / 固定」语义决定落在哪。
   *
   * 三种情况，顺序不能换：
   *  1. 这篇已经在某个标签里 → 激活那个标签，不新建（VSCode 也是这样：
   *     要同一文件开两份得走「在新标签页打开」）；
   *  2. `pin` 为真（双击 / 编辑 / 显式固定）→ 新建固定标签；
   *  3. 否则（单击）→ 复用**当前激活的预览标签**，没有就新建一个预览标签。
   *
   * 为什么第 3 步要复用：不复用的话连点十篇就是十个标签，跟固定标签没区别，
   * 预览语义白设计。复用后标签条上最多只有一个斜体标签在跳。
   */
  function openDoc(
    workspace: { id: string; name: string },
    ref: DocRef,
    options: { pin?: boolean } = {},
  ): OpenResult {
    const existing = tabs.value.find(
      tab =>
        (tab.kind === 'workspace' || tab.kind === 'file') && currentDocOf(tab)?.key === ref.key,
    )
    if (existing) {
      // 已打开的文档再点一次：只激活。若这次是双击，顺手升格为固定。
      if (options.pin && existing.preview) existing.preview = false
      activate(existing.id)
      return { tab: existing, evicted: [] }
    }

    const room = makeRoom()
    if (!room.allowed) return { tab: null, rejected: room.rejected, evicted: room.evicted }

    if (!options.pin) {
      // 复用激活中的预览标签：同一个标签换内容，标签条不增长
      const reusable = tabs.value.find(tab => tab.preview && tab.id === activeId.value)
      if (reusable && reusable.workspaceId === workspace.id) {
        reusable.history = [ref]
        reusable.historyIndex = 0
        reusable.scopeLabel = workspace.name
        activate(reusable.id)
        return { tab: reusable, evicted: room.evicted }
      }
    }

    const tab: TabRecord = {
      id: newId(),
      kind: 'workspace',
      workspaceId: workspace.id,
      scopeLabel: workspace.name,
      history: [ref],
      historyIndex: 0,
      absolutePath: null,
      preview: !options.pin,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    tabs.value = [...tabs.value, tab]
    activate(tab.id)
    return { tab, evicted: room.evicted }
  }

  /**
   * 把预览标签升格为固定标签。
   *
   * 用户开始编辑、拖动标签或显式「固定」时调用；返回是否真的改了状态。
   */
  function pin(id: string): boolean {
    const tab = tabs.value.find(item => item.id === id)
    if (!tab || !tab.preview) return false
    tab.preview = false
    return true
  }

  /** 当前预览标签（标签条据此把标题画成斜体） */
  const previewTab = computed(() => tabs.value.find(tab => tab.preview) ?? null)

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
      preview: false,
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
      topLine: -1,
      layoutKey: '',
    }
    const tab: TabRecord = {
      id: newId(),
      kind: 'file',
      workspaceId: null,
      scopeLabel: (input.absolutePath.split(/[/\\]/).pop() ?? input.title).replace(/\.md$/i, ''),
      history: [ref],
      historyIndex: 0,
      absolutePath: input.absolutePath,
      preview: false,
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

  /**
   * 回写某篇的阅读位置。
   *
   * 三样一起存：像素、源行、排版签名。恢复时按签名决定信哪个——
   * 签名一致说明排版没变，像素精确（块级源行定位在高块内部会差几十像素）；
   * 签名变了说明重排过，像素失效，只能靠源行。
   */
  function setScroll(tabId: string, scrollY: number, topLine = -1, layoutKey = ''): void {
    const tab = tabs.value.find(item => item.id === tabId)
    const ref = tab ? currentDocOf(tab) : null
    if (!ref) return
    ref.scrollY = scrollY
    /*
     * 0 是合法坐标（用户正看着开头），-1 表示「这篇没有行号信息」。
     * 只拒绝负数，不要写成 `> 0`——那会把「在最顶部」也吞掉。
     */
    if (topLine >= 0) ref.topLine = topLine
    if (layoutKey) ref.layoutKey = layoutKey
  }

  /** 更新当前文档标题（正文渲染完成后首个 H1 才知道） */
  function setDocTitle(tabId: string, title: string): void {
    const tab = tabs.value.find(item => item.id === tabId)
    const ref = tab ? currentDocOf(tab) : null
    if (ref && title && ref.title !== title) ref.title = title
  }

  function syncWorkspaceNames(names: Map<string, string>): void {
    for (const tab of tabs.value) {
      if (tab.kind !== 'workspace' || !tab.workspaceId) continue
      const name = names.get(tab.workspaceId)
      if (!name) continue
      if (!isRealScopeLabel(tab.scopeLabel) || tab.scopeLabel !== name) tab.scopeLabel = name
    }
  }

  /** 关闭：关掉激活项后落到 MRU 里最近用过的 */
  function close(id: string): void {
    const index = tabs.value.findIndex(tab => tab.id === id)
    const tab = tabs.value[index]
    if (!tab) return
    tabs.value = tabs.value.filter(item => item.id !== id)
    mru.value = mru.value.filter(item => item !== id)
    if (activeId.value !== id) return
    const recent = mru.value.find(item => tabs.value.some(candidate => candidate.id === item))
    const neighbour = tabs.value[index] ?? tabs.value[index - 1] ?? null
    activeId.value = recent ?? neighbour?.id ?? null
  }

  function reorder(fromId: string, toId: string | null): void {
    const list = tabs.value
    const fromIndex = list.findIndex(tab => tab.id === fromId)
    const moving = list[fromIndex]
    if (!moving) return
    const without = list.filter(tab => tab.id !== fromId)
    const toIndex = toId === null ? without.length : without.findIndex(tab => tab.id === toId)
    if (toIndex < 0) return
    without.splice(toIndex, 0, moving)
    tabs.value = without
  }

  function closeByWorkspace(workspaceId: string): string[] {
    const removed = tabs.value.filter(tab => tab.workspaceId === workspaceId).map(tab => tab.id)
    if (!removed.length) return []
    tabs.value = tabs.value.filter(tab => !removed.includes(tab.id))
    mru.value = mru.value.filter(item => !removed.includes(item))
    if (activeId.value && removed.includes(activeId.value)) {
      activeId.value = mru.value.find(id => tabs.value.some(tab => tab.id === id)) ?? null
    }
    return removed
  }

  /** MRU 顺序（Ctrl+Tab 浮层用） */
  const mruTabs = computed(() => {
    const byId = new Map(tabs.value.map(tab => [tab.id, tab]))
    return mru.value.map(id => byId.get(id)).filter((tab): tab is TabRecord => tab !== undefined)
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
   * 当前停在被删文档上的标签，历史会被截断；已经空了就激活 MRU 里的下一个，
   * 而不是留下一个打开着「文件不存在」的标签。
   */
  function dropPath(workspaceId: string, relPath: string): void {
    for (const tab of tabs.value) {
      if (tab.workspaceId !== workspaceId) continue
      const before = tab.history.length
      tab.history = tab.history.filter(ref => ref.relPath !== relPath)
      if (tab.history.length === before) continue
      tab.historyIndex = Math.min(tab.historyIndex, tab.history.length - 1)
      if (!tab.history.length) {
        const next = mru.value.find(id => tabs.value.some(item => item.id === id && item !== tab))
        if (next) activate(next)
      }
    }
  }

  return {
    tabs,
    activeId,
    activeTab,
    activeDoc,
    mruTabs,
    preferences,
    openWorkspace,
    openDoc,
    pin,
    previewTab,
    openPage,
    openFile,
    navigate,
    step,
    setScroll,
    setDocTitle,
    syncWorkspaceNames,
    activate,
    close,
    reorder,
    closeByWorkspace,
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
