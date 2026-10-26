/**
 * 版本号比较（无依赖、无 Electron）。
 *
 * 单独成文件的原因：`update.ts` 要 import `electron` 取版本与路径，纯 Node 单测
 * 加载不到；而版本比较恰恰是最该被单测覆盖的部分（比错了会让「已是最新」骗人）。
 * 把纯函数摘出来，两端都能用同一份。
 */

/**
 * 版本比较：返回 -1 / 0 / 1。
 *
 * 只认 `x.y.z`（可带 `v` 前缀与 `-prerelease`）。不引 semver 包——只比自己的
 * 版本号，规则固定：数字段逐位比较（`1.10.0` > `1.9.0`，字符串序会判反）；
 * 同号时带预发布标记的更旧（`1.0.0-beta` < `1.0.0`）。
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { nums: number[]; pre: string } => {
    const [core = '', pre = ''] = value.trim().replace(/^v/i, '').split('-', 2)
    const nums = core.split('.').map(part => Number.parseInt(part, 10) || 0)
    return { nums, pre }
  }
  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.nums.length, right.nums.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre > right.pre ? 1 : -1
}

/** 只接受 https 的下载页：老清单可能写着 http，也可能被篡改 */
export function trustedHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return new URL(value.trim()).protocol === 'https:' ? value.trim() : undefined
  } catch {
    return undefined
  }
}
