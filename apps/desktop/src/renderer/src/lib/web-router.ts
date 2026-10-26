import { isWebHost } from './host'
import { branchUrl } from './branch-url'
import { parsePreviewRoute, type PreviewRoute } from './preview-route'

/**
 * 容器版的 URL 路由：`/<仓库 slug>/<文档相对路径>`（查询串保留 `?branch=`）。
 *
 * 桌面版没有 URL 概念——窗口里只有标签，标签之间切换不该动任何地址。容器版
 * 必须有：每篇文档要能单独分享、刷新后回到原处、浏览器前进/后退要能用。这两套
 * 语义没有共同的抽象，所以路由只在这里实现，桌面下所有函数都是空操作。
 *
 * 为什么不引 vue-router：路由面只有「仓库 + 文档路径」一个层级，没有嵌套视图、
 * 没有守卫、也没有命名路由。标签模型本来就管着「当前在哪篇」，路由只需要把
 * 这个状态同步给地址栏，以及在地址栏变化时反向驱动标签。
 */

export interface WebRoute {
  /** 仓库 slug（= 渲染层的 workspaceId） */
  slug: string
  /** 文档相对路径（不含 .md；空串 = 仓库首页 / 落地页） */
  path: string
}

/**
 * 组件示例预览路由：`/_/preview/<插件包名>/<组件 kind>`。
 *
 * 这是**运维页「预览」链接的落地页**，不是文档：它整页渲染插件包里的示例
 * markdown，用来在不装插件的情况下看清组件长什么样。容器端由部署器的
 * `/api/plugins/<name>/example/<kind>` 提供示例原文（公开端点）。
 *
 * 必须在这里单独识别：`/_/preview/...` 的第一段是 `_`，会被普通路由当成
 * 「仓库 slug = _」然后查不到仓库、静默落回首页——用户看到的就是「点预览
 * 开了个 docvi 页面，但什么都没有」。
 *
 * 解析逻辑在 `preview-route.ts`（纯函数，可单测）；这里只补上宿主判断。
 */
export function readPreviewRoute(): PreviewRoute | null {
  if (!isWebHost) return null
  return parsePreviewRoute(location.pathname)
}

/** 从地址栏解析路由；根路径返回 null（= 文档库首页） */
export function readRoute(): WebRoute | null {
  if (!isWebHost) return null
  const raw = location.pathname.replace(/^\/+/, '')
  if (!raw) return null
  const segments = raw.split('/').filter(Boolean)
  const slug = decodeURIComponent(segments[0] ?? '')
  if (!slug) return null
  const path = segments
    .slice(1)
    .map(segment => decodeURIComponent(segment))
    .join('/')
  return { slug, path }
}

/** 文档 URL（保留分支查询串：读者切分支后整站都带同一个 branch） */
export function docUrl(slug: string, path: string): string {
  const rest = path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')
  const base = `/${encodeURIComponent(slug)}${rest ? `/${rest}` : ''}`
  return `${base}${location.search}`
}

/**
 * 写地址栏。
 *
 * `push` 用于文档切换（后退应回到上一篇）；`replace` 用于标签切换与首次装载
 * （那是同一个位置的状态变化，不该在历史里留重复项）。
 */
function write(url: string, mode: 'push' | 'replace'): void {
  if (!isWebHost) return
  if (location.pathname + location.search === url) return
  try {
    if (mode === 'push') history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  } catch {
    // 沙箱里被拒（极少见）：URL 不更新不影响阅读，静默降级
  }
}

export function pushDocUrl(slug: string, path: string): void {
  write(docUrl(slug, path), 'push')
}

export function replaceDocUrl(slug: string, path: string): void {
  write(docUrl(slug, path), 'replace')
}

/**
 * 回到文档库的地址。
 *
 * **不能无条件写成 `/`**：`location.pathname` 已经是仓库深链时把它抹掉，
 * 刷新/前进后退就丢了位置。只有真的在库首页时才什么都不做；深链状态下
 * 这个函数不该被调用——调用方（标签 watcher）在初始路由落定前也不会调它。
 * 这里的判断是最后一道防线。
 */
export function replaceLibraryUrl(): void {
  if (!isWebHost) return
  const url = `/${location.search}`
  if (location.pathname + location.search === url) return
  write(url, 'replace')
}

/**
 * 读当前分支选择（`?branch=`；缺省 null = 各仓默认分支）。
 *
 * 放在路由层而不是散在组件里：分支是 URL 的一部分，任何需要它的地方
 * （树、搜索索引、文档读取、界面上的当前值）都必须读到同一个答案。
 */
export function readBranch(): string | null {
  if (!isWebHost) return null
  return new URLSearchParams(location.search).get('branch') || null
}

/**
 * 切换读者分支：替换 `?branch=` 后整页重载。
 *
 * 为什么重载而不是就地重拉：切分支等于换了整个内容根（树、搜索索引、插件
 * 目录、所有已打开文档）——就地刷新要逐个失效，漏一个就会出现「树是新的、
 * 正文是旧的」。整页重载是这里唯一不会错的做法。
 *
 * **基准路径不能直接取 `location.pathname`**：在文档库首页（`/`）切某个仓库的
 * 分支时，那个路径里没有仓库段，拼出来就是 `/?branch=x`——仓库上下文丢了，
 * 读者被丢回一个空首页。这里按「当前是否已在这个仓库里」决定基准：
 * 在仓内就留在当前文档，否则落到该仓落地页。
 *
 * 指向默认分支时清掉参数，URL 保持干净（与旧壳口径一致）。
 */
export function switchBranch(slug: string, branch: string): void {
  if (!isWebHost) return
  const target = branchUrl(
    location.pathname,
    location.search,
    slug,
    branch,
    portalDefaultBranch(slug),
  )
  location.assign(target)
}

/** 默认分支查表：由 App 在装载仓库清单后注入（避免路由层再请求一次 /api/portal） */
let defaultBranchLookup: (slug: string) => string | null = () => null

export function setDefaultBranchLookup(lookup: (slug: string) => string | null): void {
  defaultBranchLookup = lookup
}

function portalDefaultBranch(slug: string): string | null {
  return defaultBranchLookup(slug)
}

/** 订阅浏览器前进/后退（容器版；桌面返回空操作） */
export function onRouteChange(callback: (route: WebRoute | null) => void): () => void {
  if (!isWebHost) return () => undefined
  const handler = (): void => callback(readRoute())
  window.addEventListener('popstate', handler)
  return () => window.removeEventListener('popstate', handler)
}
