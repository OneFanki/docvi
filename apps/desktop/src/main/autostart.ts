import { execFile } from 'node:child_process'
import { app } from 'electron'
import { promisify } from 'node:util'

/**
 * 开机自启动（Windows）。
 *
 * 走 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 而不是把快捷方式塞进
 * 启动文件夹：注册表是用户级（不需要管理员权限）、可读可删、失败时能立刻拿到
 * 退出码；启动文件夹还要处理 .lnk 生成，多一层依赖。
 *
 * 为什么不用 `app.setLoginItemSettings`：它在 Windows 上写的是
 * `HKCU\...\Run` 里带 updater 语义的键值（应用名为键），与「用户自己看得懂、
 * 能手动删掉」的目标不完全一致；而 macOS 上要另走 LaunchAgents。这里只做
 * Windows，直接写注册表最直接。
 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'docvi'

const exec = promisify(execFile)

async function reg(args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec('reg', args, { windowsHide: true })
    return { ok: true, out: stdout }
  } catch (error) {
    return { ok: false, out: error instanceof Error ? error.message : String(error) }
  }
}

/** 自启动时该执行的命令行：打包后是 exe 路径，开发态退回 electron + 应用目录 */
function launchCommand(): string {
  if (app.isPackaged) return `"${process.execPath}"`
  // 开发态：electron.exe + 应用目录。引号必须保留，路径里常有空格
  return `"${process.execPath}" "${app.getAppPath()}"`
}

export interface AutostartState {
  enabled: boolean
  /** 实际写入的命令行（便于用户核对） */
  command: string
  error: string | null
}

export async function readAutostart(): Promise<AutostartState> {
  if (process.platform !== 'win32') {
    return { enabled: false, command: '', error: '仅支持 Windows' }
  }
  const result = await reg(['query', RUN_KEY, '/v', VALUE_NAME])
  if (!result.ok) {
    // 值不存在时 reg 返回非零，这是「未开启」而不是错误
    return { enabled: false, command: '', error: null }
  }
  const match = /REG_SZ\s+(.+)$/m.exec(result.out)
  return { enabled: true, command: match?.[1]?.trim() ?? '', error: null }
}

export async function writeAutostart(enabled: boolean): Promise<AutostartState> {
  if (process.platform !== 'win32') {
    return { enabled: false, command: '', error: '仅支持 Windows' }
  }
  if (enabled) {
    const command = launchCommand()
    const result = await reg([
      'add',
      RUN_KEY,
      '/v',
      VALUE_NAME,
      '/t',
      'REG_SZ',
      '/d',
      command,
      '/f',
    ])
    return {
      enabled: result.ok,
      command: result.ok ? command : '',
      error: result.ok ? null : result.out,
    }
  }
  // 删除不存在的值同样返回非零：一律视为「已经是关闭状态」，不回传错误
  await reg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
  return { enabled: false, command: '', error: null }
}
