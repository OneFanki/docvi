import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBuilder, createMountPolicy, isReleaseReady } from '../src/builder.mjs'
import { readMounted, releaseDir, treeJsonPath, searchIndexJsonPath } from '../src/store.mjs'

function tmpDataDir() {
  return mkdtempSync(join(tmpdir(), 'deployer-test-'))
}

const fakeConfig = () => ({
  global: {},
  repos: [
    { slug: 'r1', name: 'R1', url: 'https://x.git', branches: ['main'], contentOverride: null },
  ],
})

const fakeGitOps = () => ({
  resetWorktree: async () => {},
  headSha: async () => 'abc1234',
  restoreContentConfig: async () => {},
})

/** 分支谱系维护用的假 git 层：远端分支集合可编程，建树/清理有记录 */
function fakeSyncGitOps(remote) {
  const calls = { ensure: [], prune: [], fetch: 0, reset: [] }
  return {
    calls,
    setRemote: branches => {
      remote.length = 0
      remote.push(...branches)
    },
    hasBare: () => true,
    fetchBare: async () => {
      calls.fetch += 1
    },
    remoteBranches: async () => [...remote],
    ensureWorktree: async (_bare, wtDir, branch) => {
      calls.ensure.push(branch)
      mkdirSync(join(wtDir, '.git'), { recursive: true })
    },
    pruneForeignWorktrees: async (_bare, _slug, wanted) => {
      calls.prune.push([...wanted])
    },
    resetWorktree: async (_wt, branch) => {
      calls.reset.push(branch)
    },
    headSha: async () => 'old-sha',
    branchSha: async (_bare, branch) => (branch === '1.2.0' ? 'new-sha' : 'old-sha'),
    behindCount: async () => 3,
    restoreContentConfig: async () => {},
  }
}

/** 假索引生成器：可控耗时，验证串行与去重 */
function fakeBuildIndex(ms, calls, version = 'v1') {
  return async ({ worktree }) => {
    calls.push(worktree)
    await new Promise(r => setTimeout(r, ms))
    return {
      version,
      tree: { version, title: 'T', roots: [] },
      searchIndex: { version, index: {}, docs: [] },
    }
  }
}

test('索引刷新：写出 tree.json + search-index.json，版本号落盘', async () => {
  const dataDir = tmpDataDir()
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps: fakeGitOps(),
    loadConfigData: fakeConfig,
    buildIndex: fakeBuildIndex(5, [], 'v-abc'),
  })
  const result = await builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'manual' })
  assert.equal(result.ok, true)
  assert.ok(isReleaseReady(dataDir, 'r1', 'main'), 'tree.json 就绪')
  const dir = releaseDir(dataDir, 'r1', 'main')
  assert.equal(JSON.parse(readFileSync(treeJsonPath(dir), 'utf8')).version, 'v-abc')
  assert.equal(JSON.parse(readFileSync(searchIndexJsonPath(dir), 'utf8')).version, 'v-abc')
  const record = JSON.parse(
    readFileSync(
      join(
        dataDir,
        'builds',
        readdirSync(join(dataDir, 'builds')).find(f => f.endsWith('.json')),
      ),
      'utf8',
    ),
  )
  assert.equal(record.status, 'success')
  assert.equal(record.version, 'v-abc')
  rmSync(dataDir, { recursive: true, force: true })
})

test('索引失败：记录 failed、不写发布文件、不抛到队列外', async () => {
  const dataDir = tmpDataDir()
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps: fakeGitOps(),
    loadConfigData: fakeConfig,
    buildIndex: async () => {
      throw new Error('mock 生成失败')
    },
  })
  const result = await builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'manual' })
  assert.equal(result.ok, false)
  assert.match(result.error, /mock 生成失败/)
  assert.equal(isReleaseReady(dataDir, 'r1', 'main'), false, '失败不留发布文件')
  const records = readdirSync(join(dataDir, 'builds')).filter(f => f.endsWith('.json'))
  const record = JSON.parse(readFileSync(join(dataDir, 'builds', records[0]), 'utf8'))
  assert.equal(record.status, 'failed')
  rmSync(dataDir, { recursive: true, force: true })
})

test('失败不覆盖已有版本：旧发布文件保持原版本', async () => {
  const dataDir = tmpDataDir()
  let shouldFail = false
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps: fakeGitOps(),
    loadConfigData: fakeConfig,
    buildIndex: async () => {
      if (shouldFail) throw new Error('后续失败')
      return { version: 'v1', tree: { version: 'v1' }, searchIndex: { version: 'v1' } }
    },
  })
  await builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'manual' })
  shouldFail = true
  const result = await builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'manual' })
  assert.equal(result.ok, false)
  const dir = releaseDir(dataDir, 'r1', 'main')
  assert.equal(
    JSON.parse(readFileSync(treeJsonPath(dir), 'utf8')).version,
    'v1',
    '在线版本未被失败任务破坏',
  )
  rmSync(dataDir, { recursive: true, force: true })
})

