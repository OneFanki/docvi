/**
 * 插件服务单测（deployer 侧，协议 v1 阶段一）：
 * - 预设包目录（enabled 缺省 / 可禁用 / 可组件级停用；卸载被拒）；
 * - url: 渠道安装（下载 - 校验 - 落盘 - 登记；拒绝非法包与预设同名的第三方包）；
 * - 同名切换「最新者赢」（安装 / 手动切换的 replaced 报告 + 单活跃不变量）；
 * - 文件伺服防穿越与版本核对。
 *
 * 设计对齐：与 docs/design/平台插件化与 AI 分发.md
 * 和渲染层运行时（packages/plugin-runtime）的消费口径一致。
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { PluginError, createPluginsService, readPluginManifest } from '../src/plugins.mjs'

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'deployer-plugins-'))
}

/** 造一个最小合法插件包目录（内容符合协议 v1） */
function writePackage(root, { name, version = '0.1.0', kinds = ['demo-chart'] }) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), `export function activate() {}\n`)
  writeFileSync(join(dir, 'dist', 'style.css'), `.x{}\n`)
  writeFileSync(join(dir, 'docs', 'SKILL.md'), `# ${name}\n`)
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name,
      displayName: name,
      version,
      apiVersion: '1',
      entry: 'dist/index.js',
      styles: ['dist/style.css'],
      docs: 'docs/SKILL.md',
      components: kinds.map(kind => ({ kind, title: kind, description: `${kind} 用途` })),
    }),
  )
  return dir
}

/** 极简 tar 打包（ustar 普通文件，测试够用）；返回 gzip 后的 Buffer */
function tarballOf(pkgDir, topName) {
  const blocks = []
  const walk = rel => {
    for (const name of readdirSync(join(pkgDir, rel))) {
      const full = join(pkgDir, rel, name)
      if (statSync(full).isDirectory()) {
        walk(join(rel, name))
      } else {
        const content = readFileSync(full)
        const header = Buffer.alloc(512)
        header.write(`${topName}/${rel ? rel + '/' : ''}${name}`, 0)
        header.write('0000644', 100)
        header.write(content.length.toString(8).padStart(11, '0') + ' ', 124)
        header.write('0000000', 108)
        header.write('0000000', 116)
        header.write('00000000000', 136)
        header.write('        ', 148)
        header.write('0', 156)
        header.write('ustar', 257)
        header.write('00', 263)
        let sum = 0
        for (const byte of header) sum += byte
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
        blocks.push(header, content)
        const pad = (512 - (content.length % 512)) % 512
        if (pad) blocks.push(Buffer.alloc(pad))
      }
    }
  }
  walk('.')
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** fetch 假件：按预置 bundle 应答（校验 URL 协议与计数） */
function fakeFetch(bundle, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts })
    return {
      ok: true,
      headers: { get: () => String(bundle.length) },
      arrayBuffer: async () =>
        bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength),
    }
  }
}

function makeService(fetchImpl) {
  const root = tmpRoot()
  const dataDir = join(root, 'data')
  const platformDir = join(root, 'platform')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(platformDir, 'plugins'), { recursive: true })
  let config = { global: {}, repos: [], plugins: [] }
  const loadConfigData = () => JSON.parse(JSON.stringify(config))
  const saveConfigData = cfg => {
    config = JSON.parse(JSON.stringify(cfg))
  }
  const service = createPluginsService({
    dataDir,
    platformDir,
    version: 'test',
    loadConfigData,
    saveConfigData,
    fetchImpl: fetchImpl ?? (() => assert.fail('未预期的网络调用')),
  })
  return {
    root,
    dataDir,
    platformDir,
    builtinDir: join(platformDir, 'plugins'),
    makeBuiltin: opts => writePackage(join(platformDir, 'plugins'), opts),
    service,
    getConfig: () => config,
    setConfig: cfg => {
      config = cfg
    },
  }
}

