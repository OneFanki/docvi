/**
 * 自动更新链路的回归测试。
 *
 * 三块最容易出错、且出错代价最高的逻辑：
 *   1. **资产匹配**——拿错架构的包，用户装完打不开；
 *   2. **文件名清洗**——发布资产名进路径拼接，必须挡住 `../`；
 *   3. **Windows 安装脚本**——拼错一个字，更新完应用就再也起不来。
 *
 * 网络与文件 IO 不在这里测（需要真进程），由探针覆盖。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

const { pickAsset, safeUpdateFileName, buildWindowsInstallScript, trustedAssetUrl } =
  await import('../apps/desktop/src/main/update-plan.ts')

const V = '0.3.0'

function asset(name, extra = {}) {
  return { name, url: `https://github.com/x/y/releases/download/v${V}/${name}`, ...extra }
}

test('Windows 取 exe，且按架构精确匹配', () => {
  const assets = [asset(`docvi-${V}-win-x64-setup.exe`), asset(`docvi-${V}-win-arm64-setup.exe`)]
  assert.equal(pickAsset(assets, 'win32', 'x64')?.name, `docvi-${V}-win-x64-setup.exe`)
  assert.equal(pickAsset(assets, 'win32', 'arm64')?.name, `docvi-${V}-win-arm64-setup.exe`)
})

test('macOS 取 dmg：arm64 与 x64 不串（串了在 Intel 上直接打不开）', () => {
  const assets = [asset(`docvi-${V}-mac-x64.dmg`), asset(`docvi-${V}-mac-arm64.dmg`)]
  assert.equal(pickAsset(assets, 'darwin', 'arm64')?.name, `docvi-${V}-mac-arm64.dmg`)
  assert.equal(pickAsset(assets, 'darwin', 'x64')?.name, `docvi-${V}-mac-x64.dmg`)
})

test('Linux 优先 AppImage 而非 deb（免安装、双击即用）', () => {
  const assets = [asset(`docvi-${V}-linux-amd64.deb`), asset(`docvi-${V}-linux-x86_64.AppImage`)]
  const picked = pickAsset(assets, 'linux', 'x64')
  assert.ok(picked?.name.endsWith('.AppImage'), `应优先 AppImage，实际 ${picked?.name}`)
})

test('没有匹配平台的资产时返回 null（回退到下载页，不猜）', () => {
  const assets = [asset(`docvi-${V}-win-x64-setup.exe`)]
  assert.equal(pickAsset(assets, 'darwin', 'arm64'), null)
  assert.equal(pickAsset([], 'linux', 'x64'), null)
})

test('线上真实资产名逐平台匹配（发布命名变了要能被这条测出来）', () => {
  // 与 v0.2.2 的实际资产名一致；命名来自 electron-builder 的 artifactName
  const assets = [
    asset('docvi-0.2.2-linux-amd64.deb'),
    asset('docvi-0.2.2-linux-x86_64.AppImage'),
    asset('docvi-0.2.2-mac-arm64.dmg'),
    asset('docvi-0.2.2-mac-x64.dmg'),
    asset('docvi-0.2.2-win-x64-setup.exe'),
  ]
  assert.equal(pickAsset(assets, 'win32', 'x64')?.name, 'docvi-0.2.2-win-x64-setup.exe')
  assert.equal(pickAsset(assets, 'darwin', 'arm64')?.name, 'docvi-0.2.2-mac-arm64.dmg')
  assert.equal(pickAsset(assets, 'darwin', 'x64')?.name, 'docvi-0.2.2-mac-x64.dmg')
  assert.equal(pickAsset(assets, 'linux', 'x64')?.name, 'docvi-0.2.2-linux-x86_64.AppImage')
})

test('文件名清洗：路径分隔与越级段一律被替换', () => {
  const name = safeUpdateFileName('../../evil.exe', V)
  assert.ok(!name.includes('/'), name)
  assert.ok(!name.includes('..'), name)
  assert.ok(!name.startsWith('.'), name)
})

test('文件名清洗：正常名保持可读（用户能在临时目录里认出来）', () => {
  assert.equal(
    safeUpdateFileName(`docvi-${V}-win-x64-setup.exe`, V),
    `docvi-${V}-win-x64-setup.exe`,
  )
  assert.equal(safeUpdateFileName(`docvi-${V}-mac-arm64.dmg`, V), `docvi-${V}-mac-arm64.dmg`)
})

test('文件名清洗：非 ASCII 字符被替换但不产生空名', () => {
  const name = safeUpdateFileName('安装包.exe', V)
  assert.ok(name.length > 4, name)
  assert.ok(name.endsWith('.exe'), `扩展名必须保留：${name}`)
})

test('安装脚本：先等进程退出，再静默安装，最后重启并自删', () => {
  const script = buildWindowsInstallScript({
    pid: 1234,
    installerPath: 'C:\\Temp\\docvi-update\\setup.exe',
    appExePath: 'C:\\Program Files\\docvi\\docvi.exe',
  })
  const waitAt = script.indexOf('tasklist.exe" /FI "PID eq 1234"')
  const installAt = script.indexOf('setup.exe" /S')
  const relaunchAt = script.indexOf('start ""')
  const deleteAt = script.indexOf('del "%~f0"')
  assert.ok(waitAt > 0, '必须等本进程退出（否则安装器覆盖不了运行中的 exe）')
  assert.ok(waitAt < installAt, '要先等退出再安装')
  assert.ok(installAt < relaunchAt, '装完再重启')
  assert.ok(relaunchAt < deleteAt, '最后才删脚本自己')
  // /S = NSIS 静默安装：不静默会弹出向导，而应用已经退出了
  assert.match(script, /\/S/)
})

/**
 * 这一段曾经把升级彻底弄坏，而按顺序断言的老测试是全绿的。
 *
 * 两个坑都在「等进程退出」里，且都是**外部命令的实际行为**与假设不符：
 *  1. `tasklist … | find "PID"` 里的 `find` 靠 PATH 解析。装了 Git for Windows
 *     的机器上解析到 Unix 版：它把参数当文件名、拿不到输入就阻塞读 stdin，
 *     升级永久卡在一个 cmd 窗口里。
 *  2. `if not errorlevel 1` 不能判断「进程还在」——`tasklist` 带 `/Filter` 时
 *     无论是否匹配都返回 0，循环会直接放行，安装器随即因文件占用失败。
 *
 * 所以这些断言不检查「代码长什么样」，而是钉住**必须满足的条件**：绝对路径
 * 调用、不能依赖退出码、必须读输出内容比对 PID。
 */
