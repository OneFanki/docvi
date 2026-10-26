/**
 * 组件示例预览路由的解析（纯函数）。
 *
 * 真实踩过的坑：运维页的「预览」按钮指向 `/_/preview/<包名>/<kind>`，而渲染层
 * 只认 `/<仓库>/<文档>` 这一种路由——`_` 被当成仓库 slug，查不到就静默回落到
 * 文档库首页。用户看到的是「点预览打开了一个 docvi 页面，但没看到预览」。
 *
 * 单独成文件而不是塞进 `web-router.ts`：那边在模块顶层读 `window.docvi.hostKind`，
 * 纯函数测试没法直接加载。这里不碰任何宿主状态，只做字符串解析。
 */

export interface PreviewRoute {
  plugin: string
  kind: string
}

/** 预览路由前缀（部署器 httpd 的保留段，见 README「保留段」） */
export const PREVIEW_PREFIX = '/_/preview/'

/**
 * 从 pathname 解析预览路由；不是预览路径返回 null。
 *
 * 只认 `/_/preview/<plugin>/<kind>`（允许尾斜杠）。缺 kind 时返回 null 而不是
 * 猜一个——猜出来的 kind 会拿去请求一个必然 404 的示例端点。
 */
export function parsePreviewRoute(pathname: string): PreviewRoute | null {
  if (!pathname.startsWith(PREVIEW_PREFIX)) return null
  const rest = pathname.slice(PREVIEW_PREFIX.length).replace(/\/+$/, '')
  const segments = rest.split('/').filter(Boolean)
  if (segments.length < 2) return null
  return {
    plugin: safeDecode(segments[0] ?? ''),
    kind: safeDecode(segments[1] ?? ''),
  }
}

/** 非法百分号编码不该让整页崩掉：解不出来就用原串 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
