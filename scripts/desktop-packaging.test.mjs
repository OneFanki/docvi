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
