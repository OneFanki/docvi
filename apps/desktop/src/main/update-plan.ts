/**
 * 更新链路的纯逻辑（无 Electron、无网络、无文件 IO）。
 *
 * 单独成文件的原因与 `version.ts` 相同：主逻辑要 import `electron`，纯 Node
 * 单测加载不到；而这里的东西恰恰是最该被测试守住的——资产匹配错了用户装完
 * 打不开，文件名清洗漏了会拼出越级路径，安装脚本错了更新完应用就起不来。
 */

import { trustedHttpsUrl } from './version.ts'

export interface UpdateAssetLike {
  name: string
  url: string
  size?: number
  sha256?: string
}

/**
 * 资产下载地址的可信域。
 *
 * 只允许 GitHub 自己的域名。**必须按后缀匹配而不是精确相等**：GitHub 的资产
 * 分发域名会变，实测 v0.2.2 的 exe 从 `github.com` 302 到
 * `release-assets.githubusercontent.com`——只列 `objects.githubusercontent.com`
 * 时，下载会在「重定向到不受信任地址」这一步被自己拦下（合法的包也装不上）。
 *
 * 后缀匹配的写法要求「等于该域」或「以 `.该域」结尾，所以
 * `githubusercontent.com.evil.com` 这种同形域名进不来。
 */
const TRUSTED_ASSET_HOSTS = ['github.com', 'githubusercontent.com']

export function trustedAssetUrl(value: unknown): string | null {
  const url = trustedHttpsUrl(value)
  if (!url) return null
  try {
    const host = new URL(url).hostname.toLowerCase()
    const trusted = TRUSTED_ASSET_HOSTS.some(base => host === base || host.endsWith(`.${base}`))
    return trusted ? url : null
  } catch {
    return null
  }
}

/**
 * 本机应该下载哪个资产。
 *
 * 命名约定由 `apps/desktop/electron-builder.yml` 的 `artifactName` 决定：
 *   win   `docvi-<v>-win-<arch>-setup.exe`
 *   mac   `docvi-<v>-mac-<arch>.dmg`
 *   linux `docvi-<v>-linux-<arch>.AppImage` / `.deb`
 *
 * 匹配必须**同时**看平台与架构：arm64 的 Mac 拿到 x64 的 dmg 还能靠 Rosetta
 * 跑，反过来在 Intel Mac 上装 arm64 会直接打不开。
 */
export function pickAsset<T extends UpdateAssetLike>(
  assets: readonly T[],
  platform: string,
  arch: string,
): T | null {
  const want = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'
  const candidates = assets.filter(asset => asset.name.toLowerCase().includes(`-${want}-`))
  if (!candidates.length) return null
  const byArch = candidates.filter(asset => asset.name.includes(`-${arch}`))
  const pool = byArch.length ? byArch : candidates
  if (platform === 'win32') return pool.find(item => item.name.endsWith('.exe')) ?? null
  if (platform === 'darwin') return pool.find(item => item.name.endsWith('.dmg')) ?? null
  // Linux：AppImage 免安装、双击即用，优先于 deb
  return (
    pool.find(item => item.name.endsWith('.AppImage')) ??
    pool.find(item => item.name.endsWith('.deb')) ??
    null
  )
}

/**
 * 落盘文件名。
 *
 * 只保留保守字符集，并折叠连续点：`../../x.exe` 这类名字不能以任何形式存活
 * 到路径拼接里，哪怕目标目录是我们自己的。
 */
export function safeUpdateFileName(assetName: string, version: string): string {
  const ext = /\.(exe|dmg|AppImage|deb)$/i.exec(assetName)?.[0] ?? ''
  const safe = assetName
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[.\-_]+/, '')
  const name = safe || `docvi-${version}${ext}`
  return name.endsWith(ext) || !ext ? name : `${name}${ext}`
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

/**
 * Windows 安装脚本。
 *
 * 应用不能给自己装更新：NSIS 会就地替换 exe，而 Windows 拒绝覆盖正在运行的
 * 文件。所以先起一个脱离父进程的脚本、等本进程消失后再静默安装并重启。
 *
 * ## 「等进程退出」这一段被修过两次，两次都是因为轻信了外部命令的行为
 *
 * 1. **`tasklist … | find "PID"`**：`find` 靠 PATH 解析。装了 Git for Windows /
 *    MSYS 的机器上，`find` 会解析到 Unix 版——它把参数当文件名、拿不到输入时
 *    阻塞在读 stdin。结果是一个永不退出的 cmd 窗口加一个永退不掉的 `find`
 *    进程，升级卡死。（与 ensemble 踩的是同一个坑。）
 * 2. **`tasklist … & if not errorlevel 1`**：`tasklist` 带 `/Filter` 时**无论
 *    是否匹配都返回 0**，所以退出码不能用来判断「进程还在不在」，这个循环
 *    会立刻放行，安装器随即因文件占用失败。
 *
 * 现在：`tasklist.exe` / `timeout.exe` 全部走 `%SystemRoot%\System32\` 绝对
 * 路径（不依赖 PATH），输出重定向到文件后由 `for /f` 读第 2 列与 PID 精确
 * 比对（第 2 列是唯一的数字列，也不随系统语言变化）。
 */
export function buildWindowsInstallScript(input: {
  pid: number
  installerPath: string
  appExePath: string
}): string {
  const { pid, installerPath, appExePath } = input
  return [
    '@echo off',
    'setlocal',
    // 输出到文件而不是直接管道：`for /f` 需要一个真正的流来读，管道给的是字面串
    `set "PIDFILE=%TEMP%\\docvi-wait-${pid}.txt"`,
    ':waitForExit',
    `"%SystemRoot%\\System32\\tasklist.exe" /FI "PID eq ${pid}" /NH >"%PIDFILE%" 2>nul`,
    'set "STILL_RUNNING="',
    `for /f "usebackq tokens=1,2" %%A in ("%PIDFILE%") do if "%%B"=="${pid}" set "STILL_RUNNING=1"`,
    'del "%PIDFILE%" 2>nul',
    'if defined STILL_RUNNING (',
    // 绝对路径同理：PATH 上的 Unix `timeout` 会把 `/t 1 /nobreak` 当成非法
    // 时间间隔并立刻返回，循环变成空转而不是「安静地等一秒」
    '  "%SystemRoot%\\System32\\timeout.exe" /t 1 /nobreak >nul 2>nul',
    '  goto waitForExit',
    ')',
    `${quoteForCmd(installerPath)} /S`,
    `start "" ${quoteForCmd(appExePath)}`,
    'del "%~f0"',
    'endlocal',
    '',
  ].join('\r\n')
}
