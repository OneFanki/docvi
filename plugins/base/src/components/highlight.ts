/**
 * 轻量、同步、零依赖的代码高亮（P0 教学组件用）。
 *
 * 采用「单行顺序扫描」：先做 HTML 转义，再依次标记字符串、注释、数字、关键字。
 * 局限：跨行的块注释/模板串无法跨行着色（单行扫描模型），且不保证覆盖所有语法；
 * 它对「我们精心整理的教学片段」足够清晰。P2 阶段可整体替换为 Shiki（与 VitePress
 * 同一高亮引擎）以获得完整语法着色，本模块保持函数签名兼容（输入明文 → 输出 HTML）。
 */

const KEYWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'of',
  'in',
  'new',
  'class',
  'extends',
  'import',
  'from',
  'export',
  'default',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'typeof',
  'instanceof',
  'switch',
  'case',
  'break',
  'continue',
  'delete',
  'void',
  'yield',
  'static',
  'get',
  'set',
  'public',
  'private',
  'protected',
  'readonly',
  'interface',
  'type',
  'enum',
  'namespace',
  'declare',
  'abstract',
  'implements',
  'keyof',
  'infer',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  'super',
  'NaN',
  'Infinity',
])

const KEYWORD_STYLES = {
  comment: 'color: var(--at-text-muted); font-style: italic;',
  string: 'color: var(--at-ok);',
  number: 'color: var(--at-warn);',
  keyword: 'color: var(--at-accent); font-weight: 600;',
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface Token {
  html: string
  style: string
  end: number
}

/** 单行扫描出一个 token；找不到则返回 null */
function scanToken(line: string, from: number): Token | null {
  const rest = line.slice(from)

  // 注释（行内）
  const lineComment = rest.match(/^\/\/.*/)
  if (lineComment) {
    return {
      html: escapeHtml(lineComment[0]),
      style: KEYWORD_STYLES.comment,
      end: from + lineComment[0].length,
    }
  }
  const blockComment = rest.match(/^\/\*[\s\S]*?\*\//)
  if (blockComment) {
    return {
      html: escapeHtml(blockComment[0]),
      style: KEYWORD_STYLES.comment,
      end: from + blockComment[0].length,
    }
  }

  // 字符串（' " `），含转义
  const str = rest.match(/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/)
  if (str) {
    return { html: escapeHtml(str[0]), style: KEYWORD_STYLES.string, end: from + str[0].length }
  }

  // 数字
  const num = rest.match(/^\b(?:0x[\da-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/)
  if (num) {
    return { html: escapeHtml(num[0]), style: KEYWORD_STYLES.number, end: from + num[0].length }
  }

  // 标识符 / 关键字
  const word = rest.match(/^[A-Za-z_$][\w$]*/)
  if (word) {
    const isKeyword = KEYWORDS.has(word[0])
    return {
      html: escapeHtml(word[0]),
      style: isKeyword ? KEYWORD_STYLES.keyword : '',
      end: from + word[0].length,
    }
  }

  return null
}

/**
 * 把一行明文代码转成带高亮 span 的 HTML。
 * @param line 单行代码文本
 * @returns 已转义 + 着色的 HTML 片段
 */
export function highlightLineHtml(line: string, _lang = 'ts'): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const next = line.charCodeAt(i)
    if (next === 32 || next === 9) {
      // 保留空白（含缩进）
      const seg = line.slice(i).match(/^[ \t]+/)
      if (seg) {
        out += escapeHtml(seg[0])
        i += seg[0].length
        continue
      }
    }
    const token = scanToken(line, i)
    if (token) {
      out += token.style ? `<span style="${token.style}">${token.html}</span>` : token.html
      i = token.end
    } else {
      out += escapeHtml(line.charAt(i))
      i += 1
    }
  }
  return out
}
