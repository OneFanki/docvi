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
  const waitAt = script.indexOf('tasklist /FI "PID eq 1234"')
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