test('旧编译布局：指向 snapshots 的 symlink 发布位被替换为普通目录', async () => {
  const dataDir = tmpDataDir()
  const legacySnap = join(releaseDir(dataDir, 'r1', 'snapshots'), 'old')
  mkdirSync(legacySnap, { recursive: true })
  writeFileSync(join(legacySnap, 'index.html'), 'old')
  const linkPath = releaseDir(dataDir, 'r1', 'main')
  mkdirSync(join(dataDir, 'releases', 'r1'), { recursive: true })
  try {
    symlinkSync(join('snapshots', 'old'), linkPath, 'junction')
  } catch {
    symlinkSync(join('snapshots', 'old'), linkPath, 'dir')
  }
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps: fakeGitOps(),
    loadConfigData: fakeConfig,
    buildIndex: fakeBuildIndex(5, [], 'v2'),
  })
  const result = await builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'manual' })
  assert.equal(result.ok, true)
  assert.ok(isReleaseReady(dataDir, 'r1', 'main'))
  assert.equal(JSON.parse(readFileSync(treeJsonPath(linkPath), 'utf8')).version, 'v2')
  rmSync(dataDir, { recursive: true, force: true })
})

test('挂载策略：首个发布自动上架，pending 命中后正式挂载', async () => {
  const dataDir = tmpDataDir()
  const onSwap = createMountPolicy({ dataDir })

  assert.equal(await onSwap({ slug: 'r1', branch: 'main' }), true)
  assert.deepEqual(readMounted(dataDir).current, { slug: 'r1', branch: 'main' })

  // 非目标分支刷新成功不改变挂载
  assert.equal(await onSwap({ slug: 'r1', branch: 'dev' }), false)
  assert.deepEqual(readMounted(dataDir).current, { slug: 'r1', branch: 'main' })

  // pending 命中即挂载
  const { writeMounted } = await import('../src/store.mjs')
  writeMounted(dataDir, {
    current: { slug: 'r1', branch: 'main' },
    pending: { slug: 'r1', branch: 'dev' },
  })
  assert.equal(await onSwap({ slug: 'r1', branch: 'dev' }), true)
  assert.deepEqual(readMounted(dataDir).current, { slug: 'r1', branch: 'dev' })
  assert.equal(readMounted(dataDir).pending, null)

  rmSync(dataDir, { recursive: true, force: true })
})

test('队列：串行执行，同分支排队任务去重只留最新目标', async () => {
  const dataDir = tmpDataDir()
  const calls = []
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps: fakeGitOps(),
    loadConfigData: fakeConfig,
    buildIndex: fakeBuildIndex(40, calls),
  })

  const p1 = builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'webhook' })
  const p2 = builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'webhook' })
  const p3 = builder.enqueue({ slug: 'r1', branch: 'main', trigger: 'manual' })
  await Promise.all([p1, p2, p3])

  // 第一个立即运行；p2/p3 是排队任务合并成一个（只留 p3 的 manual 目标）
  assert.equal(calls.length, 2)
  const records = readdirSync(join(dataDir, 'builds')).filter(f => f.endsWith('.json'))
  assert.equal(records.length, 2)
  const triggers = records.map(
    f => JSON.parse(readFileSync(join(dataDir, 'builds', f), 'utf8')).trigger,
  )
  assert.ok(triggers.includes('manual'), '合并后的任务应保留最新 trigger')

  rmSync(dataDir, { recursive: true, force: true })
})

/* ---------- 分支谱系维护（统一模型：命中规则自动建树 / 远端删除自动清理） ---------- */

const syncConfig = () => ({
  global: { autoBuild: true },
  repos: [
    {
      slug: 'r1',
      name: 'R1',
      url: 'https://x.git',
      branches: ['main', '1.*'],
      autoFetch: 'inherit',
      autoBuild: 'inherit',
      contentOverride: null,
    },
  ],
})

