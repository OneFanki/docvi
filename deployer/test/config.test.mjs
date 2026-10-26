import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  branchInWhitelist,
  cronMatches,
  effAutoBuild,
  effAutoFetch,
  emptyConfig,
  normalizeConfig,
  validateRepoInput,
} from '../src/config.mjs'

test('空配置返回全局默认值', () => {
  const cfg = emptyConfig()
  // 缺省 poll：单机/局域网部署开箱即自动同步（webhook 需用户自行接入推送）
  assert.equal(cfg.global.autoFetch, 'poll')
  assert.equal(cfg.global.autoBuild, true)
  assert.deepEqual(cfg.repos, [])
})

test('normalize 补齐仓库缺省：分支缺省 main、覆盖空转 null', () => {
  const cfg = normalizeConfig({ repos: [{ slug: 'a', name: 'A', url: 'https://x.git' }] })
  assert.deepEqual(cfg.repos[0].branches, ['main'])
  assert.equal(cfg.repos[0].contentOverride, null)
  assert.equal(cfg.repos[0].webhookSecret, '')
})

test('仓库缺字段被安全归一（null/畸形输入不炸）', () => {
  const cfg = normalizeConfig({ repos: [null, { slug: 42 }] })
  assert.equal(cfg.repos[0].slug, '')
  assert.equal(cfg.repos[1].slug, '42')
})

test('validateRepoInput：slug 与 url 校验', () => {
  const ok = validateRepoInput({
    slug: 'team-docs',
    name: '团队文档',
    url: 'https://git.x.com/t/d.git',
  })
  assert.deepEqual(ok, [])
  assert.match(
    validateRepoInput({ slug: 'Bad_Slug', name: 'n', url: 'https://x.git' }).join(),
    /slug/,
  )
  assert.match(validateRepoInput({ slug: 'ok', name: 'n', url: 'ftp://x' }).join(), /url/)
  assert.deepEqual(
    validateRepoInput({ slug: 'ok', name: 'n', url: 'file:///tmp/repo' }),
    [],
    'file:// 本地演练放行',
  )
})

test('validateRepoInput：粘贴配置的文件系统绝对路径被拒，站点路径放行', () => {
  const withDrive = validateRepoInput({
    slug: 'ok',
    name: 'n',
    url: 'https://x.git',
    contentOverride: 'title: x\noutDir: D:\\tmp\\out',
  })
  assert.match(withDrive.join(), /绝对路径/)

  const withPosixDir = validateRepoInput({
    slug: 'ok',
    name: 'n',
    url: 'https://x.git',
    contentOverride: 'title: x\npath: /data/secret',
  })
  assert.match(withPosixDir.join(), /绝对路径/)

  const sitePathOk = validateRepoInput({
    slug: 'ok',
    name: 'n',
    url: 'https://x.git',
    contentOverride: 'title: x\nnav:\n  - text: 首页\n    link: /',
  })
  assert.deepEqual(sitePathOk, [])
})

test('白名单匹配：精确 + 通配', () => {
  const patterns = ['main', '1.*', 'release/*']
  assert.equal(branchInWhitelist(patterns, 'main'), true)
  assert.equal(branchInWhitelist(patterns, '1.3.0'), true)
  assert.equal(branchInWhitelist(patterns, 'release/v2'), true)
  assert.equal(branchInWhitelist(patterns, '2.0.0'), false)
  assert.equal(branchInWhitelist(patterns, 'mainx'), false)
})

test('两层继承：inherit 取全局，显式覆盖生效', () => {
  const global = { autoFetch: 'poll', autoBuild: false }
  assert.equal(effAutoFetch({ autoFetch: 'inherit' }, global), 'poll')
  assert.equal(effAutoFetch({ autoFetch: 'off' }, global), 'off')
  assert.equal(effAutoBuild({ autoBuild: 'inherit' }, global), false)
  assert.equal(effAutoBuild({ autoBuild: true }, global), true)
})

test('cron 匹配：通配、数字、步进', () => {
  const at = str => new Date(str)
  assert.equal(cronMatches('0 4 * * *', at('2026-10-09T04:00:00')), true)
  assert.equal(cronMatches('0 4 * * *', at('2026-10-09T05:00:00')), false)
  assert.equal(cronMatches('*/15 * * * *', at('2026-10-09T10:45:00')), true)
  assert.equal(cronMatches('*/15 * * * *', at('2026-10-09T10:50:00')), false)
  assert.equal(cronMatches('bad cron', at('2026-10-09T10:45:00')), false)
})
