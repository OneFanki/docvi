import { createWebHost } from './web-host'

/**
 * 宿主注入 —— **必须在 App 之前 import**。
 *
 * 渲染层有若干模块在**求值阶段**就读 `window.docvi`（比如搜索索引判断宿主是否
 * 自带索引、主题 store 取 bootSettings）。ESM 按 import 声明顺序求值依赖，
 * 所以这条 import 要放在 main.ts 的第一行；放在 App.vue 之后，那些模块拿到的
 * 就是 undefined。
 *
 * Electron 里 `window.docvi` 由 preload 在页面脚本之前挂好，这里不会覆盖。
 */
if (!window.docvi) {
  window.docvi = createWebHost({
    // 分支选择走 URL 查询串，读者切换分支时刷新页面即可
    branchOf: () => new URLSearchParams(location.search).get('branch') ?? null,
  })
}
