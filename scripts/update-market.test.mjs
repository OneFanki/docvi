/**
 * 更新检查与插件市场的纯逻辑单测。
 *
 * 这两块都**不碰真实网络**（fetch 由测试注入）：版本比较是纯函数；市场是
 * 「远端配置文件 + 本地缓存」，要守的是——
 *  1. 坏清单不能整份拒绝（远端文件写坏一条不该让市场空白）；
 *  2. 拉取失败必须回退缓存并说明「这是离线副本」，不能静默假装成功；
 *  3. 空清单不能覆盖已有缓存（远端被误清空时用户不该丢掉上一次的列表）；
 *  4. 仓库地址必须 http(s)——它会直接变成界面上的链接。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { compareVersions, trustedHttpsUrl } = await import('../apps/desktop/src/main/version.ts')
const { loadMarket, parseCatalog, readCache, MARKET_URL } =
  await import('../apps/desktop/src/main/plugin-market.ts')

test('版本比较：数字段逐位比较，不与字符串序混淆', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  // 字符串序会认为 "1.10.0" < "1.9.0"，这里必须正确
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1)
})

test('版本比较：允许 v 前缀、预发布低于同号正式版', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.0.0-beta.1', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1)
})

test('下载地址只认 https（http 与非法串一律丢弃）', () => {
  assert.equal(trustedHttpsUrl('https://example.com/a.exe'), 'https://example.com/a.exe')
  assert.equal(trustedHttpsUrl('http://example.com/a.exe'), undefined)
  assert.equal(trustedHttpsUrl('file:///etc/passwd'), undefined)
  assert.equal(trustedHttpsUrl('not a url'), undefined)
  assert.equal(trustedHttpsUrl(null), undefined)
})

/* ---------- 清单解析 ---------- */

test('清单解析：坏条目跳过，不整份失败', () => {
  const catalog = parseCatalog(
    {
      schemaVersion: 1,
      plugins: [
        { name: 'ok-pack', version: '1.0.0', repository: 'https://github.com/a/ok' },
        { version: '1.0.0', repository: 'https://github.com/a/x' }, // 缺 name
        { name: 'no-version', repository: 'https://github.com/a/y' }, // 缺 version
        { name: 'no-repo', version: '1.0.0' }, // 缺 repository：市场条目点不动，跳过
        { name: 'js-scheme', version: '1.0.0', repository: 'javascript:alert(1)' },
      ],
    },
    1000,
    'https://example.com/market.json',
  )
  assert.deepEqual(
    catalog.plugins.map(item => item.name),
    ['ok-pack'],
  )
  assert.equal(catalog.fetchedAt, 1000)
  assert.equal(catalog.sourceUrl, 'https://example.com/market.json')
})

test('清单解析：本地化字段双形态都可读', () => {
  const catalog = parseCatalog(
    {
      plugins: [
        {
          name: 'a',
          version: '1.0.0',
          repository: 'https://github.com/a/a',
          displayName: { zh: '甲', en: 'A' },
          description: '纯字符串描述',
        },
      ],
    },
    1,
    'u',
  )
  assert.deepEqual(catalog.plugins[0].displayName, { zh: '甲', en: 'A' })
  assert.deepEqual(catalog.plugins[0].description, { zh: '纯字符串描述' })
})

test('清单解析：一个仓库可以登记多个插件（各占一条、各有产物）', () => {
  /*
   * 一仓多插件是明确支持的用法（monorepo）：每个插件在清单里各占一条记录，
   * 共享同一个 repository、各自有自己的 artifact 地址。安装落盘按 manifest
   * 的 name 走（不是按仓库走），两个插件互不干扰；每日 star 刷新对同一仓库
   * 只查一次、回写给两条记录（见 scripts/market-refresh.mjs 的 collectTargets）。
   */
  const catalog = parseCatalog(
    {
      plugins: [
        {
          name: 'acme-pack-a',
          version: '1.0.0',
          repository: 'https://github.com/acme/docvi-plugins',
          artifact: {
            manifest: 'https://raw.githubusercontent.com/acme/docvi-plugins/v1/a/plugin.json',
          },
        },
        {
          name: 'acme-pack-b',
          version: '2.0.0',
          repository: 'https://github.com/acme/docvi-plugins',
          artifact: {
            manifest: 'https://raw.githubusercontent.com/acme/docvi-plugins/v1/b/plugin.json',
          },
        },
      ],
    },
    1,
    'u',
  )
  assert.deepEqual(
    catalog.plugins.map(item => item.name),
    ['acme-pack-a', 'acme-pack-b'],
  )
})