test('预设包：目录缺省 enabled、可禁用、可组件级停用，卸载被拒', () => {
  const { service, makeBuiltin } = makeService()
  makeBuiltin({ name: 'docs-plugin-base', kinds: ['tutorial-shell', 'flow-diagram'] })
  let catalog = service.catalog()
  assert.equal(catalog.plugins.length, 1)
  assert.equal(catalog.plugins[0].enabled, true, '预设包无登记条目时缺省启用')
  assert.equal(catalog.plugins[0].builtin, true)
  assert.equal(catalog.plugins[0].components.length, 2)

  service.setPluginEnabled('docs-plugin-base', false)
  catalog = service.catalog()
  assert.equal(catalog.plugins[0].enabled, false)

  service.setPluginEnabled('docs-plugin-base', true)
  service.setComponentEnabled('docs-plugin-base', 'flow-diagram', false)
  catalog = service.catalog()
  assert.deepEqual(catalog.plugins[0].disabledComponents, ['flow-diagram'])

  assert.throws(
    () => service.uninstall('docs-plugin-base'),
    error => error instanceof PluginError && error.code === 'BUILTIN',
  )
})

test('预设包：目录条目带构建指纹，同版本改内容时指纹变化', () => {
  const { service, makeBuiltin, builtinDir } = makeService()
  makeBuiltin({ name: 'docs-plugin-base', kinds: ['flow-diagram'] })
  const first = service.catalog().plugins[0].build
  assert.match(first, /^[0-9a-z]+$/, '插件条目必须带构建指纹，供壳拼 ?v= 绕过 immutable 缓存')
  writeFileSync(join(builtinDir, 'docs-plugin-base', 'dist', 'style.css'), '.x{color:red}\n')
  assert.notEqual(service.catalog().plugins[0].build, first, '样式内容变化必须改变指纹')
})

test('安装 url: 渠道：下载 → 校验 → 落盘 → 登记 → 生效目录', async () => {
  const root = tmpRoot()
  const pkgDir = writePackage(root, { name: 'demo-plugin', kinds: ['demo-a'] })
  const bundle = tarballOf(pkgDir, 'demo-plugin')
  const calls = []
  const { service, dataDir } = makeService(fakeFetch(bundle, calls))

  const outcome = await service.install({
    source: 'url:https://example.com/demo-plugin-0.1.0.tar.gz',
  })
  assert.equal(outcome.installed.name, 'demo-plugin')
  assert.equal(outcome.installed.version, '0.1.0')
  assert.deepEqual(outcome.replaced, [])
  assert.equal(calls.length, 1, '恰好一次下载')
  assert.ok(existsSync(join(dataDir, 'plugins', 'demo-plugin', '0.1.0', 'plugin.json')), '包落盘')
  const catalog = service.catalog()
  assert.equal(catalog.plugins.length, 1)
  assert.equal(catalog.plugins[0].enabled, true)
  rmSync(root, { recursive: true, force: true })
})

test('安装：非 https 拒绝、apiVersion 不符拒绝且不留残渣', async () => {
  const root = tmpRoot()
  const pkgDir = writePackage(root, { name: 'demo-bad' })
  const manifestPath = join(pkgDir, 'plugin.json')
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  raw.apiVersion = '99'
  writeFileSync(manifestPath, JSON.stringify(raw))
  const bundle = tarballOf(pkgDir, 'demo-bad')
  const { service, dataDir } = makeService(fakeFetch(bundle))

  await assert.rejects(
    service.install({ source: 'http://example.com/x.tar.gz' }),
    error => error instanceof PluginError && error.code === 'SOURCE_INVALID',
  )
  await assert.rejects(
    service.install({ source: 'url:https://example.com/x.tar.gz' }),
    error => error instanceof PluginError && error.code === 'API_VERSION_MISMATCH',
  )
  await assert.rejects(
    service.install({ source: 'npm:demo@1.0.0' }),
    error => error instanceof PluginError && error.code === 'CHANNEL_STAGE2',
  )
  assert.ok(!existsSync(join(dataDir, 'plugins', 'demo-bad')), '失败不留包目录')
  rmSync(root, { recursive: true, force: true })
})

