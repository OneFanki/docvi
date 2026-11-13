/**
 * ASCII 图（框线字符）的对齐增强。
 *
 * 问题：等宽字体下，中日韩字符的宽度**不是** ASCII 字符的 2 倍——实测（2026-11-12，
 * Chrome + 仓库当前字体栈）：
 *
 * | 字符        | 应占 | 实际   |
 * | ----------- | ---- | ------ |
 * | 汉字 / 全角 | 2ch  | 1.707  |
 * | 制表符 ─│┌  | 1ch  | 1.000  |
 *
 * 每多一个汉字就少 0.293 格，几十个汉字累积下来，框线的竖线必然错位。
 * 「装一个等宽 CJK 字体」解决不了：Sarasa / Noto Mono CJK 让汉字变成正好 2ch，
 * 但制表符与箭头也一起变成 2ch，框线反而断成两倍宽。
 *
 * 解法：把宽字符包进 `display: inline-block; width: 2ch`，占位宽度由 CSS 决定，
 * 与字体无关。实测行宽偏差归零（见 scripts/dev/probe-ascii-align.mjs）。
 *
 * 只在**含框线字符**的代码块上启用：普通代码块里的中文注释不需要这个处理，
 * 包一层 span 反而会干扰选中与复制。
 */

/** 制表符 / 方块元素（box drawing）：U+2500–U+257F 与 U+2580–U+259F */
const BOX_DRAWING = /[\u2500-\u257f\u2580-\u259f]/

/**
 * 宽字符判定，按 East Asian Width 的 Wide / Fullwidth 区间。
 *
 * 刻意不追求完整 Unicode 表：这里只服务于「代码块里画出来的图」，用到的字符集
 * 就是汉字、假名、全角标点、带圈数字、CJK 符号与部分 Emoji。
 *
 * ⚠️ 漏判的后果不是「稍微不齐」而是**留白错位**：被漏判的字符不包锁宽 span，
 * 于是它按字体原宽渲染（汉字约 1.67ch），而它占的逻辑列数按 1 算——整行
 * 在这一点上就少了 0.67ch，后面的框线全部偏掉。
 *
 * ⚠️ East Asian Width 的 **Ambiguous** 类字符（`①` `②` 这类带圈数字、`·`
 * 间隔号、`±` `≤` 等）在东亚字体环境里通常按全宽渲染，但 `font-family` 换掉
 * 就可能变窄。这里按「实际会占 2 栏」处理，宁可多包一层也不能让它撑破对齐。
 */
function isFullWidth(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // 韩文字母
    (cp >= 0x2460 && cp <= 0x24ff) || // 带圈/带括号数字（Ambiguous，东亚按全宽）
    (cp >= 0x25a0 && cp <= 0x27bf) || // 几何图形、杂项符号、装饰符号（Ambiguous 多见）
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首、标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名、注音、CJK 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 韩文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角 ASCII
    (cp >= 0xffe0 && cp <= 0xffe6) || // 全角符号
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // Emoji（终端输出里常见）
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B 及以后
  )
}

/**
 * 这段代码是否「画出了一张 ASCII 图」。
 *
 * 判据：含制表符，且至少有一行同时出现制表符与宽字符。只有制表符（如纯 ASCII
 * 目录树）不需要处理——那些字符本来就都是 1ch，天然对齐。
 */
export function needsAsciiAlignment(code: string): boolean {
  if (!BOX_DRAWING.test(code)) return false
  for (const line of code.split('\n')) {
    if (!BOX_DRAWING.test(line)) continue
    for (const ch of line) {
      if (isFullWidth(ch.codePointAt(0) ?? 0)) return true
    }
  }
  return false
}

/** HTML 转义（& < >） */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 把宽字符包成定宽 2ch 的 span，让整块按「宽字符 = 2 格」稳定对齐。
 *
 * 制表符与其它窄字符保持自然宽度：它们在等宽字体里本来就是 1ch，包起来反而会
 * 引入额外的行内盒边界，破坏框线的连续性。
 */
export function alignAsciiBlock(code: string): string {
  let out = ''
  for (const ch of code) {
    if (isFullWidth(ch.codePointAt(0) ?? 0)) {
      out += `<span class="at-ascii-w2">${escapeHtml(ch)}</span>`
    } else {
      out += escapeHtml(ch)
    }
  }
  return out
}
