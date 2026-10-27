/**
 * 打包态缺陷回归（2026-10-22 安装包首次冒烟发现）。
 *
 * 1. 内置插件目录在打包产物里是 `<包>/<版本>/` 两层（assemble-plugins.mjs 生成），
 *    开发态是一层；扫描器只认一层会让安装包里「一个插件都没有」。
 * 2. 工作区注册表文件是外部可编辑的，形状写坏时不能把启动路径打崩（白屏）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const { createPluginStore } = await import('../apps/desktop/src/main/plugin-store.ts')
const { createWorkspaceStore } = await import('../apps/desktop/src/main/store.ts')

function makeManifest(dir, name, version) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name,
        displayName: { zh: name },
        version,
        apiVersion: '1',
        entry: 'dist/index.js',
        trust: 'presentation',
      },
      null,
      2,
    ),
    'utf8',
  )
}

test('内置插件：扁平目录（开发态）能被发现', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-plugins-flat-'))
  try {
    makeManifest(join(root, 'pack', 'base'), 'pack', '0.1.0')
    const store = createPluginStore({
      builtinDir: join(root, 'pack'),
      userDir: join(root, 'user'),
      stateFile: join(root, 'state.json'),
    })
    assert.deepEqual(
      store.list().map(item => item.manifest.name),
      ['pack'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('内置插件：带版本层（打包态）能被发现，且取最高版本', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-plugins-versioned-'))
  try {
    makeManifest(join(root, 'pack', '0.1.0'), 'pack', '0.1.0')
    makeManifest(join(root, 'pack', '0.2.0'), 'pack', '0.2.0')
    const store = createPluginStore({
      builtinDir: root,
      userDir: join(root, 'user'),
      stateFile: join(root, 'state.json'),
    })
    const records = store.list()
    assert.equal(records.length, 1)
    assert.equal(records[0].manifest.version, '0.2.0')
    assert.equal(records[0].error, null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工作区注册表形状被写坏时退回空列表，不抛异常', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-workspaces-'))
  try {
    const file = join(root, 'workspaces.json')
    // 历史上有过错误写法：把数组包在对象里
    writeFileSync(file, JSON.stringify({ workspaces: [] }), 'utf8')
    const store = createWorkspaceStore(file)
    assert.deepEqual(store.list(), [])
    assert.equal(store.find('nope'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('工作区注册表损坏（非 JSON）时退回空列表', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-workspaces-bad-'))
  try {
    const file = join(root, 'workspaces.json')
    writeFileSync(file, 'not json at all', 'utf8')
    const store = createWorkspaceStore(file)
    assert.deepEqual(store.list(), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('electron-builder 顶层声明 executableName（mac/linux 打包必填）', () => {
  /*
   * 全平台构建实测踩到：包名是 `@docvi/desktop`（带 scope），未声明
   * executableName 时 electron-builder 拿包名推导可执行文件名，得到
   * `@docvidesktop`；`@` 在 mac/linux 的文件路径里非法，dmg/AppImage
   * 直接在打包阶段失败。Windows 段原先单独写了 executableName，所以本地
   * 只打 Windows 包永远看不到这个问题——只有在 CI 三平台一起跑时暴露。
   */
  const yml = readFileSync(join(root, 'apps', 'desktop', 'electron-builder.yml'), 'utf8')
  const topLevel = /^executableName:[ \t]*(\S+)[ \t]*$/m.exec(yml)
  assert.ok(topLevel, 'electron-builder.yml 顶层必须声明 executableName')
  assert.match(topLevel[1], /^[A-Za-z0-9._-]+$/, 'executableName 只能含字母数字与 . _ -')

  const pkgName = JSON.parse(
    readFileSync(join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
  ).name
  assert.ok(
    !pkgName.startsWith('@') || topLevel,
    '包名带 scope 时更必须有顶层 executableName，否则会推导出含 @ 的非法文件名',
  )
})

/* ---------- 多平台打包配置（三平台齐全） ---------- */