test('安装：第三方与预设包同名被拒（409）', async () => {
  const root = tmpRoot()
  const pkgDir = writePackage(root, { name: 'docs-plugin-base' })
  const bundle = tarballOf(pkgDir, 'docs-plugin-base')
  const { service, makeBuiltin } = makeService(fakeFetch(bundle))
  makeBuiltin({ name: 'docs-plugin-base' })
  await assert.rejects(
    service.install({ source: 'url:https://example.com/x.tar.gz' }),
    error =>
      error instanceof PluginError &&
      error.code === 'BUILTIN_NAME_CONFLICT' &&
      error.status === 409,
  )
  rmSync(root, { recursive: true, force: true })
})

test('同名切换（最新者赢）：安装同 kind 新插件 → 预设组件自动停用并回报 replaced；手动切回同理', async () => {
  const root = tmpRoot()
  const pkgDir = writePackage(root, { name: 'scene-plugin', kinds: ['flow-diagram', 'scene-x'] })
  const bundle = tarballOf(pkgDir, 'scene-plugin')
  const { service, makeBuiltin } = makeService(fakeFetch(bundle))
  makeBuiltin({ name: 'docs-plugin-base', kinds: ['tutorial-shell', 'flow-diagram'] })

  const outcome = await service.install({
    source: 'url:https://example.com/scene-plugin-0.1.0.tar.gz',
  })
  assert.deepEqual(
    outcome.replaced,
    ['docs-plugin-base/flow-diagram'],
    '预设包同 kind 组件自动停用',
  )

  let catalog = service.catalog()
  const builtin = catalog.plugins.find(p => p.name === 'docs-plugin-base')
  const third = catalog.plugins.find(p => p.name === 'scene-plugin')
  assert.deepEqual(builtin.disabledComponents, ['flow-diagram'])
  assert.deepEqual(third.disabledComponents, [])

  // 手动切回：启用预设的 flow-diagram → 第三方同名组件被停用（replaced 反向报告）
  const back = service.setComponentEnabled('docs-plugin-base', 'flow-diagram', true)
  assert.deepEqual(back.replaced, ['scene-plugin/flow-diagram'])
  catalog = service.catalog()
  assert.deepEqual(catalog.plugins.find(p => p.name === 'scene-plugin').disabledComponents, [
    'flow-diagram',
  ])

  const { conflicts, active } = service.activeKinds()
  assert.deepEqual(conflicts, [], '同一 kind 全程至多一个活跃')
  assert.equal(active.filter(a => a.kind === 'flow-diagram').length, 1)
  assert.equal(active.find(a => a.kind === 'flow-diagram').plugin, 'docs-plugin-base')
  rmSync(root, { recursive: true, force: true })
})

test('文件伺服：版本核对 + 防穿越', () => {
  const { service, makeBuiltin } = makeService()
  makeBuiltin({ name: 'docs-plugin-base' })
  const ok = service.resolvePluginFile('docs-plugin-base', '0.1.0', 'dist/index.js')
  assert.ok(ok, '按清单版本可伺服')
  assert.equal(
    service.resolvePluginFile('docs-plugin-base', '9.9.9', 'dist/index.js'),
    null,
    '版本不符 404',
  )
  assert.equal(
    service.resolvePluginFile('docs-plugin-base', '0.1.0', '../../etc/passwd'),
    null,
    '防穿越',
  )
  assert.equal(service.resolvePluginFile('not-exist', '0.1.0', 'dist/index.js'), null)
})

test('readPluginManifest：重复 kind / 声明文件缺失分别拒绝', () => {
  const root = tmpRoot()
  const dir = writePackage(root, { name: 'demo-manifest' })
  assert.equal(readPluginManifest(dir).name, 'demo-manifest')

  const dup = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
  dup.components = [
    { kind: 'a-b', title: 't', description: 'd' },
    { kind: 'a-b', title: 't', description: 'd' },
  ]
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(dup))
  assert.throws(
    () => readPluginManifest(dir),
    error => error.code === 'MANIFEST_INVALID',
  )

  const missing = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
  missing.components = [{ kind: 'a-b', title: 't', description: 'd' }]
  missing.entry = 'dist/nope.js'
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(missing))
  assert.throws(
    () => readPluginManifest(dir),
    error => error.code === 'MANIFEST_INVALID',
  )
  rmSync(root, { recursive: true, force: true })
})

