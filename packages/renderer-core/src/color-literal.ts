/**
 * 颜色字面量识别（行内代码颜色增强）。
 *
 * 只认「确定是颜色」的形态：hex（3/4/6/8 位）与 rgb/rgba/hsl/hsla 函数式写法。
 * 刻意不认 named 颜色——普通英文词误报太多，宁缺毋滥。
 */

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const FN_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/-]+\)$/i
const MAX_LENGTH = 40

/** 命中返回规范化后的 CSS 颜色值（用于色块背景），否则返回 null */
export function colorLiteral(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (!value || value.length > MAX_LENGTH) return null
  if (HEX_RE.test(value)) return value
  if (!FN_RE.test(value)) return null
  // 参数个数校验：拦住 rgb(255,0) 这类不完整写法
  const inner = value.slice(value.indexOf('(') + 1, -1).trim()
  const parts = inner.split(/[,\s/]+/).filter(Boolean)
  if (parts.length !== 3 && parts.length !== 4) return null
  return value
}
