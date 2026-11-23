#!/usr/bin/env node
/**
 * 补齐 Electron 二进制（`pnpm install` 的 postinstall 钩子）。
 *
 * ## 为什么需要这个脚本
 *
 * Electron 42 起移除了包内的 `postinstall` 脚本（供应链安全加固：二进制改为首次
 * 使用时懒下载，见 https://www.electronjs.org/blog/electron-42-0 ）。但
 * `electron-vite` 到 6.0.0 仍未适配——它的 `getElectronPath()` 只读 `path.txt`，
 * 读不到就直接 `throw new Error('Electron uninstall')`，既不触发懒下载，也不走
 * `require('electron')` 的自动安装兜底。结果：`pnpm install` 之后 `docvi:dev`
 * 必然失败，且缓存里明明有 zip 也用不上（没有脚本去解）。
 *
 * 对应上游 issue：alex8088/electron-vite#905（open）。
 * 该 PR 合入并发布后，本脚本连同根 package.json 的 postinstall 一起删除。
 *
 * ## 三个必须处理的约束
 *
 * - **容器与 CI 不要下 158MB**：Dockerfile 与 release workflow 都设
 *   `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。Electron 42+ 的 install.js 已不认这个变量
 *   （它是旧 postinstall 时代的约定），所以这里必须自己判断并直接退出。
 * - **幂等**：install.js 自带 `isInstalled()` 短路，重复执行不会重复下载。
 * - **可缺席**：非桌面场景（例如只装根依赖）可能没有 electron 包，静默跳过即可。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === '1') {
  console.log('[electron] 跳过二进制下载（ELECTRON_SKIP_BINARY_DOWNLOAD=1）')
  process.exit(0)
}

const require = createRequire(import.meta.url)
let electronDir
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  console.log('[electron] 未安装 electron 包，跳过')
  process.exit(0)
}

const pathFile = join(electronDir, 'path.txt')
const installScript = join(electronDir, 'install.js')
if (!existsSync(installScript)) {
  console.log('[electron] 包内没有 install.js（版本形态已变），跳过')
  process.exit(0)
}
if (existsSync(pathFile)) {
  console.log('[electron] 二进制已就绪，跳过')
  process.exit(0)
}

/*
 * 代理：`@electron/get` 5.x 走 Node 原生 fetch，而原生 fetch **不读** HTTP(S)_PROXY，
 * 必须靠 ELECTRON_GET_USE_PROXY=true 让它挂上 undici 的 EnvHttpProxyAgent。没设这个变量
 * 时下载直接 `TypeError: fetch failed`，错误里看不出是代理没生效（2026-11-23 实测）。
 * 只在用户已经配了代理变量时才开，避免给直连环境强行装 dispatcher。
 */
const hasProxyEnv = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(
  key => process.env[key],
)
const env = { ...process.env }
if (hasProxyEnv && !env.ELECTRON_GET_USE_PROXY) env.ELECTRON_GET_USE_PROXY = 'true'

const result = spawnSync(process.execPath, [installScript], {
  cwd: electronDir,
  stdio: 'inherit',
  env,
})
if (result.status !== 0) {
  console.error('[electron] 二进制安装失败；配置代理后重试：node node_modules/electron/install.js')
  process.exit(result.status ?? 1)
}
