/**
 * 临时分享代理契约（`/s/<id>/…`）：容器 deployer 与桌面 app 共用同一份路由实现，
 * 本文件直接测共享实现（`http-kit.mjs` 的 `createShareProxy` / `createStaticSite`），
 * 不经过任何宿主。
 *
 * 重点覆盖容易回归的语义：
 * - 文件分享的元数据与正文、目录分享的树与文档
 * - 分享前缀下壳入口注入 `<base href="/">`，站点根入口不改写
 * - 失效三因（不存在 / 已停用 / 目标消失）给出可读页面而非 JSON
 * - 目录内路径穿越不逃出分享根
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { after, before, test } from 'node:test'

import {
  createShareProxy,
  createStaticSite,
  resolveInRoot,
  withBaseHref,
} from '../src/http-kit.mjs'
import { createSharesService } from '../src/shares.mjs'

const cleanup = []
let workspace
let server
let base
let shares

/** 与 deployer 一致的失效页判定：文案区分三因，测试只看关键字 */
function gonePage(reason) {
  if (reason === 'disabled') return '<!doctype html><html><body>分享已停用</body></html>'
  if (reason === 'missing') return '<!doctype html><html><body>分享的文件已不存在</body></html>'
  return '<!doctype html><html><body>分享不存在或已被撤销</body></html>'
}

