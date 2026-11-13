/**
 * 应用设置（`userData/settings.json`）。
 *
 * 与 session.json 的分工：这里只放**用户可解释、可导出、可手改**的偏好；
 * 打开的标签、滚动位置这类窗口状态属于 session，不进导出。
 *
 * 主题 id 是 string 而不是联合类型：插件主题在运行期才知道。
 *
 * 主题只有**一个**维度：界面、正文、编辑器、组件全部由同一套变量决定。
 * 这是「编辑器主题」与「应用主题」分离的反面选择——分离会让状态组合爆炸
 * （3×3×3），插件作者还得为每个维度各交一份；而文档就是这个应用的正文，
 * 像 VS Code / JetBrains 那样一套主题连代码一起管，才是用户的心智模型。
 */

export type LocaleCode = 'zh' | 'en'

export interface TabPreferences {
  /** 最大标签数；0 = 不限 */
  maxTabs: number
  /** 达到上限时：关闭最久未使用 / 关闭最早打开 / 拒绝新建 */
  overflow: 'least-recent' | 'oldest' | 'reject'
  /** 排列：单行 / 允许换行 */
  layout: 'single' | 'wrap'
  /** 单行溢出：横向滚动 / 等比压缩 */
  overflowX: 'scroll' | 'shrink'
  /**
   * 标签最大宽度（px）。
   *
   * 只设上限不设固定宽度：短标题按内容宽、长标题截断，一排能多看几个标签。
   */
  maxWidth: number
}

/** 正文与编辑区的横向宽度：铺满画布 / 限制在可读行宽 */
export type ContentWidth = 'full' | 'measure'

/**
 * 编辑器行宽处理：折行 / 横向滚动。
 *
 * 这是**源码模式**的排版偏好，不属于主题也不是文档内容：同一篇文档，
 * 有人希望长行折下来（不用左右拖），有人希望「一行就是一行」（表格对齐可控）。
 */
export type EditorWrap = 'wrap' | 'nowrap'

/**
 * 界面与正文使用的字体族。
 *
 * 只有两档：随包分发的鸿蒙黑体，或用户系统自带的字体。刻意不做「界面字体 /
 * 文档字体」两个维度——用户的心智是「这个应用用什么字体」，拆开会立刻带来
 * 组合问题（界面系统 + 文档鸿蒙算不算合法需求？），而目前没有任何真实诉求支持它。
 *
 * `harmony` 是默认值。若把它写成 `system` 再让 UI 默认选鸿蒙，则设置文件缺失时
 * 会闪一下系统字体——默认必须是字体栈本身的第一项，见 theme.css `:root` 分支。
 */
export type FontFamily = 'harmony' | 'system'

/**
 * 桌面外壳行为。
 *
 * 为什么放在 settings.json 而不是 service.json：
 * service.json 是**服务自身的配置**（令牌、端口、局域网）——用户可以删掉它来
 * 重置令牌；而这两项是**应用的行为偏好**，删服务配置不该连带忘记。
 */
export interface DesktopPreferences {
  /** 开机自启动（Windows 走注册表 Run 键） */
  autostart: boolean
  /** 关闭窗口时留在托盘，而不是退出（MCP 与分享在窗口关掉后仍可用） */
  closeToTray: boolean
}

export interface AppSettings {
  schemaVersion: 1
  /** 主题 id（内置 graphite / paper，或 `plugin-<插件>-<id>`） */
  theme: string
  /** 界面与正文的字体族（默认随包分发的鸿蒙黑体） */
  fontFamily: FontFamily
  locale: LocaleCode
  tabs: TabPreferences
  contentWidth: ContentWidth
  /**
   * 侧栏（目录树）是否折叠。
   *
   * 放进 settings 而不是 session：这是「我习惯用紧凑布局」的偏好，不是
   * 窗口现场；重装后导出设置也应当保留。用户折叠一次就该一直是折叠的——
   * 每次重启都要重新点一下是纯粹的摩擦。
   */
  sidebarCollapsed: boolean
  /**
   * 源码模式的折行方式。
   *
   * 默认折行：文档不是代码，横向滚动会让人左右找丢失的行首。
   * 但写表格 / 宽代码块时「一行就是一行」更可控，所以给一个开关。
   */
  editorWrap: EditorWrap
  desktop: DesktopPreferences
  /**
   * 是否已经播种过内建默认工作区（`<文档>/docvi`）。
   *
   * 只播种一次：用户把这个工作区删掉，就是不想要它，重启再建出来是骚扰。
   * 放进 settings 而不是「看目录在不在」——目录是否存在无法区分「从没建过」
   * 与「用户主动删了」。
   */
  defaultWorkspaceSeeded: boolean
}

export const TAB_WIDTH_MIN = 120
export const TAB_WIDTH_MAX = 320

