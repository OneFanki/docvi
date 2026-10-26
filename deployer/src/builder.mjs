/**
 * 索引管线（零编译形态，PRD R6 演进版，AC5/AC6）：
 * 全局串行队列 + 按（仓库,分支）去重取最新目标；
 * 索引任务 = reset 工作树 → 应用粘贴配置 → 生成 tree.json + search-index.json
 * → 写入分支发布目录（临时文件 + rename，单文件原子）。
 *
 * 与旧编译管线的差异：毫秒级纯文本操作、无快照无 symlink；
 * 失败不触碰已有发布文件（版本号自然不更新，读者看到的一直是上一版）；
 * 调度/去重/审计/挂载策略口径不变。
 *
 * io 从 deps 注入（git 操作、索引生成器、挂载策略），单测用假件驱动。
 */
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { branchDir } from './git.mjs'
import { branchInWhitelist, effAutoBuild } from './config.mjs'
import {
  audit,
  bareDir,
  buildLogPath,
  credentialFile,
  ensureBuildsDir,
  listBuilds,
  listDirNames,
  readMounted,
  readSync,
  releaseDir,
  releasesDir,
  rmrf,
  saveBuildRecord,
  searchIndexJsonPath,
  touchBranchBuilt,
  touchSync,
  touchSyncError,
  treeJsonPath,
  worktreeDir,
  writeMounted,
} from './store.mjs'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function appendLog(logFile, chunk) {
  try {
    appendFileSync(logFile, chunk)
  } catch {
    // 日志写失败不阻塞索引
  }
}

/** 默认索引生成器：平台仓 scripts/build-docs-index.mjs（与壳 dev 中间件同一实现）。
 * 无 docs.config.yaml 自动扫描兜底（autoscan）：真仓首录即可浏览——壳对 autoscan
 * 树会展示提示条提醒补配置。发布场景不再因缺配置直接失败（2026-10-15 实仓实测）。 */
async function defaultBuildIndex({ platformDir, worktree }) {
  const mod = await import(pathToFileURL(join(platformDir, 'scripts', 'build-docs-index.mjs')).href)
  return mod.buildDocsIndex(worktree, { autoscan: true })
}

