/**
 * 图组件的文本度量与折行（FlowDiagram / StateFlow / TableGraph 共用）。
 *
 * 为什么自己估算而不量 DOM：布局要在**渲染前**算出节点尺寸与连线通道，
 * 逐个挂载量一次再重排会让图闪两帧，且 RTL/字体加载时序都不可控。
 * 估算只用于定宽/折行，实际渲染由浏览器排版——所以折行结果只会偏窄（留白多一点），
 * 不会溢出（节点宽度按估算值算，若估算偏小才会溢出，故按偏大取整）。
 */

/** 全角判定：CJK、假名、CJK 标点、全角符号、箭头、私用区 */
function isWide(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x2190 && code <= 0x21ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  )
}

/**
 * 单字符宽度估算。
 * - CJK / 全角：一个字号宽
 * - 等宽西文（状态码、字段名）：0.62 字号（Consolas 实测比例）
 * - 比例西文：0.56 字号
 */
export function charWidth(ch: string, fontSize: number, mono = false): number {
  const code = ch.codePointAt(0) ?? 0
  if (isWide(code)) return fontSize
  return fontSize * (mono ? 0.62 : 0.56)
}

export function textWidth(text: string, fontSize: number, mono = false): number {
  let width = 0
  for (const ch of String(text)) width += charWidth(ch, fontSize, mono)
  return width
}

/** 折行 token：拉丁词整体、空白整体、其余逐字（CJK 逐字可断） */
const TOKEN_RE = /[A-Za-z0-9_.:/-]+|\s+|[\s\S]/g
/** 超长标识符的可断点（断在这些符号**之后**才可读：local_preprocessing_ / enabled） */
const SEGMENT_RE = /[^_.:/-]+[_.:/-]*/g

export interface WrapOptions {
  fontSize: number
  mono?: boolean
  /** 最多几行；超出时最后一行加省略号 */
  maxLines?: number
}

/**
 * 按可用宽度折行。
 * - CJK 逐字断；
 * - 拉丁按词断；
 * - 单词本身超宽时先按 `_ - . : /` 分段，仍超宽再逐字符硬断（必须有解，
 *   否则 `local_preprocessing_enabled` 这类字段会撑破节点）。
 */
export function wrapText(text: string, maxWidth: number, options: WrapOptions): string[] {
  const { fontSize, mono = false, maxLines = Number.POSITIVE_INFINITY } = options
  const measure = (value: string) => textWidth(value, fontSize, mono)
  const source = String(text ?? '')
  if (!source) return ['']
  if (measure(source) <= maxWidth) return [source]

  const tokens = source.match(TOKEN_RE) ?? []
  const lines: string[] = []
  let current = ''
  const push = () => {
    if (current.trim()) lines.push(current.trim())
    current = ''
  }

  for (const token of tokens) {
    if (measure(current + token) <= maxWidth) {
      current += token
      continue
    }
    if (measure(token) <= maxWidth) {
      push()
      current = token.trimStart()
      continue
    }
    // 单词超宽：先在分隔符后断，逐段塞入
    push()
    const segments = token.match(SEGMENT_RE) ?? [token]
    let chunk = ''
    for (const segment of segments) {
      if (chunk && measure(chunk + segment) > maxWidth) {
        lines.push(chunk)
        chunk = ''
      }
      if (measure(segment) <= maxWidth) {
        chunk += segment
        continue
      }
      // 单段仍超宽（无分隔符长串）：逐字符硬断兜底
      for (const ch of segment) {
        if (chunk && measure(chunk + ch) > maxWidth) {
          lines.push(chunk)
          chunk = ''
        }
        chunk += ch
      }
    }
    current = chunk
  }
  push()
  const result = lines.length ? lines : ['']
  if (result.length <= maxLines) return result

  // 超出行数上限：截断并补省略号（调用方按 maxLines 预留高度）
  const kept = result.slice(0, maxLines)
  let last = kept[kept.length - 1]
  while (last && measure(`${last}…`) > maxWidth) last = last.slice(0, -1)
  kept[kept.length - 1] = `${last}…`
  return kept
}

/** 折行后取最宽行（用于定节点宽度 / 标签药丸宽度） */
export function widestLine(lines: string[], fontSize: number, mono = false): number {
  let width = 0
  for (const line of lines) width = Math.max(width, textWidth(line, fontSize, mono))
  return width
}