export const DEFAULT_TAB_PREFERENCES: TabPreferences = {
  maxTabs: 0,
  overflow: 'least-recent',
  layout: 'single',
  overflowX: 'scroll',
  maxWidth: 200,
}

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  // 默认石墨：与 :root 的深色基底同一套暖灰配色，首帧不会跳色
  theme: 'graphite',
  // 默认随包分发的鸿蒙黑体（见 theme.css 的 @font-face）
  fontFamily: 'harmony',
  locale: 'zh',
  tabs: { ...DEFAULT_TAB_PREFERENCES },
  // 默认铺满：内容宽度是「想专注读」时才需要的约束，不该一上来就限死
  contentWidth: 'full',
  sidebarCollapsed: false,
  editorWrap: 'wrap',
  /*
   * 关闭窗口留在托盘默认**开启**。
   *
   * 本地服务（MCP 与分享）是常驻能力：关窗口就把进程一起带走，等于让别人的
   * 分享链接和 AI 的连接莫名其妙断掉。默认留在托盘，用户要彻底退出时从托盘
   * 菜单选，语义比「关窗口顺手杀进程」清楚。
   * 开机自启动仍然默认关闭——那才是「用户明确想要」才该开的开关。
   */
  desktop: { autostart: false, closeToTray: true },
  // 首次启动时主进程会播种默认工作区并把这一位翻成 true
  defaultWorkspaceSeeded: false,
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** 布尔项：只有显式 true/false 才算数，缺失或类型不对时用默认值 */
function bool(value: unknown, fallback: boolean): boolean {
  return value === true || value === false ? value : fallback
}

/**
 * 归一化一份可能来自用户手改 / 旧版本的设置。
 *
 * 原则：**坏字段回退默认值，不让整体失效**。一个手滑的 `maxWidth: "abc"`
 * 不该让整个应用退回默认主题——只丢弃这一项即可。
 */
export function normalizeSettings(raw: unknown): AppSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  const record = raw as Record<string, unknown>
  /*
   * 主题旧形状是 { ui, doc, editor } 三个维度。统一后只取 ui 作为唯一种子：
   * 它是最先被用户感知的一层（窗口 chrome），拿它迁移最不容易让人意外。
   */
  const themeRaw = record.theme
  const legacyTheme =
    themeRaw && typeof themeRaw === 'object' ? (themeRaw as Record<string, unknown>).ui : themeRaw
  const tabsRaw = (record.tabs ?? {}) as Record<string, unknown>
  const desktopRaw = (record.desktop ?? {}) as Record<string, unknown>
  const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback

  return {
    schemaVersion: 1,
    theme: text(legacyTheme, DEFAULT_SETTINGS.theme),
    // 旧设置文件没有这一项 → 落到默认（鸿蒙），与全新安装一致
    fontFamily: pick(
      record.fontFamily,
      ['harmony', 'system'] as const,
      DEFAULT_SETTINGS.fontFamily,
    ),
    locale: pick(record.locale, ['zh', 'en'] as const, DEFAULT_SETTINGS.locale),
    tabs: {
      maxTabs: clampInt(tabsRaw.maxTabs, 0, 200, DEFAULT_TAB_PREFERENCES.maxTabs),
      overflow: pick(
        tabsRaw.overflow,
        ['least-recent', 'oldest', 'reject'] as const,
        DEFAULT_TAB_PREFERENCES.overflow,
      ),
      layout: pick(tabsRaw.layout, ['single', 'wrap'] as const, DEFAULT_TAB_PREFERENCES.layout),
      overflowX: pick(
        tabsRaw.overflowX,
        ['scroll', 'shrink'] as const,
        DEFAULT_TAB_PREFERENCES.overflowX,
      ),
      // 旧键 fixedWidth 是「固定宽度」，语义换成「最大宽度」后数值可以直接沿用
      maxWidth: clampInt(
        tabsRaw.maxWidth ?? tabsRaw.fixedWidth,
        TAB_WIDTH_MIN,
        TAB_WIDTH_MAX,
        DEFAULT_TAB_PREFERENCES.maxWidth,
      ),
    },
    contentWidth: pick(
      record.contentWidth,
      ['full', 'measure'] as const,
      DEFAULT_SETTINGS.contentWidth,
    ),
    sidebarCollapsed: record.sidebarCollapsed === true,
    editorWrap: pick(record.editorWrap, ['wrap', 'nowrap'] as const, DEFAULT_SETTINGS.editorWrap),
    desktop: {
      autostart: desktopRaw.autostart === true,
      // 键不存在时用默认值（默认是开）——写成 `=== true` 会把「没存过」误判成「关」
      closeToTray: bool(desktopRaw.closeToTray, DEFAULT_SETTINGS.desktop.closeToTray),
    },
    // 缺省视为未播种：老用户的 settings.json 里没有这一位，升级后应当补建一次
    defaultWorkspaceSeeded: record.defaultWorkspaceSeeded === true,
  }
}