/** 读 electron-builder 配置的纯文本（YAML 只有两三级结构，正则足够稳） */
function builderConfig() {
  return readFileSync(join(root, 'apps', 'desktop', 'electron-builder.yml'), 'utf8')
}

test('三平台目标齐全：Windows 安装包 / macOS dmg / Linux AppImage + deb', () => {
  const yml = builderConfig()
  assert.match(yml, /^win:\s*$/m, '缺少 win 段')
  assert.match(yml, /^mac:\s*$/m, '缺少 mac 段（mac 用户拿不到安装包）')
  assert.match(yml, /^linux:\s*$/m, '缺少 linux 段')

  assert.match(yml, /nsis/, 'Windows 应产出 NSIS 安装包')
  assert.match(yml, /-\s*target:\s*dmg/, 'macOS 应产出 dmg')
  assert.match(yml, /AppImage/, 'Linux 应产出 AppImage')
  assert.match(yml, /-\s*target:\s*deb/, 'Linux 还应产出 deb（dpkg 系用户默认要装 deb）')
})

test('macOS 双架构且显式 ad-hoc 签名', () => {
  const yml = builderConfig()
  const macBlock = /^mac:\n([\s\S]*?)(?=^\S)/m.exec(yml)?.[1] ?? ''
  assert.ok(macBlock, '找不到 mac 段内容')
  assert.match(macBlock, /-\s*x64/, 'mac 段缺少 x64 架构')
  assert.match(macBlock, /-\s*arm64/, 'mac 段缺少 arm64 架构（Apple Silicon 用户）')
  /*
   * 无证书时必须显式 identity: '-'：Electron 默认不退回 ad-hoc，
   * 而 Apple Silicon 拒绝运行未签名的 arm64 代码（双击直接报损坏）。
   */
  assert.match(macBlock, /identity:\s*'?'?-'?'?/, '缺少 ad-hoc 签名（identity: -）')
  /*
   * 未公证时开启 Hardened Runtime，ad-hoc 签名会拒绝 Electron 预签名框架
   * （Team ID 不同），表现为应用启动即崩。
   */
  assert.match(macBlock, /hardenedRuntime:\s*false/, '必须关闭 hardenedRuntime（否则启动即崩）')
})

test('publish 必须为 null（隐式发布会把成功的构建判成失败）', () => {
  const yml = builderConfig()
  /*
   * 曾写成 `provider: github`：electron-builder 在 CI 里生成完产物就去发布，
   * 拿不到 token 直接报错——包已打好却整步判失败（实测三平台同时红）。
   * 靠「不给 GH_TOKEN」关不掉。
   */
  assert.match(yml, /^publish:\s*null\s*$/m, 'electron-builder 配置里 publish 必须是 null')
  // 只检查**生效语句**：注释里为了解释来龙去脉会提到 `provider: github`
  const effective = yml
    .split(/\r?\n/)
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
  assert.doesNotMatch(effective, /provider:\s*github/, '不得在配置里声明 github 发布渠道')
})

test('产物命名带平台与架构（三平台资产不会互相覆盖）', () => {
  const yml = builderConfig()
  assert.match(
    yml,
    /artifactName:\s*docvi-\$\{version\}-win-\$\{arch\}-setup\.\$\{ext\}/,
    'win 产物名',
  )
  assert.match(yml, /artifactName:\s*docvi-\$\{version\}-mac-\$\{arch\}\.\$\{ext\}/, 'mac 产物名')
  assert.match(
    yml,
    /artifactName:\s*docvi-\$\{version\}-linux-\$\{arch\}\.\$\{ext\}/,
    'linux 产物名',
  )
})

test('发版工作流为三平台分别指定 electron-builder 平台参数', () => {
  const wf = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  assert.match(wf, /--win --x64/, 'windows job 应显式传 --win --x64')
  assert.match(wf, /--mac --x64 --arm64/, 'macos job 应传 --mac 且双架构')
  assert.match(wf, /--linux --x64/, 'linux job 应传 --linux --x64')
  // Artifact 收集路径必须与产物名对应，否则 upload-artifact 会因找不到文件而失败
  assert.match(wf, /release\/\*-setup\.exe/, 'win 资产路径')
  assert.match(wf, /release\/\*\.dmg/, 'mac 资产路径')
  assert.match(wf, /release\/\*\.deb/, 'linux 应同时收集 deb')
})

