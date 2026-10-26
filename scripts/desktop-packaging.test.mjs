/**
 * 打包态缺陷回归（2026-10-22 安装包首次冒烟发现）。
 *
 * 1. 内置插件目录在打包产物里是 `<包>/<版本>/` 两层（assemble-plugins.mjs 生成），
 *    开发态是一层；扫描器只认一层会让安装包里「一个插件都没有」。
 * 2. 工作区注册表文件是外部可编辑的，形状写坏时不能把启动路径打崩（白屏）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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
