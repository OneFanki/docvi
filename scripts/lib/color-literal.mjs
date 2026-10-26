/**
 * 颜色字面量识别（行内代码颜色增强，设计见 docs/design/平台临时分享.md 附录）。
 *
 * 只认「确定是颜色」的形态：hex（3/4/6/8 位）与 rgb/rgba/hsl/hsla 函数式写法。
 * 刻意不认 named 颜色（red、orange 等）——普通英文词误报太多，宁缺毋滥。
 * 函数式写法保守限字符集（数字/百分号/逗号/斜杠/空格），不放过 deg 等单位写法。
 *
 * 纯函数、零依赖：壳渲染管线（markdown.ts 的行内代码规则）消费；
 * 单测 scripts/color-literal.test.mjs 直接跑本模块。
 */

/** hex：3/4/6/8 位（#fff / #ffff / #ffffff / #ffffffcc） */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** 函数式：rgb/rgba/hsl/hsla，参数只允许数字/百分号/逗号/斜杠/空格/加减号（保守） */
const FN_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%\s,/-]+\)$/i

/** 值长度上限（防异常长串进正则与内联样式） */
const MAX_LENGTH = 40

/**
 * 判断行内代码文本是否为颜色字面量。
 * @param {string} text 行内代码的原文
 * @returns {string | null} 命中返回规范化后的 CSS 颜色值（用于色块 background），否则 null
 */
export function colorLiteral(text) {
  if (typeof text !== 'string') return null
  const value = text.trim()
  if (!value || value.length > MAX_LENGTH) return null
  if (HEX_RE.test(value)) return value
  if (!FN_RE.test(value)) return null
  // 参数个数校验（保守）：逗号/空格/斜杠分隔后应为 3（rgb/hsl）或 4（rgba/hsla）；
  // 拦住 rgb(255,0) 这类参数不完整的写法
  const inner = value.slice(value.indexOf('(') + 1, -1).trim()
  const parts = inner.split(/[,\s/]+/).filter(Boolean)
  if (parts.length !== 3 && parts.length !== 4) return null
  return value
}