test('electron-builder 配置能通过官方 schema 校验（键名写错会在打包时才炸）', async () => {
  /*
   * electron-builder 对未知键**静默忽略**：把 `hardenedRuntime` 写成
   * `hardened-runtime`，配置照常加载、包照常产出，只是那个开关不生效——
   * 到了 macOS 上表现为「应用启动即崩」，而日志里一个警告都没有。
   * 只有拿它自己的 schema 跑一遍才能在打包前发现。
   */
  let schema
  try {
    schema = JSON.parse(
      readFileSync(join(root, 'node_modules', 'app-builder-lib', 'scheme.json'), 'utf8'),
    )
  } catch {
    // 依赖未安装（如纯脚本环境）：跳过而不是失败，避免门禁因环境差异变红
    return
  }
  const { parse } = await import('yaml')
  const AjvModule = await import('ajv')
  const Ajv = AjvModule.default ?? AjvModule
  const config = parse(builderConfig())
  const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true })
  const validate = ajv.compile(schema)
  const ok = validate(config)
  const detail = (validate.errors ?? [])
    .slice(0, 6)
    .map(err => `${err.instancePath || '/'} ${err.message}`)
    .join('; ')
  assert.ok(ok, `electron-builder 配置不符合 schema：${detail}`)
})

/* ---------- 发版必须带版本说明 ---------- */

test('发版工作流：缺版本说明时立即失败，不发出无声明的 Release', () => {
  const wf = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  /*
   * 没有说明的 Release 是最糟的一类发布：用户看得见「有新版本」，
   * 却不知道改了什么。所以校验要放在**打三平台包之前**（version job 里），
   * 而不是等二十分钟编译完才发现没写。
   */
  const versionJob = /^ {2}version:[\s\S]*?(?=^ {2}\w+:)/m.exec(wf)?.[0] ?? ''
  assert.ok(versionJob, '找不到 version job')
  assert.match(versionJob, /release-notes\.mjs/, 'version job 必须在决定发版时校验版本说明存在')
  assert.match(versionJob, /::error::/, '缺说明时要给出明确的错误信息')

  const publishJob = /^ {2}publish:[\s\S]*$/m.exec(wf)?.[0] ?? ''
  assert.ok(publishJob, '找不到 publish job')
  assert.match(publishJob, /--notes-file/, 'Release 正文必须来自 CHANGELOG 抽取的说明文件')
  assert.doesNotMatch(
    publishJob,
    /--generate-notes/,
    '不得用自动生成的提交标题列表当正文（对用户没有信息量）',
  )
  assert.match(
    publishJob,
    /gh release edit[\s\S]*--notes-file/,
    '重跑时应刷新已发布 Release 的正文',
  )
})

test('CHANGELOG 与当前版本、latest.json 三者对齐', () => {
  const readJSON = (...parts) => JSON.parse(readFileSync(join(root, ...parts), 'utf8'))
  const version = readJSON('package.json').version
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  // 用字符串包含判断，避免在正则里拼版本号（点号要转义，极易在传参时被吃掉）
  assert.ok(
    changelog.includes(`## [${version}]`),
    `CHANGELOG.md 缺少 ${version} 小节——发版会被工作流拒绝`,
  )
  assert.match(changelog, /^## \[未发布\]$/m, 'CHANGELOG 应保留「未发布」占位小节')
  // latest.json 的 notes 是应用内更新提示显示的那一行，空着等于用户看不到任何说明
  const manifest = readJSON('latest.json')
  assert.equal(manifest.version, version, 'latest.json 版本必须与 package.json 一致')
  assert.ok(
    typeof manifest.notes === 'string' && manifest.notes.trim().length >= 20,
    'latest.json 的 notes 不能为空（应用内更新提示直接显示它）',
  )
})
