/**
 * 分支切换的 URL 计算（纯函数）。
 *
 * 单独成模块是为了能在 node 里直接单测：`web-router.ts` 依赖宿主判定
 * （`./host`），整模块在 node 下加载不了。而「切分支该落到哪个地址」恰好是
 * 最容易出错、又最不需要 DOM 的一段——真实踩过的两个坑都在这里：
 *
 *  1. 在文档库首页（`/`）直接拿 `location.pathname` 当基准，拼出 `/?branch=x`，
 *     仓库段丢失，读者被丢回空首页；
 *  2. 切回默认分支时没有清掉参数，URL 越积越长，与默认分支的干净地址不一致。
 */

/**
 * 算出切分支后应导航到的地址。
 *
 * @param currentPath 当前 `location.pathname`
 * @param currentSearch 当前 `location.search`（含前导 `?`，无参数传空串）
 * @param slug 目标仓库
 * @param branch 目标分支
 * @param defaultBranch 该仓库的默认分支（用于「切回默认就不带参数」）
 *
 * 基准路径规则：已经在这个仓库内就留在当前文档（读者换分支通常是为了
 * 对照同一篇）；不在仓内则落到该仓落地页——绝不能停在 `/`。
 */
export function branchUrl(
  currentPath: string,
  currentSearch: string,
  slug: string,
  branch: string,
  defaultBranch: string | null,
): string {
  const params = new URLSearchParams(currentSearch)
  if (defaultBranch && defaultBranch === branch) params.delete('branch')
  else params.set('branch', branch)
  const query = params.toString()

  const prefix = `/${encodeURIComponent(slug)}`
  const inRepo = currentPath === prefix || currentPath.startsWith(`${prefix}/`)
  const base = inRepo ? currentPath : `${prefix}/`
  return `${base}${query ? `?${query}` : ''}`
}