test('安装脚本：外部命令全部走 %SystemRoot% 绝对路径（PATH 上有 MSYS 版也不受影响）', () => {
  const script = buildWindowsInstallScript({
    pid: 4321,
    installerPath: 'C:\\Temp\\setup.exe',
    appExePath: 'C:\\app.exe',
  })
  assert.match(
    script,
    /"%SystemRoot%\\System32\\tasklist\.exe"/,
    'tasklist 必须走绝对路径：PATH 上有 Unix find 时，管道写法会阻塞读 stdin',
  )
  assert.match(
    script,
    /"%SystemRoot%\\System32\\timeout\.exe"/,
    'timeout 必须走绝对路径：Unix timeout 会把 /t 1 当非法间隔并立刻返回',
  )
  /*
   * 不能出现裸命令名。用词边界匹配，避免把上面已带路径的写法误判。
   * `find` 尤其要杜绝：它是这次升级卡死的直接原因。
   */
  assert.doesNotMatch(script, /(^|[\r\n])\s*tasklist\s/, '不允许裸 tasklist')
  assert.doesNotMatch(script, /(^|[\r\n])\s*timeout\s/, '不允许裸 timeout')
  assert.doesNotMatch(script, /\|\s*find\b/, '不允许 tasklist | find 这种依赖 PATH 的写法')
})

