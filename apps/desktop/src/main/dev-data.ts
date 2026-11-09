import { join } from 'node:path'

/**
 * 数据目录归属：开发版与安装版必须各用一套。
 *
 * ## 为什么必须分离
 *
 * 开发版（`pnpm docvi:dev`）与安装版读的是同一个 `package.json` 的 name，
 * 因此 Electron 给两者的默认 userData 完全相同（`%APPDATA%/docvi`）。共用一套
 * 目录会同时出三个问题，而且都不报错、只表现为「诡异」：
 *
 *  1. **单实例锁互相顶掉**。锁文件在 userData 里：开着安装版再起开发版，新进程
 *     直接退出并唤起旧窗口——开发者会以为 dev 起不来。
 *  2. **数据互相污染**。`workspaces.json`、`settings.json`、会话、分享登记、
 *     插件安装记录全在同一份文件上，一边改动另一边立刻受影响；调试时的临时
 *     工作区会出现在用户的正式列表里。
 *  3. **Chromium 存储降级**。`Cache` / `Local Storage` / GPU 缓存都在 userData。
 *     两个不同 Electron 版本打开同一个 profile 是降级写，是 profile 损坏的经典来源。
 *
 * ## 判据顺序
 *
 * 显式指定 > 开发版默认隔离 > Electron 默认。
 *
 *  1. `DOCVI_DATA_DIR`（测试与截图用）：用调用方指定的，绝不另加隔离；
 *  2. `--user-data-dir=<path>`（Chromium 参数，e2e 也会用）：同上；
 *  3. 非打包运行（开发版）：`appData/docvi-dev`；
 *  4. 打包运行：不干预，用 Electron 算出来的 `appData/docvi`。
 *
 * 第 1、2 条必须排在前面：测试夹具自己会传临时目录，这里再叠一层隔离会把
 * 每次测试都写进开发者的真实数据目录——那是 AGENTS 明令禁止的。
 */

/** 开发版的数据目录名（安装版仍是 `docvi`）。 */
export const DEV_DATA_DIR_NAME = 'docvi-dev'

/** 开发版的应用名：窗口标题、托盘、单实例锁都以它区分。 */
export const DEV_APP_NAME = 'docvi dev'

/** 从 argv 里读 `--user-data-dir=<path>` 或 `--user-data-dir <path>`。 */
export function userDataDirArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--user-data-dir') {
      // 后一个参数若是另一个开关就不算路径：`--user-data-dir --remote-debugging-port`
      // 是「没给目录」，不是「目录叫 --remote-debugging-port」
      const next = argv[index + 1]?.trim() ?? ''
      return next && !next.startsWith('-') ? next : undefined
    }
    const prefix = '--user-data-dir='
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim()
      return value || undefined
    }
  }
  return undefined
}

/**
 * 这次运行该用哪个 userData 目录；`undefined` = 不干预，保持 Electron 的判定。
 *
 * 纯函数，不读全局状态——隔离规则错了只会表现为「数据跑到别处」，
 * 必须在测试里能把四种组合逐一断言。
 */
export function devDataDir(input: {
  packaged: boolean
  appDataDir: string
  argv: readonly string[]
  envOverride?: string | undefined
}): string | undefined {
  if (input.packaged) return undefined
  if (input.envOverride?.trim()) return undefined
  if (userDataDirArg(input.argv)) return undefined
  return join(input.appDataDir, DEV_DATA_DIR_NAME)
}