before(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ds-share-proxy-data-'))
  workspace = mkdtempSync(join(tmpdir(), 'ds-share-proxy-ws-'))
  const shellRoot = mkdtempSync(join(tmpdir(), 'ds-share-proxy-shell-'))
  cleanup.push(dataDir, workspace, shellRoot)

  writeFileSync(
    join(shellRoot, 'index.html'),
    '<!doctype html><html><head><title>docvi</title></head><body>docvi</body></html>',
    'utf8',
  )
  mkdirSync(join(shellRoot, 'assets'), { recursive: true })
  writeFileSync(join(shellRoot, 'assets', 'app.js'), 'console.log(1)', 'utf8')

  shares = createSharesService({ dataDir })
  const serveStatic = createStaticSite({ shellRoot })
  const handleShare = createShareProxy({
    shares,
    serveShell: res => serveStatic(res, { urlPath: '/', nested: true }),
    gonePage: reason => gonePage(reason),
  })

  server = createServer((req, res) => {
    const pathname = decodeURI(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (pathname === '/s' || pathname.startsWith('/s/')) {
      handleShare(req, res, pathname).catch(() => {
        res.writeHead(500)
        res.end()
      })
      return
    }
    // 分享前缀之外的普通站点路径：不注入 base
    serveStatic(res, { urlPath: pathname })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
  for (const dir of cleanup) rmSync(dir, { recursive: true, force: true })
})

async function get(path) {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: await res.text(), headers: res.headers }
}

test('文件分享：元数据取文件名，正文直读原文件', async () => {
  const file = join(workspace, 'single.md')
  writeFileSync(file, '# 单篇\n\n正文', 'utf8')
  const share = shares.create({ path: file })

  const meta = JSON.parse((await get(`/s/${share.id}/api/meta`)).body)
  assert.equal(meta.kind, 'file')
  assert.equal(meta.title, 'single')

  const doc = await get(`/s/${share.id}/api/doc`)
  assert.equal(doc.status, 200)
  assert.ok(doc.body.includes('单篇'))
})

test('目录分享：树带配置来源与标题，文档按相对路径读取', async () => {
  const dir = join(workspace, 'guide')
  mkdirSync(join(dir, 'chapters'), { recursive: true })
  writeFileSync(join(dir, 'index.md'), '---\ntitle: 指南首页\n---\n# 指南', 'utf8')
  writeFileSync(join(dir, 'chapters', 'one.md'), '# 第一章', 'utf8')
  const share = shares.create({ path: dir })

  const tree = JSON.parse((await get(`/s/${share.id}/api/tree`)).body)
  assert.equal(tree.configSource, 'autoscan')
  assert.equal(tree.title, 'guide')
  assert.ok(JSON.stringify(tree).includes('指南首页'), '标题取 frontmatter')

  const page = await get(`/s/${share.id}/docs/chapters/one.md`)
  assert.equal(page.status, 200)
  assert.ok(page.body.includes('第一章'))
})

/**
 * 分享页的壳入口必须带 `<base href="/">`。
 *
 * 壳资产按站根写路径（`/assets/…`），分享页挂在 `/s/<id>/` 下：
 * 若被解析成 `/s/<id>/assets/…`，服务端找不到就回落壳 HTML，
 * 模块脚本拿到 text/html 被浏览器拒绝，整页白屏。<base> 把基准钉回站点根。
 */
test('壳入口：分享前缀下注入 base href，站点根入口保持原样', async () => {
  const file = join(workspace, 'base-check.md')
  writeFileSync(file, '# 基线', 'utf8')
  const entry = shares.create({ path: file })
  const page = await get(`/s/${entry.id}/`)
  assert.equal(page.status, 200)
  assert.match(page.body, /<base href="\/">/)

  const dir = join(workspace, 'base-dir')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.md'), '# 基线目录', 'utf8')
  const dirEntry = shares.create({ path: dir })
  const deep = await get(`/s/${dirEntry.id}/some/deep/link`)
  assert.equal(deep.status, 200)
  assert.match(deep.body, /<base href="\/">/, '深链刷新同样要带 base')

  const site = await get('/some/deep/route')
  assert.equal(site.status, 200)
  assert.ok(!site.body.includes('<base href="/">'), '站点根入口不改写')
})

test('withBaseHref：已有 base 不重复注入，无 head 的极简文档插在 doctype 之后', () => {
  const withHead = '<!doctype html><html><head><title>t</title></head><body></body></html>'
  const once = withBaseHref(withHead)
  assert.equal((once.match(/<base\s/gi) ?? []).length, 1)
  assert.ok(once.includes('<head><base href="/">'))

  const already = '<html><head><base href="/x/"></head></html>'
  assert.equal(withBaseHref(already), already, '已有 base 时保持作者意图')

  const minimal = '<!doctype html><body>hi</body>'
  assert.ok(withBaseHref(minimal).startsWith('<!doctype html><base href="/">'))
})

test('失效三因：不存在 / 已停用 / 目标消失都给可读页面', async () => {
  const missing = await get('/s/aaaaaaaaaaaaaaaa/')
  assert.equal(missing.status, 404)
  assert.ok(missing.body.includes('分享不存在'))

  const file = join(workspace, 'temp.md')
  writeFileSync(file, '# x', 'utf8')
  const share = shares.create({ path: file })
  shares.toggle(share.id, false)
  const disabled = await get(`/s/${share.id}/`)
  assert.equal(disabled.status, 404)
  assert.ok(disabled.body.includes('已停用'))

  const gone = join(workspace, 'gone.md')
  writeFileSync(gone, '# y', 'utf8')
  const goneShare = shares.create({ path: gone })
  rmSync(gone)
  const vanished = await get(`/s/${goneShare.id}/`)
  assert.equal(vanished.status, 404)
  assert.ok(vanished.body.includes('已不存在'))
})

test('目录分享：路径穿越不逃出分享根，也不泄漏根外内容', async () => {
  const dir = join(workspace, 'safe')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'a.md'), '# a', 'utf8')
  writeFileSync(join(workspace, 'secret.md'), '# 机密', 'utf8')
  const share = shares.create({ path: dir })

  /*
   * 注意：`..` 在 URL 解析阶段就被归一化，服务端根本收不到带 `..` 的路径。
   * 因此这里断言的是「任何形态都不泄漏根外内容」，而不是某个具体状态码；
   * 真正的越界拒绝由 resolveInRoot 保证（下面直接测它）。
   */
  for (const path of [
    `/s/${share.id}/../secret.md`,
    `/s/${share.id}/docs/../secret.md`,
    `/s/${share.id}/docs/%2e%2e/secret.md`,
  ]) {
    const res = await get(path)
    assert.ok(!res.body.includes('机密'), `${path} 不得泄漏分享根外内容`)
  }

  /*
   * resolveInRoot 的语义是「永不跳出 root」：越界路径被夹回根内（`/../x` → `<root>/x`）
   * 或判空，两种都安全。断言夹取结果仍在本根内，比断言具体返回值更贴契约。
   */
  const clamped = resolveInRoot(dir, '/../secret.md')
  assert.ok(
    clamped === null || clamped.startsWith(dir + sep),
    `越界路径必须夹回根内或判空，实际：${clamped}`,
  )
  assert.equal(resolveInRoot(dir, '/a.md'), join(dir, 'a.md'))
})

test('非 GET/HEAD 拒绝且带 Allow', async () => {
  const file = join(workspace, 'method.md')
  writeFileSync(file, '# m', 'utf8')
  const share = shares.create({ path: file })
  const res = await fetch(`${base}/s/${share.id}/`, { method: 'POST' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('allow'), 'GET, HEAD')
})