test('syncRepo：远端新分支命中通配规则 → 自动建树并入队首轮索引', async () => {
  const dataDir = tmpDataDir()
  const remote = ['main']
  const gitOps = fakeSyncGitOps(remote)
  const calls = []
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps,
    loadConfigData: syncConfig,
    buildIndex: fakeBuildIndex(5, calls, 'v1'),
  })
  // main 已在本地存在（工作树目录预置），1.3.0 是远端新增
  mkdirSync(join(dataDir, 'worktrees', 'r1', 'main', '.git'), { recursive: true })
  gitOps.setRemote(['main', '1.3.0'])

  const result = await builder.syncRepo(syncConfig().repos[0], { fetch: true, buildNew: true })
  assert.equal(result.ok, true)
  assert.deepEqual(result.effective.sort(), ['1.3.0', 'main'])
  assert.deepEqual(result.created, ['1.3.0'], '只有新增分支计入 created')
  assert.ok(existsSync(join(dataDir, 'worktrees', 'r1', '1.3.0', '.git')), '新分支工作树已建')

  // 等首轮索引任务跑完（enqueue → 队列串行）
  await new Promise(r => setTimeout(r, 80))
  const records = readdirSync(join(dataDir, 'builds'))
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dataDir, 'builds', f), 'utf8')))
  assert.ok(
    records.some(r => r.branch === '1.3.0' && r.trigger === 'auto-branch'),
    '新分支已入索引队列',
  )
  assert.ok(isReleaseReady(dataDir, 'r1', '1.3.0'), '新分支首轮索引已就绪')

  // 主库同步时间已盖章
  const sync = JSON.parse(readFileSync(join(dataDir, 'sync', 'r1.json'), 'utf8'))
  assert.ok(sync.at, 'fetch 成功时间已记录')
  assert.ok(sync.branches['1.3.0']?.buildAt, '分支索引时间已记录')
  rmSync(dataDir, { recursive: true, force: true })
})

test('syncRepo：远端删除分支 → 工作树与发布目录清理、挂载指针收口', async () => {
  const dataDir = tmpDataDir()
  const remote = ['main', '1.1.0']
  const gitOps = fakeSyncGitOps(remote)
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps,
    loadConfigData: syncConfig,
    buildIndex: fakeBuildIndex(5, [], 'v1'),
  })
  // 两个白名单分支都在本地就绪
  mkdirSync(join(dataDir, 'worktrees', 'r1', 'main', '.git'), { recursive: true })
  mkdirSync(join(dataDir, 'worktrees', 'r1', '1.1.0', '.git'), { recursive: true })
  mkdirSync(releaseDir(dataDir, 'r1', '1.1.0'), { recursive: true })
  writeFileSync(treeJsonPath(releaseDir(dataDir, 'r1', '1.1.0')), '{}')
  // 挂载指针当前指向将被删除的分支
  const { writeMounted } = await import('../src/store.mjs')
  writeMounted(dataDir, { current: { slug: 'r1', branch: '1.1.0' }, pending: null })

  // 远端把 1.1.0 删掉了
  gitOps.setRemote(['main'])
  const result = await builder.syncRepo(syncConfig().repos[0], { fetch: true })
  assert.deepEqual(result.effective, ['main'])
  assert.ok(!existsSync(join(dataDir, 'worktrees', 'r1', '1.1.0')), '分支工作树已清理')
  assert.ok(!existsSync(releaseDir(dataDir, 'r1', '1.1.0')), '分支发布目录已清理')
  assert.ok(result.removed.includes('1.1.0'), '清理清单记录在案')
  assert.equal(readMounted(dataDir).current, null, '挂载指针指向已删分支 → 收口为 null')

  rmSync(dataDir, { recursive: true, force: true })
})

test('syncRepo：fetch 失败 → 不清理任何分支（网络抖动不误删在线内容）', async () => {
  const dataDir = tmpDataDir()
  const remote = ['main']
  const gitOps = fakeSyncGitOps(remote)
  gitOps.fetchBare = async () => {
    throw new Error('network down')
  }
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps,
    loadConfigData: syncConfig,
    buildIndex: fakeBuildIndex(5, [], 'v1'),
  })
  mkdirSync(join(dataDir, 'worktrees', 'r1', 'main', '.git'), { recursive: true })
  mkdirSync(releaseDir(dataDir, 'r1', '1.99.0'), { recursive: true })

  const result = await builder.syncRepo(syncConfig().repos[0], { fetch: true })
  assert.equal(result.fetchOk, false)
  assert.ok(existsSync(releaseDir(dataDir, 'r1', '1.99.0')), 'fetch 失败不动任何发布目录')
  rmSync(dataDir, { recursive: true, force: true })
})

