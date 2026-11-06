/**
 * 用「图解沙箱页」打开一份自包含 HTML。
 *
 * 与 `plugins/base` 里 HtmlEmbed 的内部投递逻辑同源，但**不能共用代码**：
 * 插件包只允许依赖 vue（`scripts/check-boundaries.mjs` 强制），读不到宿主层模块。
 * 两边的协议常量必须保持一致（CHANNEL / 沙箱页文件名 / 消息形状），改一处要改两处。
 *
 * 为什么必须经沙箱页而不是直接 `window.open(assetUrl)`：
 *  - 桌面端资产地址是 `docvi://asset/…`，系统浏览器打不开这个自定义协议；
 *  - 即便能打开，应用入口页的 CSP 也不会限制它——那是另一份文档，反而失去
 *    「读不到本应用 DOM / 存储 / 身份」的边界。
 * 沙箱页自带 `default-src 'none'`，且内容落在不透明源的二级帧里，边界与内嵌态一致。
 *
 * 内容由**父页自己拉取**再投递，而不是让沙箱页去 fetch 资产地址：
 * 若在沙箱页放开 `connect-src`，图解里的脚本就能读取同一个工作区内的其它文档。
 * 投递协议（重试 + 回执）见沙箱页头部注释。
 */

/** 与沙箱页一致的通道名 */
const CHANNEL = 'docvi-html-embed'
const SANDBOX_FILE = 'embed-sandbox.html'
/** 重试投递的间隔与上限：沙箱页安装监听前投递会丢，必须重试 */
const RETRY_INTERVAL = 150
const DELIVERY_TIMEOUT = 8000

function randomToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function sandboxUrl(token: string): string {
  const url = new URL(`/${SANDBOX_FILE}`, window.location.href)
  url.searchParams.set('t', token)
  return url.href
}

export interface OpenHtmlResult {
  ok: boolean
  /** 失败原因（可直接展示给用户） */
  reason?: string
}

/**
 * 在新窗口打开一份 HTML 文本。
 *
 * ⚠️ 必须在用户点击的同步调用链里调用（`window.open` 要保住用户激活）；
 * 内部先同步开窗，再拉取内容、投递。因此调用方不要在前面 await 任何东西。
 *
 * @param options.title 窗口标题 / 无障碍标题
 * @param options.load  返回 HTML 文本；返回 null 表示内容不可用（占位已显示原因）
 */
export async function openHtmlInSandbox(options: {
  title: string
  load: () => Promise<string | null>
}): Promise<OpenHtmlResult> {
  if (typeof window === 'undefined') return { ok: false, reason: '当前环境不支持新窗口' }

  const token = randomToken()
  const win = window.open(sandboxUrl(token), '_blank')
  if (!win) return { ok: false, reason: '新窗口被拦截，请允许本站弹出窗口后重试' }

  const html = await options.load()
  if (!html) {
    try {
      win.close()
    } catch {
      // 窗口已关闭
    }
    return { ok: false, reason: '内容读取失败' }
  }

  let settled = false
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as
      { channel?: string; token?: string; type?: string } | null | undefined
    if (!data || data.channel !== CHANNEL || data.token !== token) return
    if (data.type !== 'mounted') return
    if (event.source && event.source !== win) return
    settled = true
    cleanup()
  }
  const cleanup = (): void => {
    window.removeEventListener('message', onMessage)
    window.clearTimeout(timer)
  }
  const timer = window.setTimeout(cleanup, DELIVERY_TIMEOUT)
  window.addEventListener('message', onMessage)

  // 与插件侧同一策略：反复投递直到回执，避免沙箱页尚未安装监听时丢消息
  const tick = (): void => {
    if (settled || win.closed) {
      if (!settled) cleanup()
      return
    }
    win.postMessage({ channel: CHANNEL, token, type: 'html', html, title: options.title }, '*')
    window.setTimeout(tick, RETRY_INTERVAL)
  }
  tick()

  try {
    // 回执走 event.source，不依赖 opener；切断后子窗口无法反向操纵本页
    win.opener = null
  } catch {
    // 个别宿主 opener 不可写，忽略
  }
  return { ok: true }
}

/**
 * 把正文里的站内链接还原成可 fetch 的资产地址。
 *
 * 两个宿主的地址空间不同（桌面 `docvi://asset/<工作区>`，容器 `/<仓库>`），
 * 而链接在渲染时已经按下发的 `linkPrefix` 拼过一次——先剥掉它，再用
 * `assetPrefix` 重拼，两种宿主才能走同一条路径。
 */
export function linkToAssetUrl(
  href: string,
  prefixes: { linkPrefix: string; assetPrefix: string },
): string {
  const rel =
    prefixes.linkPrefix && href.startsWith(prefixes.linkPrefix)
      ? href.slice(prefixes.linkPrefix.length)
      : href
  return prefixes.assetPrefix ? prefixes.assetPrefix + rel : rel
}
