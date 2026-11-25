/**
 * 大图查看的尺寸规则（纯函数，可单测）。
 *
 * 背景：用户报「mermaid 图的大图查看其实看不清」。根因是 mermaid 产物把根
 * `<svg>` 写成 `width="100%"` —— 在正文里这是对的（跟随阅读列），但放进灯箱的
 * `width: max-content` 容器后，百分比宽度没有可参照的包含块，浏览器按 SVG 的
 * 初始值兜底成 300px：800×949 的图被排成 300×356，再放大也是糊的。
 *
 * 真实尺寸只能从 `viewBox` 取：它是原作者坐标系，与任何布局无关。
 */

export interface PinnedSize {
  width: number
  height: number
}

/**
 * 按 viewBox 算出应当钉死的像素尺寸。
 *
 * 返回 `null` 表示无法确定（没有 viewBox / 宽高非正），此时**不要**改属性的
 * 宽度——交给浏览器按 CSS 处理，比为 0 或猜测值好。
 */
export function pinSize(
  declaredWidth: string | null | undefined,
  viewBox: string | null | undefined,
): PinnedSize | null {
  const box = parseViewBox(viewBox)
  if (!box) return null
  /*
   * 只有相对宽度（百分比 / auto / 空）才需要钉：已经是绝对像素时保持原值，
   * 避免把 640 改写成 639.9999 这类无意义的抖动。
   */
  if (isAbsoluteWidth(declaredWidth)) {
    const value = Number.parseFloat(String(declaredWidth))
    if (Number.isFinite(value) && value > 0)
      return { width: value, height: (value * box.h) / box.w }
  }
  return { width: box.w, height: box.h }
}

interface ViewBox {
  w: number
  h: number
}

function parseViewBox(value: string | null | undefined): ViewBox | null {
  if (!value) return null
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4) return null
  const w = parts[2]
  const h = parts[3]
  if (w === undefined || h === undefined) return null
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return { w, h }
}

function isAbsoluteWidth(value: string | null | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim()
  // `100%` / `auto` / `5em` 都不是像素：只有纯数字才是
  return /^\d*\.?\d+$/.test(trimmed)
}