test('安装脚本：判断进程存活不依赖 tasklist 的退出码', () => {
  const script = buildWindowsInstallScript({
    pid: 4321,
    installerPath: 'C:\\Temp\\setup.exe',
    appExePath: 'C:\\app.exe',
  })
  /*
   * `tasklist /FI` 匹配与不匹配都返回 0，所以 `if not errorlevel 1` 恒真、
   * `if errorlevel 1` 恒假。两种都不许用来做存活判断。
   */
  assert.doesNotMatch(
    script,
    /if\s+(not\s+)?errorlevel\s+1/,
    'tasklist 带 /Filter 时退出码无意义，不能据此判断进程是否还在',
  )
  // 真正的判据：读输出第 2 列（唯一的数字列，不随系统语言变化）并与 PID 精确比对
  assert.match(script, /for \/f .*tokens=1,2/, '必须解析 tasklist 的输出列')
  assert.match(script, /if "%%B"=="4321"/, '必须把第 2 列与 PID 精确比对')
})

test('安装脚本：等待循环的输出走文件，不靠管道字面串', () => {
  const script = buildWindowsInstallScript({
    pid: 4321,
    installerPath: 'C:\\Temp\\setup.exe',
    appExePath: 'C:\\app.exe',
  })
  /*
   * `for /f` 直接读管道得到的是字面字符串，读文件才是真正的流。
   * 另外 PID 文件必须按 PID 命名并在每轮删掉，否则多实例并发升级会互相读到
   * 对方残留的内容。
   */
  assert.match(script, /set "PIDFILE=%TEMP%\\docvi-wait-4321\.txt"/)
  assert.match(script, />"%PIDFILE%"/, 'tasklist 输出必须重定向到文件')
  assert.match(script, /for \/f "usebackq[^"]*" %%A in \("%PIDFILE%"\)/, '必须从文件读')
  assert.match(script, /del "%PIDFILE%"/, '每轮读完要删，避免残留影响下一轮')
})

test('安装脚本：路径里的引号被转义（否则会截断参数）', () => {
  const script = buildWindowsInstallScript({
    pid: 7,
    installerPath: 'C:\\Temp\\a "quoted" name.exe',
    appExePath: 'C:\\app.exe',
  })
  assert.ok(script.includes('""quoted""'), '引号必须双写')
})

test('资产地址只接受可信域（重定向到别处一律拒绝）', () => {
  assert.ok(trustedAssetUrl('https://github.com/a/b/releases/download/v1/x.exe'))
  assert.ok(trustedAssetUrl('https://objects.githubusercontent.com/abc/x.exe'))
  /*
   * GitHub 的资产分发域名会变：v0.2.2 的 exe 实测 302 到
   * `release-assets.githubusercontent.com`。只认精确域名会让合法资产被自己拦下。
   */
  assert.ok(trustedAssetUrl('https://release-assets.githubusercontent.com/x.exe'))
  assert.ok(trustedAssetUrl('https://api.github.com/repos/x/y'))
  // 同形域名不算可信（后缀匹配必须以「.域」结尾）
  assert.equal(trustedAssetUrl('https://github.com.evil.com/x.exe'), null)
  assert.equal(trustedAssetUrl('https://githubusercontent.com.evil.com/x.exe'), null)
  assert.equal(trustedAssetUrl('https://evil.example.com/x.exe'), null)
  // 非 https
  assert.equal(trustedAssetUrl('http://github.com/x.exe'), null)
  assert.equal(trustedAssetUrl(''), null)
  assert.equal(trustedAssetUrl(null), null)
})

/* ---------------------------------------------------------------- 真 cmd 上跑 */

/**
 * 上面那些字符串断言只能守住「写法」；真正让人放心的是**脚本能跑起来**。
 *
 * 升级卡死的那个坑，按顺序断言的老测试是全绿的——因为问题不在顺序，而在
 * `tasklist | find` 与 `timeout /t` 在真实 cmd 里根本不是我们以为的行为。
 * 所以这里把生成的脚本放进真实 cmd.exe 执行，只把「安装」和「重启」换成
 * 无害操作，观察它是否按预期等待 / 放行。
 *
 * 只在 Windows 上跑；其它平台跳过（脚本本身就是 Windows 专用的）。
 */
const isWindows = process.platform === 'win32'

