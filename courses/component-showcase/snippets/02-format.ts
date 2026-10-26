/** 把字节数格式化为易读字符串（1024 进制，保留一位小数） */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = ''
  for (const candidate of units) {
    value /= 1024
    unit = candidate
    if (value < 1024) break
  }
  return `${value.toFixed(fractionDigits)} ${unit}`
}
