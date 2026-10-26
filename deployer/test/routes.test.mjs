/**
 * 部署器路由放行契约：`/_` 前缀是平台自渲染页命名空间（运维页等），其余一律 404——
 * 但壳的前端保留路由必须放行到 `serveShell`，否则直接访问/刷新就是 404 白屏。
 *
 * 已有保留路由：组件预览 `/_/preview/<name>/<kind>`、本地预览 `/__local/…`
 * （2026-10-19 实测：只加放行了 preview，`/__local/` 深链刷新 404）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { createHttpd } from '../src/httpd.mjs'

let server
let base
let root

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deployer-routes-'))
  const dataDir = join(root, 'data')
  const platformDir = join(root, 'platform')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(platformDir, 'apps', 'desktop', 'dist-web'), { recursive: true })
  writeFileSync(
    join(platformDir, 'apps', 'desktop', 'dist-web', 'index.html'),
    '<!doctype html><html><head><title>docvi</title></head><body>docvi</body></html>',
    'utf8',
  )

  const httpd = createHttpd({
    dataDir,
    platformDir,
    version: 'test',
    token: '',
    gitOps: {},
    builder: {},
    plugins: {
      catalog: () => ({ plugins: [] }),
      activeKinds: () => ({ active: [], conflicts: [] }),
      findPluginRoot: () => null,
    },
    shares: {},
    loadConfigData: () => ({ repos: [], global: {} }),
    saveConfigData: () => {},
    audit: () => {},
  })
  server = createServer(httpd)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

test('壳前端保留路由放行到壳入口（组件预览 / 本地预览）', async () => {
  const preview = await fetch(`${base}/_/preview/demo-pack/flow-diagram`)
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get('content-type') ?? '', /text\/html/)

  const local = await fetch(`${base}/__local/ai-draft`)
  assert.equal(local.status, 200, '/__local/ 深链刷新必须是壳入口，不是 404')
  assert.match(await local.text(), /docvi/)
})

test('其余 /_ 路径仍是 404（运维页之外的平台段不外泄）', async () => {
  const ops = await fetch(`${base}/_/bogus`)
  assert.equal(ops.status, 404)

  const admin = await fetch(`${base}/_/admin/extra`)
  assert.equal(admin.status, 404)
})