/** 把脚本里的安装/重启换成写标记文件，其余（等待逻辑）原样保留 */
function harmlesslyRewrite(script, markerPath) {
  const install = join(markerPath, 'installed.txt')
  const relaunch = join(markerPath, 'relaunched.txt')
  return (
    script
      /*
       * 脚本用 CRLF 拼的，`$` 在 `m` 模式下不会停在 `\r` 之前——必须显式吃掉它，
       * 否则正则永远匹配不到（第一版测试就是这么假绿的）。
       */
      .replace(/^.*\/S[ \t]*\r?$/m, `echo install > "${install}"`)
      .replace(/^start "" .*\r?$/m, `echo relaunch > "${relaunch}"`)
      // 自删这一步在测试里必须去掉：否则脚本跑完把自己删了，失败时没法复看
      .replace(/^del "%~f0"[ \t]*\r?$/m, '')
  )
}

test(
  '安装脚本：进程已不存在时立即继续（不卡在等待循环）',
  { skip: !isWindows && '仅 Windows' },
  async () => {
    const { mkdtempSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawnSync } = await import('node:child_process')

    const dir = mkdtempSync(join(tmpdir(), 'docvi-install-script-'))
    try {
      // 一个几乎不可能存在的 PID：脚本应当立刻判定「不在运行」并继续
      const deadPid = 999_999
      const scriptPath = join(dir, 'install.cmd')
      writeFileSync(
        scriptPath,
        harmlesslyRewrite(
          buildWindowsInstallScript({
            pid: deadPid,
            installerPath: join(dir, 'unused-setup.exe'),
            appExePath: join(dir, 'unused-app.exe'),
          }),
          dir,
        ),
        'utf8',
      )

      const started = Date.now()
      const result = spawnSync('cmd.exe', ['/c', scriptPath], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      })
      const elapsed = Date.now() - started

      assert.notEqual(result.error?.code, 'ETIMEDOUT', '进程不存在时不该卡住')
      /*
       * 判据是「继续往下走了」，不是退出码：脚本里 `del` / `start` 等命令
       * 的退出码会把最终 exit code 带歪，那不是这条测试要管的事。
       */
      assert.ok(
        existsSync(join(dir, 'installed.txt')),
        `没有走到安装这一步。stderr=${result.stderr}`,
      )
      assert.ok(elapsed < 20_000, `不该等这么久（${elapsed}ms）`)
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  },
)

test('安装脚本：进程还活着时会等，直到它退出', { skip: !isWindows && '仅 Windows' }, async () => {
  const { mkdtempSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn, spawnSync } = await import('node:child_process')

  const dir = mkdtempSync(join(tmpdir(), 'docvi-install-wait-'))
  let child = null
  try {
    /*
     * 起一个真进程当「正在运行的 docvi」。等待逻辑用真实 PID，才能走到
     * 「存活 → 等 1 秒 → 再查」这条路径。
     */
    child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'ignore' })
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(child.pid, '没有拿到子进程 PID')

    const scriptPath = join(dir, 'install.cmd')
    writeFileSync(
      scriptPath,
      harmlesslyRewrite(
        buildWindowsInstallScript({
          pid: child.pid,
          installerPath: join(dir, 'unused-setup.exe'),
          appExePath: join(dir, 'unused-app.exe'),
        }),
        dir,
      ),
      'utf8',
    )

    const started = Date.now()
    const result = spawnSync('cmd.exe', ['/c', scriptPath], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    const elapsed = Date.now() - started

    assert.notEqual(result.error?.code, 'ETIMEDOUT', '等待逻辑不能永远不退出')
    assert.ok(
      existsSync(join(dir, 'installed.txt')),
      `子进程退出后应当继续安装。stderr=${result.stderr}`,
    )
    /*
     * 关键断言：必须真的等过。子进程活 4 秒，脚本若立刻放行说明「存活判断」
     * 根本没生效——那正是 `tasklist` 退出码被误用时的表现。
     */
    assert.ok(elapsed >= 2500, `应当等子进程退出（实际只用了 ${elapsed}ms）`)
  } finally {
    child?.kill()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