test('清单解析：重复 name 只保留第一条（维护失误不该变成两张卡片）', () => {
  /*
   * name 是全市场的唯一键：安装按它落位、「已安装」按它匹配。同 name 出现
   * 两次时界面会出现两张卡片、安装哪张都写同一个目录——保留首次出现的，
   * 后面的丢弃，让 PR 审查去发现这份失误。
   */
  const catalog = parseCatalog(
    {
      plugins: [
        { name: 'dup', version: '1.0.0', repository: 'https://github.com/a/one' },
        { name: 'dup', version: '9.9.9', repository: 'https://github.com/a/two' },
        { name: 'other', version: '1.0.0', repository: 'https://github.com/a/three' },
      ],
    },
    1,
    'u',
  )
  const dup = catalog.plugins.filter(item => item.name === 'dup')
  assert.equal(dup.length, 1)
  assert.equal(dup[0].version, '1.0.0')
  assert.deepEqual(
    catalog.plugins.map(item => item.name),
    ['dup', 'other'],
  )
})

/* ---------- 拉取与缓存 ---------- */

function fakeFetch(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  })
}

test('市场：首次拉取成功 → 写缓存，第二次不刷新直接读缓存', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-market-ok-'))
  try {
    const cacheFile = join(root, 'market.json')
    const options = {
      cacheFile,
      url: 'https://example.com/m.json',
      fetchImpl: fakeFetch({
        plugins: [{ name: 'p', version: '1.0.0', repository: 'https://github.com/a/p' }],
      }),
    }
    const first = await loadMarket(options, true)
    assert.equal(first.plugins.length, 1)
    assert.ok(existsSync(cacheFile), '拉取成功必须落缓存')

    // 第二次用「会抛错」的 fetch：只要走了缓存就不会被调用
    const cached = await loadMarket(
      {
        ...options,
        fetchImpl: async () => {
          throw new Error('不该联网')
        },
      },
      false,
    )
    assert.equal(cached.plugins.length, 1)
    assert.equal(cached.error, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('市场：拉取失败回退缓存，并说明是离线副本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-market-offline-'))
  try {
    const cacheFile = join(root, 'market.json')
    // 先写一份「旧缓存」
    const seed = await loadMarket(
      {
        cacheFile,
        url: 'https://example.com/m.json',
        fetchImpl: fakeFetch({
          plugins: [{ name: 'old', version: '1.0.0', repository: 'https://github.com/a/old' }],
        }),
      },
      true,
    )
    assert.equal(seed.plugins.length, 1)

    // 强制刷新 + 网络失败 → 仍返回缓存，error 里说明
    const offline = await loadMarket(
      {
        cacheFile,
        url: 'https://example.com/m.json',
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND')
        },
      },
      true,
    )
    assert.equal(offline.plugins.length, 1)
    assert.match(offline.error ?? '', /刷新失败/)
    assert.equal(offline.fetchedAt, seed.fetchedAt, '失败时不能改写缓存时间')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('市场：无缓存且拉取失败 → 空目录 + error，不抛异常', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-market-nocache-'))
  try {
    const catalog = await loadMarket(
      {
        cacheFile: join(root, 'market.json'),
        url: 'https://example.com/m.json',
        fetchImpl: fakeFetch({}, 500),
      },
      true,
    )
    assert.deepEqual(catalog.plugins, [])
    assert.equal(catalog.fetchedAt, 0)
    assert.match(catalog.error ?? '', /无法获取插件市场/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('市场：空清单不覆盖缓存（远端被误清空时保住上一次的列表）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-market-empty-'))
  try {
    const cacheFile = join(root, 'market.json')
    await loadMarket(
      {
        cacheFile,
        url: 'u',
        fetchImpl: fakeFetch({
          plugins: [{ name: 'kept', version: '1.0.0', repository: 'https://github.com/a/k' }],
        }),
      },
      true,
    )
    const emptied = await loadMarket(
      { cacheFile, url: 'u', fetchImpl: fakeFetch({ plugins: [] }) },
      true,
    )
    assert.deepEqual(emptied.plugins, [])
    // 缓存文件仍然是旧的那份
    const cached = readCache(cacheFile, 'u')
    assert.deepEqual(
      cached?.plugins.map(item => item.name),
      ['kept'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('市场：缓存文件损坏当作没有缓存', async () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-market-broken-'))
  try {
    const cacheFile = join(root, 'market.json')
    writeFileSync(cacheFile, '{ 这不是 JSON', 'utf8')
    const catalog = await loadMarket(
      {
        cacheFile,
        url: 'u',
        fetchImpl: async () => {
          throw new Error('offline')
        },
      },
      true,
    )
    assert.deepEqual(catalog.plugins, [])
    assert.ok(catalog.error)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('市场默认地址是 GitHub raw（远端配置文件，不是安装包内的文件）', () => {
  assert.match(MARKET_URL, /^https:\/\/raw\.githubusercontent\.com\//)
  assert.match(MARKET_URL, /market\.json$/)
})
