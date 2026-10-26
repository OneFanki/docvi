/**
 * 容器仓库清单 → 渲染层工作区（`portalToWorkspaces` 的契约）。
 *
 * 部署器 `/api/portal` 是读者面唯一的数据源，转换错一处界面就少一块信息：
 *  - 克隆中的仓库必须列出来（否则读者以为仓库丢了）；
 *  - 分支的 artifact / index 是自由字符串，进渲染层前必须收窄成枚举，
 *    否则分支选择器会渲染出未知状态；
 *  - 同步时间与错误要原样带到卡片上（「看不到新内容」的来源就靠它解释）。
 *
 * 纯函数导出在这里，是因为 web-host 同时依赖 localStorage 与 fetch，
 * 整模块在 node 里跑不起来；只测转换这一段。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { normalizePortal, toArtifact, toIndex } =
  await import('../apps/desktop/src/renderer/src/lib/portal-workspaces.ts')

test('克隆中的仓库也列出（ready=false 时仍占位）', () => {
  const list = normalizePortal({
    repos: [
      {
        slug: 'new-repo',
        name: '新仓库',
        ready: false,
        branches: [],
        defaultBranch: null,
        cloning: true,
        syncAt: null,
        syncError: null,
      },
    ],
    mounted: null,
  })
  assert.equal(list.length, 1)
  assert.equal(list[0]?.id, 'new-repo')
  assert.equal(list[0]?.portal?.cloning, true)
  assert.deepEqual(list[0]?.portal?.branches, [])
})

test('分支状态收窄：未知值落到安全缺省', () => {
  assert.equal(toArtifact('ready'), 'ready')
  assert.equal(toArtifact('weird'), 'none')
  assert.equal(toIndex('indexed'), 'indexed')
  assert.equal(toIndex('weird'), 'pending')
})

test('分支与同步信息原样带过去', () => {
  const list = normalizePortal({
    repos: [
      {
        slug: 'docs',
        name: '团队文档',
        ready: true,
        branches: [
          { branch: 'main', isDefault: true, artifact: 'ready', index: 'indexed' },
          { branch: 'dev', isDefault: false, artifact: 'building', index: 'pending' },
        ],
        defaultBranch: 'main',
        cloning: false,
        syncAt: '2026-10-24T02:51:00.095Z',
        syncError: null,
      },
    ],
    mounted: { slug: 'docs', branch: 'main' },
  })
  const portal = list[0]?.portal
  assert.equal(portal?.defaultBranch, 'main')
  assert.equal(portal?.branches.length, 2)
  assert.equal(portal?.branches[0]?.artifact, 'ready')
  assert.equal(portal?.branches[1]?.artifact, 'building')
  assert.equal(portal?.syncAt, '2026-10-24T02:51:00.095Z')
  assert.equal(portal?.syncError, null)
})

test('同步失败信息不被吞掉（卡片要能显示原因）', () => {
  const list = normalizePortal({
    repos: [
      {
        slug: 'docs',
        name: 'docs',
        ready: true,
        branches: [{ branch: 'main', isDefault: true, artifact: 'ready', index: 'indexed' }],
        defaultBranch: 'main',
        syncAt: '2026-10-20T00:00:00.000Z',
        syncError: '认证失败',
      },
    ],
    mounted: null,
  })
  assert.equal(list[0]?.portal?.syncError, '认证失败')
})