test('协议 v1.1 本地化字段：语言映射合法通过、非法形态拒绝', () => {
  const root = tmpRoot()
  const dir = writePackage(root, { name: 'demo-l10n' })
  const manifestPath = join(dir, 'plugin.json')

  // 合法：displayName / title / description 为语言映射
  const ok = JSON.parse(readFileSync(manifestPath, 'utf8'))
  ok.displayName = { zh: '演示包', en: 'Demo Pack' }
  ok.components = [
    {
      kind: 'demo-chart',
      title: { zh: '演示图', en: 'Demo Chart' },
      description: { zh: '用途', en: 'Purpose' },
    },
  ]
  writeFileSync(manifestPath, JSON.stringify(ok))
  assert.equal(readPluginManifest(dir).displayName.zh, '演示包')

  // 非法：语言键形态错误
  const badLang = JSON.parse(readFileSync(manifestPath, 'utf8'))
  badLang.displayName = { 中文: '演示包' }
  writeFileSync(manifestPath, JSON.stringify(badLang))
  assert.throws(
    () => readPluginManifest(dir),
    error => error.code === 'MANIFEST_INVALID',
    '非法语言键拒绝',
  )

  // 非法：空映射
  const empty = JSON.parse(readFileSync(manifestPath, 'utf8'))
  empty.displayName = {}
  writeFileSync(manifestPath, JSON.stringify(empty))
  assert.throws(
    () => readPluginManifest(dir),
    error => error.code === 'MANIFEST_INVALID',
    '空映射拒绝',
  )

  // 非法：数组（非 string 非映射对象）
  const arr = JSON.parse(readFileSync(manifestPath, 'utf8'))
  arr.components[0].title = ['演示图']
  writeFileSync(manifestPath, JSON.stringify(arr))
  assert.throws(
    () => readPluginManifest(dir),
    error => error.code === 'MANIFEST_INVALID',
    '数组形态拒绝',
  )
  rmSync(root, { recursive: true, force: true })
})

test('协议 v1.1 组件示例：resolveComponentExample 定位 / 未声明返回 null / 声明缺失抛错', () => {
  const root = tmpRoot()
  const { service, makeBuiltin } = makeService()
  const dir = makeBuiltin({ name: 'docs-plugin-base', kinds: ['demo-chart', 'no-example'] })
  mkdirSync(join(dir, 'examples'), { recursive: true })
  writeFileSync(join(dir, 'examples', 'demo-chart.md'), '# demo\n')
  const raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
  raw.components[0].example = 'examples/demo-chart.md'
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(raw))

  const file = service.resolveComponentExample('docs-plugin-base', 'demo-chart')
  assert.ok(file && file.endsWith('demo-chart.md'), '按 example 声明定位示例文件')
  assert.equal(
    service.resolveComponentExample('docs-plugin-base', 'no-example'),
    null,
    '未声明 example 返回 null',
  )

  assert.throws(
    () => service.resolveComponentExample('docs-plugin-base', 'missing-kind'),
    error => error instanceof PluginError && error.code === 'NOT_FOUND',
  )
  assert.throws(
    () => service.resolveComponentExample('not-installed', 'demo-chart'),
    error => error instanceof PluginError && error.code === 'NOT_FOUND',
  )

  // 声明了 example 但文件缺失
  const gone = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
  gone.components[0].example = 'examples/nope.md'
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(gone))
  assert.throws(
    () => service.resolveComponentExample('docs-plugin-base', 'demo-chart'),
    error => error instanceof PluginError && error.code === 'EXAMPLE_MISSING',
  )
  rmSync(root, { recursive: true, force: true })
})
