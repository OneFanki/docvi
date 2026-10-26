/** 路径统一为 POSIX 分隔符（Windows 反斜杠 → 正斜杠） */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 自然排序：`page2` 排在 `page10` 前面（数字段按数值比较） */
export function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, 'zh-CN', { numeric: true })
}

/** 收集目录里的 Markdown 文件名（省略递归与过滤细节） */
export function collectMarkdown(names: string[]): string[] {
  return names
    .filter((name) => name.endsWith('.md'))
    .sort(naturalCompare)
}
