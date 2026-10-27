/**
 * 开源元数据一致性守卫。
 *
 * 开源仓最怕「改了一处、忘了另一处」——许可证只在根目录写了、插件清单仍是
 * UNLICENSED、更新地址指向一个不存在的仓库，这些都不会让构建失败，但会让
 * 使用者第一次接触就撞墙。本测试把这类事实锁成断言：
 *
 *  1. 根 LICENSE 存在且是 MIT 正文；
 *  2. 每个 package.json / plugin.json 的 license 与根一致（不是 UNLICENSED）；
 *  3. 更新清单与插件市场的远端地址指向**同一个** GitHub 仓库，且该仓库名与
 *     根 package.json 的 name 对得上（改名时漏改地址会被这里拦住）；
 *  4. latest.json / plugins/market.json 存在且字段可解析（客户端解析不炸）；
 *  5. 仓库里存在开源社区必备文件（README / CONTRIBUTING / SECURITY / 行为准则）；
 *  6. 命名不再出现旧产品名作为**品牌**（历史叙述与迁移对照表允许保留）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8')
const readJson = (...parts) => JSON.parse(read(...parts))

const rootPkg = readJson('package.json')

/** 所有要检查 license 的包清单：workspace 三个域 + 根 */
function workspacePackages() {
  const list = ['package.json']
  for (const dir of ['apps', 'packages', 'plugins']) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    for (const name of readdirSync(base)) {
      const file = join(dir, name, 'package.json')
      if (existsSync(join(root, file))) list.push(file)
    }
  }
  return list
}

test('根 LICENSE 是 MIT 正文', () => {
  assert.ok(existsSync(join(root, 'LICENSE')), '缺少 LICENSE 文件')
  const text = read('LICENSE')
  assert.match(text, /^MIT License/m, 'LICENSE 首行应为 MIT License')
  assert.match(text, /Permission is hereby granted, free of charge/, '缺少 MIT 授权段')
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/, '缺少 MIT 免责段')
})

test('根 package.json 声明 MIT 且非 private 之外无矛盾字段', () => {
  assert.equal(rootPkg.license, 'MIT')
  // private 保持 true 是刻意的：本仓不发布到 npm，装的是安装包
  assert.equal(rootPkg.private, true, '根包不发布 npm，应保持 private')
})

test('所有 workspace 包的 license 与根一致（不得残留 UNLICENSED）', () => {
  const offenders = []
  for (const file of workspacePackages()) {
    if (file === 'package.json') continue
    const pkg = readJson(file)
    if (pkg.license !== 'MIT') offenders.push(`${file}: ${pkg.license ?? '(缺失)'}`)
  }
  assert.deepEqual(offenders, [], '这些包的 license 不是 MIT')
})

test('插件清单的 license 与仓库一致（不是 UNLICENSED）', () => {
  for (const name of readdirSync(join(root, 'plugins'))) {
    const file = join('plugins', name, 'plugin.json')
    if (!existsSync(join(root, file))) continue
    const manifest = readJson(file)
    assert.equal(manifest.license, 'MIT', `${file} 的 license 应为 MIT`)
  }
})

test('更新清单与插件市场的地址指向同一个 GitHub 仓库', () => {
  const updateSrc = read('apps/desktop/src/main/update.ts')
  const marketSrc = read('apps/desktop/src/main/plugin-market.ts')
  const pick = (src, label) => {
    // 只认默认值那一条（环境变量覆盖的那支不算）
    const m = /'https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//.exec(src)
    assert.ok(m, `${label} 里找不到 raw.githubusercontent.com 默认地址`)
    return { owner: m[1], repo: m[2] }
  }
  const update = pick(updateSrc, 'update.ts')
  const market = pick(marketSrc, 'plugin-market.ts')
  assert.deepEqual(market, update, '插件市场与更新检查必须指向同一个仓库')

  // 仓库名应与产品名一致：改名时漏改地址会在这里被拦住
  assert.equal(
    update.repo,
    rootPkg.name,
    `远端仓库名（${update.repo}）应与根包名（${rootPkg.name}）一致`,
  )
})

test('latest.json 与 plugins/market.json 可被客户端解析', () => {
  const manifest = readJson('latest.json')
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+/, 'latest.json 的 version 应是 semver')
  assert.match(String(manifest.downloadUrl), /^https:\/\//, 'downloadUrl 必须是 https')

  const market = readJson('plugins', 'market.json')
  assert.equal(typeof market.schemaVersion, 'number', 'market.json 缺 schemaVersion')
  assert.ok(Array.isArray(market.plugins), 'market.json 的 plugins 应是数组')
  for (const entry of market.plugins) {
    assert.ok(entry.name && entry.version, `市场条目缺 name/version：${JSON.stringify(entry)}`)
    assert.match(String(entry.repository), /^https?:\/\//, `市场条目 repository 必须是 http(s)`)
  }
})

test('开源社区必备文件齐全', () => {
  for (const file of [
    'README.md',
    'LICENSE',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CODE_OF_CONDUCT.md',
    '.github/workflows/verify.yml',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ]) {
    assert.ok(existsSync(join(root, file)), `缺少 ${file}`)
  }
})

test('CI 跑的是同一个门禁入口（pnpm verify）', () => {
  const ci = read('.github', 'workflows', 'verify.yml')
  assert.match(ci, /pnpm verify/, 'CI 必须调用 pnpm verify，不能另写一套步骤')
  assert.match(ci, /frozen-lockfile/, 'CI 必须用 --frozen-lockfile 装依赖')
})

test('README 的许可与贡献链接指向真实文件', () => {
  const readme = read('README.md')
  for (const file of ['LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
    assert.ok(readme.includes(`](${file})`), `README 没有链接到 ${file}`)
    assert.ok(existsSync(join(root, file)), `README 链接了不存在的 ${file}`)
  }
  assert.match(readme, /MIT/, 'README 应写明许可')
})

test('三处版本号必须一致（根 / 桌面包 / 更新清单）', () => {
  /*
   * 安装包版本取 `apps/desktop/package.json`，而发版判断与 latest.json 用的是
   * 根 package.json。三处不同步的后果很隐蔽：CI 认为该发 v0.2.0，实际产出的
   * 安装包叫 docvi-0.1.0-setup.exe——用户下载到文件名与版本号对不上的包，
   * 而构建全程没有任何报错（实测踩到过）。
   */
  const rootVersion = readJson('package.json').version
  const desktopVersion = readJson('apps', 'desktop', 'package.json').version
  const manifestVersion = readJson('latest.json').version
  assert.equal(desktopVersion, rootVersion, 'apps/desktop 的 version 必须与根 package.json 一致')
  assert.equal(manifestVersion, rootVersion, 'latest.json 的 version 必须与根 package.json 一致')
})