/** 单文件原子写：先写临时文件再 rename（读者永远看到完整 JSON） */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${randomBytes(3).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

/**
 * 预备分支发布目录：旧编译布局里它是指向 snapshots 的 symlink（历史数据卷），
 * 直接摘掉重建为普通目录。
 */
function ensureReleaseDir(dir) {
  try {
    if (lstatSync(dir).isSymbolicLink()) rmSync(dir, { force: true })
  } catch {
    // 不存在：直接建
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

export function createBuilder(deps) {
  const {
    dataDir,
    platformDir,
    version,
    gitOps,
    loadConfigData,
    onSwap = async () => false,
    buildIndex = defaultBuildIndex,
  } = deps

  const queue = []
  const queuedKeys = new Map()
  let running = false

  const bareDirPath = slug => bareDir(dataDir, slug)
  const keyOf = task => `${task.slug}/${task.branch}`

  /**
   * 入队一个索引任务；同分支已有排队任务时仅更新目标（trigger 与参数取最新），
   * 保证连续 push 只刷新最后一个 commit（PRD R7）。
   */
  function enqueue(task) {
    const existing = queuedKeys.get(keyOf(task))
    if (existing) {
      existing.task = { ...existing.task, ...task }
      return existing.promise
    }
    const item = { task, ...deferred() }
    queuedKeys.set(keyOf(task), item)
    queue.push(item)
    pump()
    return item.promise
  }

  async function pump() {
    if (running) return
    const item = queue.shift()
    if (!item) return
    running = true
    queuedKeys.delete(keyOf(item.task))
    try {
      await runTask(item.task)
      item.resolve({ ok: true })
    } catch (error) {
      item.resolve({ ok: false, error: error.message })
      // 失败留痕：provision 失败（如私有仓未配凭证）不入构建记录，
      // 不落审计的话管理页面板上完全看不到原因（实测缺口）
      const task = item.task
      try {
        audit(dataDir, {
          actor: 'system',
          action: 'task.failed',
          type: task.type ?? 'refresh',
          slug: task.slug,
          branch: task.branch,
          error: String(error.message).slice(-300),
        })
      } catch {
        // 审计写失败不阻塞队列
      }
      console.error(
        `[builder] 任务失败 ${task.type ?? 'refresh'} ${task.slug}@${task.branch}：${error.message}`,
      )
    }
    running = false
    pump()
  }

  /** 队列是否在忙（面板状态展示用） */
  const busy = () => running

  async function runTask(task) {
    if (task.type === 'provision') return runProvision(task)
    if (task.type === 'reconcile') return runReconcile(task)
    return runRefresh(task)
  }

  /**
   * 仓库同步与分支谱系维护（统一模型核心）：fetch 主库（可跳）→ 用主库 refs 展开
   * 白名单规则（通配命中 = 在建树集合）→ 为生效分支补建工作树 → 清理「不再生效」的
   * 工作树与发布目录。远端新增分支命中规则即自动建树（读者切过去就有最新文档），
   * 远端删除/不再命中的分支自动清树清产物。
   *
   * fetch 失败（网络抖动）时不清理任何东西——只按现有 refs 尽力补建，避免把在线
   * 分支误删；下一轮 fetch 成功再对齐。
   */
  async function syncRepo(repo, { fetch = true, buildNew = false } = {}) {
    const cfg = loadConfigData()
    const global = cfg.global
    const bare = bareDirPath(repo.slug)
    if (!gitOps.hasBare(bare)) {
      return {
        ok: false,
        reason: 'no-bare',
        fetchOk: false,
        effective: [],
        created: [],
        removed: [],
        failures: [],
      }
    }
    let fetchOk = true
    let fetchError = null
    if (fetch) {
      try {
        await gitOps.fetchBare(bare, {
          credFile: credentialFile(dataDir, repo.slug),
          url: repo.url,
        })
      } catch (error) {
        fetchOk = false
        fetchError = String(error.message).slice(-300)
        // 失败必须留痕：静默的 fetch 失败会让「同步时间」永远为空的谜团无法排查（容器实测）
        touchSyncError(dataDir, repo.slug, fetchError)
        audit(dataDir, {
          actor: 'system',
          action: 'repo.sync.failed',
          slug: repo.slug,
          error: fetchError,
        })
      }
    }
    // clone 后的首轮（fetch=false）同样是「已同步」：同步时间取最新
    if (fetchOk) touchSync(dataDir, repo.slug)
    const remote = await gitOps.remoteBranches(bare).catch(() => [])
    const effective = remote.filter(branch => branchInWhitelist(repo.branches, branch))
    const failures = []
    const created = []
    for (const branch of effective) {
      const dir = worktreeDir(dataDir, repo.slug, branchDir(branch))
      const existed = existsSync(join(dir, '.git'))
      try {
        await gitOps.ensureWorktree(bare, dir, branch)
        if (!existed) {
          created.push(branch)
          if (buildNew && effAutoBuild(repo, global)) {
            enqueue({ slug: repo.slug, branch, trigger: 'auto-branch' })
          }
        } else if (
          buildNew &&
          effAutoBuild(repo, global) &&
          !isReleaseReady(dataDir, repo.slug, branch)
        ) {
          // 已有工作树但没有发布产物（首轮失败/平台升级后缺失）：
          // boot / 定期清理轮次各重试一次，避免「failed 分支永远等人手点刷新」
          enqueue({ slug: repo.slug, branch, trigger: 'reconcile' })
        }
      } catch (error) {
        failures.push(`${branch}：${String(error.message).slice(-200)}`)
      }
    }
    const removed = []
    if (fetchOk) {
      const wanted = new Set(effective.map(branchDir))
      try {
        await gitOps.pruneForeignWorktrees(bare, repo.slug, wanted)
      } catch (error) {
        failures.push(`cleanup：${String(error.message).slice(-200)}`)
      }
      // 磁盘残留（未注册进 git 的工作树目录）与发布目录：不在生效集内即清理
      for (const name of listDirNames(join(dataDir, 'worktrees', repo.slug))) {
        if (wanted.has(name)) continue
        rmrf(join(dataDir, 'worktrees', repo.slug, name))
        rmrf(releaseDir(dataDir, repo.slug, name))
        removed.push(name)
      }
      for (const name of listDirNames(releasesDir(dataDir, repo.slug))) {
        if (wanted.has(name)) continue
        rmrf(releaseDir(dataDir, repo.slug, name))
      }
      // 默认展示/等待挂载的指针若指向已被清掉的分支 → 一并收口
      const mounted = readMounted(dataDir)
      const drops = spot => spot && spot.slug === repo.slug && !wanted.has(branchDir(spot.branch))
      if (drops(mounted.current) || drops(mounted.pending)) {
        writeMounted(dataDir, {
          current: drops(mounted.current) ? null : mounted.current,
          pending: drops(mounted.pending) ? null : mounted.pending,
        })
      }
      if (created.length || removed.length || failures.length) {
        audit(dataDir, {
          actor: 'system',
          action: 'repo.sync',
          slug: repo.slug,
          fetchOk,
          created,
          removed,
          failures: failures.slice(0, 5),
        })
      }
    }
    return { ok: true, fetchOk, fetchError, effective, created, removed, failures }
  }

  /**
   * 拉取更新（手动 / webhook / 轮询共用）：fetch + 分支维护，然后把每个工作树
   * 对齐到远端最新；autoBuild 开启时入索引队列。返回逐分支结果供运维界面展示。
   * retryStale：无新提交但索引落后（产物缺失 / 构建 commit 落后工作树）的分支也补入队——
   * 手动「同步」用（把待索引、索引失败的分支一并拉齐）；轮询缺省不重试（避免失败分支每轮轰炸）。
   */
  async function updateRepo(
    repo,
    { trigger = 'manual', build = true, onlyBranch, retryStale = false } = {},
  ) {
    const cfg = loadConfigData()
    const global = cfg.global
    const bare = bareDirPath(repo.slug)
    const buildOn = build && effAutoBuild(repo, global)
    const synced = await syncRepo(repo, { fetch: true, buildNew: buildOn })
    if (!synced.fetchOk) throw new Error(`拉取失败：${synced.fetchError ?? '主库不可用'}`)
    const results = []
    for (const branch of synced.effective) {
      if (onlyBranch && branch !== onlyBranch) continue
      const wt = worktreeDir(dataDir, repo.slug, branchDir(branch))
      if (!existsSync(join(wt, '.git'))) {
        results.push({ branch, changed: false, error: '工作树未就绪' })
        continue
      }
      const localSha = await gitOps.headSha(wt)
      const remoteSha = await gitOps.branchSha(bare, branch).catch(() => null)
      if (!remoteSha || remoteSha === localSha) {
        let retry = false
        if (retryStale && buildOn && !synced.created.includes(branch)) {
          const builtCommit = readSync(dataDir, repo.slug).branches[branch]?.commit ?? null
          const running =
            listBuilds(dataDir, { slug: repo.slug, branch, limit: 1 })[0]?.status === 'running'
          retry =
            !running && (!isReleaseReady(dataDir, repo.slug, branch) || builtCommit !== localSha)
        }
        if (retry) {
          enqueue({ slug: repo.slug, branch, trigger })
          results.push({ branch, changed: false, building: true, reason: 'stale-index' })
        } else {
          results.push({ branch, changed: false, created: synced.created.includes(branch) })
        }
        continue
      }
      const behind = await gitOps.behindCount(bare, branch, localSha)
      await gitOps.resetWorktree(wt, branch)
      audit(dataDir, {
        actor: trigger,
        action: 'branch.update',
        slug: repo.slug,
        branch,
        from: localSha,
        to: remoteSha,
      })
      if (buildOn) {
        enqueue({ slug: repo.slug, branch, trigger })
        results.push({ branch, changed: true, behind, building: true })
      } else {
        results.push({ branch, changed: true, behind, building: false })
      }
    }
    for (const branch of synced.created) {
      if (onlyBranch && branch !== onlyBranch) continue
      if (results.some(r => r.branch === branch)) continue
      results.push({ branch, changed: true, created: true, building: buildOn })
    }
    return { ok: true, results, created: synced.created, removed: synced.removed }
  }

  /** 新仓库：克隆主库 → 分支谱系维护（白名单规则在远端展开）→ 全部索引首轮刷新（AC2）。
   * 单分支失败不中断其他分支（失败分支面板可见，可手动重试） */
  async function runProvision(task) {
    const cfg = loadConfigData()
    const repo = cfg.repos.find(r => r.slug === task.slug)
    if (!repo) throw new Error(`仓库不存在：${task.slug}`)
    const bare = bareDirPath(task.slug)
    const credFile = credentialFile(dataDir, task.slug)
    if (!gitOps.hasBare(bare)) {
      // 残缺主库（被中断的 clone 留下的 HEAD-only 目录）先清掉再克隆，
      // 否则 git clone 报 "already exists" 且永远无法自愈
      rmrf(bare)
      await gitOps.cloneMirror(repo.url, bare, { credFile })
    }
    // clone 即最新：不重复 fetch；按远端 refs 展开白名单（通配分支此刻就建树）
    const synced = await syncRepo(repo, { fetch: false })
    const branches = synced.effective
    if (!branches.length) {
      throw new Error(
        `分支规则未命中任何远端分支（规则：${repo.branches.join('、')}；请检查仓库分支命名）`,
      )
    }
    const failures = [...(synced.failures ?? [])]
    for (const branch of branches) {
      try {
        await runRefresh({ slug: task.slug, branch, trigger: 'provision' })
      } catch (error) {
        failures.push(`${branch}：${String(error.message).slice(-200)}`)
      }
    }
    if (failures.length) throw new Error(`部分分支首轮索引失败 → ${failures.join(' | ')}`)
  }

  /** 周期调和（白名单调整 / 定时清理 / 启动恢复共用）：fetch + 分支谱系维护，
   * 新命中规则的远端分支自动建树并入队索引 */
  async function runReconcile(task) {
    const cfg = loadConfigData()
    const repo = cfg.repos.find(r => r.slug === task.slug)
    if (!repo) return
    await syncRepo(repo, { fetch: true, buildNew: true })
  }

  async function runRefresh(task) {
    const startedAt = new Date().toISOString()
    const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    ensureBuildsDir(dataDir)
    const logFile = buildLogPath(dataDir, id)
    const cfg = loadConfigData()
    const repo = cfg.repos.find(r => r.slug === task.slug)
    if (!repo) throw new Error(`仓库不存在：${task.slug}`)

    const record = {
      id,
      repo: task.slug,
      branch: task.branch,
      commit: '',
      version: '',
      trigger: task.trigger,
      status: 'running',
      startedAt,
      durationMs: 0,
      platformVersion: version,
    }
    saveBuildRecord(dataDir, record)

    try {
      const wt = worktreeDir(dataDir, task.slug, branchDir(task.branch))
      await gitOps.resetWorktree(wt, task.branch)
      record.commit = await gitOps.headSha(wt)
      await applyContentConfig(wt, repo)

      appendLog(logFile, `▶ 索引刷新 ${task.slug}@${task.branch}（${record.trigger}）\n`)
      const built = await buildIndex({
        platformDir,
        worktree: wt,
        dataDir,
        slug: task.slug,
        branch: task.branch,
      })
      record.version = built.version
      if (built.tree?.configSource === 'autoscan') {
        appendLog(
          logFile,
          'ℹ 未找到 docs.config.yaml：目录树使用自动扫描（补一份配置文件可声明精确结构）\n',
        )
      }

      const outDir = ensureReleaseDir(releaseDir(dataDir, task.slug, branchDir(task.branch)))
      // 先写搜索索引、后写树：树是读者侧「当前版本」的判定源，最后落盘
      writeJsonAtomic(searchIndexJsonPath(outDir), built.searchIndex)
      writeJsonAtomic(treeJsonPath(outDir), built.tree)
      touchBranchBuilt(dataDir, task.slug, task.branch, record.commit)
      appendLog(
        logFile,
        `✔ tree/search-index 已更新（版本 ${built.version}，${Date.now() - Date.parse(startedAt)}ms）\n`,
      )

      record.status = 'success'
      record.durationMs = Date.now() - Date.parse(startedAt)
      saveBuildRecord(dataDir, record)

      const mountedNow = await onSwap({ slug: task.slug, branch: task.branch, buildId: id })
      if (mountedNow) appendLog(logFile, '✔ 已挂载到站点\n')
    } catch (error) {
      // 失败不触碰已有发布文件：在线版本不受影响，版本号自然不更新
      record.status = 'failed'
      record.durationMs = Date.now() - Date.parse(startedAt)
      record.error = String(error.message).slice(-500)
      saveBuildRecord(dataDir, record)
      appendLog(logFile, `✗ ${record.error}\n`)
      throw error
    }
  }

  /** 粘贴配置优先（PRD R9）：有覆盖写入工作区根，无覆盖还原仓库自带文件 */
  async function applyContentConfig(wt, repo) {
    if (repo.contentOverride) {
      writeFileSync(join(wt, 'docs.config.yaml'), repo.contentOverride)
    } else {
      await gitOps.restoreContentConfig(wt)
    }
  }

  return { enqueue, busy, syncRepo, updateRepo }
}

/**
 * 挂载决策（onSwap 缺省实现）：平台上没有任何挂载时首个分支自动上架（单仓引导
 * 零操作，AC2）；pending 目标索引成功即正式挂载（切到未就绪分支的收尾，PRD R3）。
 */
export function createMountPolicy({ dataDir }) {
  return async function onSwap({ slug, branch }) {
    const mounted = readMounted(dataDir)
    if (!mounted.current) {
      writeMounted(dataDir, { current: { slug, branch }, pending: null })
      return true
    }
    if (mounted.pending && mounted.pending.slug === slug && mounted.pending.branch === branch) {
      writeMounted(dataDir, { current: { slug, branch }, pending: null })
      return true
    }
    return false
  }
}

/** 发布目录就绪判定：tree.json 已生成（挂载切换与面板状态共用） */
export function isReleaseReady(dataDir, slug, branch) {
  try {
    return lstatSync(treeJsonPath(releaseDir(dataDir, slug, branchDir(branch)))).isFile()
  } catch {
    return false
  }
}

export { releaseDir, releasesDir, rmrf }