test('updateRepo：分支落后远端 → reset 对齐 + 入队索引，返回逐分支结果', async () => {
  const dataDir = tmpDataDir()
  const remote = ['main', '1.2.0']
  const gitOps = fakeSyncGitOps(remote)
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps,
    loadConfigData: syncConfig,
    buildIndex: fakeBuildIndex(5, [], 'v1'),
  })
  mkdirSync(join(dataDir, 'worktrees', 'r1', 'main', '.git'), { recursive: true })
  mkdirSync(join(dataDir, 'worktrees', 'r1', '1.2.0', '.git'), { recursive: true })

  const result = await builder.updateRepo(syncConfig().repos[0], { trigger: 'manual' })
  assert.equal(result.ok, true)
  const changed = result.results.find(r => r.branch === '1.2.0')
  assert.ok(changed?.changed && changed.building, '落后分支已 reset 并进入索引队列')
  assert.equal(changed.behind, 3)
  assert.ok(gitOps.calls.reset.includes('1.2.0'))
  const unchanged = result.results.find(r => r.branch === 'main')
  assert.equal(unchanged.changed, false)
  rmSync(dataDir, { recursive: true, force: true })
})

test('updateRepo retryStale：产物就绪但构建 commit 落后 → 补入队；一致后不再补', async () => {
  const dataDir = tmpDataDir()
  const remote = ['main']
  const gitOps = fakeSyncGitOps(remote)
  gitOps.branchSha = async () => 'old-sha' // 远端无新提交（与工作树 headSha 一致）
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps,
    loadConfigData: syncConfig,
    buildIndex: fakeBuildIndex(5, [], 'v1'),
  })
  mkdirSync(join(dataDir, 'worktrees', 'r1', 'main', '.git'), { recursive: true })
  // 产物已就绪，但上次构建的 commit 是旧值（落后于工作树当前 commit）
  mkdirSync(releaseDir(dataDir, 'r1', 'main'), { recursive: true })
  writeFileSync(treeJsonPath(releaseDir(dataDir, 'r1', 'main')), '{}')
  const { touchBranchBuilt } = await import('../src/store.mjs')
  touchBranchBuilt(dataDir, 'r1', 'main', 'stale-sha')

  // 手动同步带 retryStale：产物在但 commit 落后 → 补入队（物缺分支由 syncRepo 自带逻辑负责，这里专测 commit 落后）
  const result = await builder.updateRepo(syncConfig().repos[0], {
    trigger: 'manual',
    retryStale: true,
  })
  const main = result.results.find(r => r.branch === 'main')
  assert.equal(main.changed, false)
  assert.equal(main.reason, 'stale-index', '产物 commit 落后 → 标记补建')
  assert.equal(main.building, true)

  // 构建完成后 commit 追上（touchBranchBuilt 归位）→ 第二轮不应再补
  await new Promise(resolve => setTimeout(resolve, 50))
  touchBranchBuilt(dataDir, 'r1', 'main', 'old-sha')
  const second = await builder.updateRepo(syncConfig().repos[0], {
    trigger: 'manual',
    retryStale: true,
    onlyBranch: 'main',
  })
  const main2 = second.results.find(r => r.branch === 'main')
  assert.equal(main2.reason ?? null, null, '产物就绪且 commit 一致 → 不再补建')
  assert.equal(main2.building, undefined)
  rmSync(dataDir, { recursive: true, force: true })
})

test('updateRepo 缺省（轮询）：产物 commit 落后的分支不每轮轰炸（补建只由手动同步触发）', async () => {
  const dataDir = tmpDataDir()
  const remote = ['main']
  const gitOps = fakeSyncGitOps(remote)
  gitOps.branchSha = async () => 'old-sha'
  const builder = createBuilder({
    dataDir,
    platformDir: '.',
    version: 'test',
    gitOps,
    loadConfigData: syncConfig,
    buildIndex: fakeBuildIndex(5, [], 'v1'),
  })
  mkdirSync(join(dataDir, 'worktrees', 'r1', 'main', '.git'), { recursive: true })
  mkdirSync(releaseDir(dataDir, 'r1', 'main'), { recursive: true })
  writeFileSync(treeJsonPath(releaseDir(dataDir, 'r1', 'main')), '{}')
  const { touchBranchBuilt } = await import('../src/store.mjs')
  touchBranchBuilt(dataDir, 'r1', 'main', 'stale-sha')

  const result = await builder.updateRepo(syncConfig().repos[0], { trigger: 'poll' })
  const main = result.results.find(r => r.branch === 'main')
  assert.equal(main.reason ?? null, null, '轮询缺省 retryStale=false → 不补建')
  assert.equal(main.building, undefined)
  rmSync(dataDir, { recursive: true, force: true })
})
