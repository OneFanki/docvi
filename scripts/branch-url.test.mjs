/**
 * 分支切换的地址计算（容器读者面）。
 *
 * 「切分支该落到哪个地址」是最容易出错、又最不需要 DOM 的一段。真实踩过的坑：
 * 在文档库首页（`/`）直接拿 `location.pathname` 当基准，拼出 `/?branch=x`——
 * 仓库段丢失，读者被丢回空首页。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { branchUrl } = await import('../apps/desktop/src/renderer/src/lib/branch-url.ts')

test('在仓库内切换：保留当前文档路径', () => {
  assert.equal(
    branchUrl('/team-wiki/guide/intro', '?branch=main', 'team-wiki', 'dev', 'main'),
    '/team-wiki/guide/intro?branch=dev',
  )
})

test('在文档库首页切换：落到该仓落地页，不能拼成 /?branch=', () => {
  assert.equal(
    branchUrl('/', '', 'team-wiki', 'dev-v1.2.0', 'main'),
    '/team-wiki/?branch=dev-v1.2.0',
  )
})

test('在别的仓库里切换：落到目标仓落地页（不串仓）', () => {
  assert.equal(branchUrl('/showcase/a', '', 'team-wiki', 'dev', 'main'), '/team-wiki/?branch=dev')
})

test('切回默认分支：清掉参数，URL 保持干净', () => {
  assert.equal(branchUrl('/team-wiki/', '?branch=dev', 'team-wiki', 'main', 'main'), '/team-wiki/')
})

test('仓库名需要 URL 编码', () => {
  assert.equal(
    branchUrl('/', '', '团队 文档', 'dev', null),
    '/%E5%9B%A2%E9%98%9F%20%E6%96%87%E6%A1%A3/?branch=dev',
  )
})

test('前缀误判防护：/repo2 不该被当成 /repo 的子路径', () => {
  assert.equal(branchUrl('/repo2/a', '', 'repo', 'dev', 'main'), '/repo/?branch=dev')
})
