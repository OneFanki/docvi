/**
 * HTTP 层：运维 API（Bearer OPS_TOKEN）+ webhook + 壳站点服务 + 门户/管理页。
 * 站点服务每请求重新解析挂载指针并直读磁盘——切仓库/分支即时生效，无句柄缓存。
 * 零编译：内容 md 与索引 JSON 直接来自工作树/发布目录，不做任何构建。
 * 失败与越界的总原则：任何写操作不影响在线内容。
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import {
  credentialFile,
  hasCredential,
  listBuilds,
  listDirNames,
  readAudit,
  readBuildLog,
  readMounted,
  readSync,
  readerFacingSyncError,
  releaseDir,
  releasesDir,
  rmrf,
  searchIndexJsonPath,
  treeJsonPath,
  worktreeDir,
  writeMounted,
} from './store.mjs'
import {
  branchDir,
  behindCount,
  branchSha,
  headSha,
  remoteBranches,
  removeCredentialFile,
  writeCredentialFile,
} from './git.mjs'
import { isReleaseReady } from './builder.mjs'
import { branchInWhitelist, generateWebhookSecret, validateRepoInput } from './config.mjs'
import { PluginError } from './plugins.mjs'
import { ShareError } from './shares.mjs'
import { handleMcp } from './mcp.mjs'
import { opsHtml } from './portal.mjs'
import {
  createShareProxy,
  createStaticSite,
  readJsonBody,
  resolveInRoot,
  sendFile,
  writeJson,
} from '../../packages/server/src/http-kit.mjs'
import { createCorpus } from '../../packages/server/src/corpus.mjs'

/** 运维面请求体上限（仓库配置 / 插件安装来源等短 JSON；2MB 足够） */
const BODY_LIMIT = 2 * 1024 * 1024

export function createHttpd(ctx) {
  const {
    dataDir,
    platformDir,
    version,
    token,
    gitOps,
    builder,
    plugins,
    shares,
    loadConfigData,
    saveConfigData,
    audit: writeAudit,
  } = ctx

  function tokenOk(req) {
    if (!token) return false // 未配置 token = 运维面关闭（安全缺省）
    const header = req.headers.authorization ?? ''
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ''))
    const expect = Buffer.from(token)
    return given.length === expect.length && timingSafeEqual(given, expect)
  }

  function secretOk(req, repo) {
    const given = String(
      new URL(req.url, 'http://x').searchParams.get('secret') ??
        req.headers['x-webhook-secret'] ??
        '',
    )
    const expect = Buffer.from(given)
    const real = Buffer.from(repo.webhookSecret)
    return given && expect.length === real.length && timingSafeEqual(expect, real)
  }

  const json = writeJson
  /** 请求体：共享实现，上限按运维面放宽到 2MB */
  const readBody = req => readJsonBody(req, { limit: BODY_LIMIT })

  /** 分支实时状态：本地/远端 commit、落后 N、索引状态 + 最近一次任务 */
  async function branchState(repo, branch) {
    const bare = join(dataDir, 'git', `${repo.slug}.git`)
    const wt = join(dataDir, 'worktrees', repo.slug, branchDir(branch))
    const state = {
      branch,
      localSha: null,
      remoteSha: null,
      behind: 0,
      artifact: 'none',
      lastBuild: null,
    }
    const records = listBuilds(dataDir, { slug: repo.slug, branch, limit: 1 })
    if (records.length)
      state.lastBuild = {
        id: records[0].id,
        status: records[0].status,
        startedAt: records[0].startedAt,
      }
    if (isReleaseReady(dataDir, repo.slug, branch)) state.artifact = 'ready'
    else if (records[0]?.status === 'running') state.artifact = 'building'
    else if (records[0]?.status === 'failed') state.artifact = 'failed'
    try {
      state.localSha = await headSha(wt)
      state.remoteSha = await branchSha(bare, branch)
      state.behind = await behindCount(bare, branch, state.localSha)
    } catch {
      // 分支尚无远端引用或工作树未建：保持空值，面板按「等待远端」展示
    }
    return state
  }

  /** 运维面仓库全息（token 保护）：白名单规则 + 生效分支实况 + 同步时间 */
  async function repoFullSummary(repo) {
    const bare = join(dataDir, 'git', `${repo.slug}.git`)
    const bareExists = gitOps.hasBare(bare)
    const effective = bareExists
      ? (await remoteBranches(bare).catch(() => [])).filter(b =>
          branchInWhitelist(repo.branches, b),
        )
      : []
    const mounted = readMounted(dataDir).current
    const sync = readSync(dataDir, repo.slug)
    const raw = []
    for (const branch of effective) {
      const state = await branchState(repo, branch)
      raw.push({ ...state, buildAt: sync.branches[branch]?.buildAt ?? null })
    }
    // 生效默认分支（与读者面同优先级：挂载命中 → main/master → 首个 ready → 首个生效）——
    // 面板据此标「默认」，不再只认挂载指针（从没点过设为默认时也必须看得见默认是谁）
    const readyBranches = raw.filter(b => b.artifact === 'ready')
    const conventional = ['main', 'master'].find(name => readyBranches.some(b => b.branch === name))
    const defaultBranch =
      mounted?.slug === repo.slug && readyBranches.some(b => b.branch === mounted.branch)
        ? mounted.branch
        : (conventional ?? readyBranches[0]?.branch ?? raw[0]?.branch ?? null)
    const branches = raw.map(b => ({ ...b, isDefault: b.branch === defaultBranch }))
    return {
      slug: repo.slug,
      name: repo.name,
      url: repo.url,
      autoFetch: repo.autoFetch,
      autoBuild: repo.autoBuild,
      patterns: repo.branches,
      hasOverride: Boolean(repo.contentOverride),
      hasCredential: hasCredential(dataDir, repo.slug),
      branches,
      defaultBranch,
      /** 分支级 webhook 推送地址所需的 secret（token 保护，面板展示/复制） */
      webhookSecret: repo.webhookSecret ?? '',
      /** 首次克隆尚未完成（主库不存在）：界面按「克隆中」展示并自动刷新 */
      cloning: !bareExists,
      syncAt: sync.at,
      syncError: sync.error?.message ?? null,
      mounted: mounted?.slug === repo.slug ? mounted.branch : null,
    }
  }

  /**
   * 内容寻址（读者面）：`/<slug>/…` 独立路由，任何人免凭证。
   * 分支经 ?branch= 指定（缺省 = 该仓库的默认分支：mounted 指针命中则用其分支，
   * 否则优先 ready 的第一个生效分支）。返回 null = 不是内容请求。
   */
  async function resolveContentScope(url) {
    const clean = url.split(/[?#]/)[0]
    const segments = clean.split('/').filter(Boolean)
    if (!segments.length) return null
    const cfg = loadConfigData()
    const repo = cfg.repos.find(r => r.slug === segments[0])
    if (!repo) return null
    const bare = join(dataDir, 'git', `${repo.slug}.git`)
    const effective = gitOps.hasBare(bare)
      ? (await remoteBranches(bare).catch(() => [])).filter(b =>
          branchInWhitelist(repo.branches, b),
        )
      : []
    const mounted = readMounted(dataDir).current
    const requested = new URL(url, 'http://x').searchParams.get('branch')
    const ready = effective.filter(b => isReleaseReady(dataDir, repo.slug, b))
    let branch = null
    if (requested) branch = effective.includes(requested) ? requested : null
    if (!branch && mounted && mounted.slug === repo.slug && ready.includes(mounted.branch))
      branch = mounted.branch
    if (!branch) branch = ready[0] ?? effective[0] ?? null
    const worktreeRoot = branch ? worktreeDir(dataDir, repo.slug, branchDir(branch)) : null
    return {
      repo,
      branch,
      requestedBranch: requested,
      rest: '/' + segments.slice(1).join('/'),
      worktreeRoot: worktreeRoot && existsSync(worktreeRoot) ? worktreeRoot : null,
    }
  }

  /** 读者面仓库清单（公开口径：不含 url/secret/凭据/覆盖配置）。
   *  每分支带 index 状态（面板状态点口径）：indexed=绿（最新且索引完成）、
   *  indexing=索引中、pending=待索引、failed=索引失败。 */
  async function readerRepos() {
    const cfg = loadConfigData()
    const mounted = readMounted(dataDir).current
    const repos = []
    for (const repo of cfg.repos) {
      const bare = join(dataDir, 'git', `${repo.slug}.git`)
      const bareExists = gitOps.hasBare(bare)
      const effective = bareExists
        ? (await remoteBranches(bare).catch(() => [])).filter(b =>
            branchInWhitelist(repo.branches, b),
          )
        : []
      const sync = readSync(dataDir, repo.slug)
      const branches = []
      let anyReady = false
      for (const branch of effective) {
        const releaseReady = isReleaseReady(dataDir, repo.slug, branch)
        if (releaseReady) anyReady = true
        const record = listBuilds(dataDir, { slug: repo.slug, branch, limit: 1 })[0]
        // 索引状态（面板状态点口径）：green = 最新且索引完成——产物就绪且构建 commit
        // 与工作树当前 commit 一致；新提交在途（已 fetch 未重索引）不算完成。
        // 与 artifact 分开：artifact 表示「可浏览」（重建期间旧产物照常服务）。
        const builtCommit = sync.branches[branch]?.commit ?? null
        let worktreeSha = null
        try {
          worktreeSha = await headSha(join(dataDir, 'worktrees', repo.slug, branchDir(branch)))
        } catch {
          // 工作树未建/缺失：按待索引处理（reconcile 轮会补建）
        }
        const upToDate = releaseReady && (!builtCommit || worktreeSha === builtCommit)
        const index = upToDate
          ? 'indexed'
          : record?.status === 'running'
            ? 'indexing'
            : record?.status === 'failed'
              ? 'failed'
              : 'pending'
        branches.push({
          branch,
          artifact: releaseReady
            ? 'ready'
            : record?.status === 'running'
              ? 'building'
              : record?.status === 'failed'
                ? 'failed'
                : 'none',
          index,
          buildAt: sync.branches[branch]?.buildAt ?? null,
          isDefault: mounted && mounted.slug === repo.slug ? branch === mounted.branch : false,
        })
      }
      if (!branches.length && !bareExists) {
        // 首次克隆尚未完成：仍列出卡片（首页展示「克隆中」，完成后自动出现分支）
        repos.push({
          slug: repo.slug,
          name: repo.name,
          ready: false,
          branches: [],
          defaultBranch: null,
          cloning: true,
          syncAt: sync.at,
          syncError: sync.error ? readerFacingSyncError(sync.error.message) : null,
        })
        continue
      }
      if (!branches.length) continue
      const readyBranches = branches.filter(b => b.artifact === 'ready')
      // 默认分支优先级：挂载命中的分支 → main/master → 首个 ready → 首个生效
      const conventional = ['main', 'master'].find(name =>
        readyBranches.some(b => b.branch === name),
      )
      const fallback =
        mounted &&
        mounted.slug === repo.slug &&
        readyBranches.some(b => b.branch === mounted.branch)
          ? mounted.branch
          : (conventional ?? readyBranches[0]?.branch ?? branches[0]?.branch ?? null)
      repos.push({
        slug: repo.slug,
        name: repo.name,
        ready: anyReady,
        branches,
        defaultBranch: fallback,
        cloning: false,
        syncAt: sync.at,
        syncError: sync.error ? readerFacingSyncError(sync.error.message) : null,
      })
    }
    return repos
  }

  async function handleApi(req, res, pathname) {
    const method = req.method
    const parts = pathname.split('/').filter(Boolean) // ['api', ...]
    const query = new URL(req.url, 'http://x').searchParams

    if (method === 'GET' && pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version,
        mounted: readMounted(dataDir).current,
        busy: builder.busy(),
      })
    }

    // 读者面仓库清单（公开）：壳首页/分支选择器的数据源
    if (method === 'GET' && pathname === '/api/portal') {
      const cfg = loadConfigData()
      const read = new Set(cfg.repos.map(r => r.slug))
      // 已不在配置里的仓库目录：同步清掉（配置删仓库的兜底再收口）
      for (const name of listDirNames(join(dataDir, 'releases'))) {
        if (!read.has(name)) rmrf(releasesDir(dataDir, name))
      }
      return json(res, 200, { repos: await readerRepos(), mounted: readMounted(dataDir).current })
    }

    // 内容数据（公开）：?repo=<slug>（缺省 = mounted 仓库）&branch=（缺省 = 该仓库默认分支）。
    // 壳的数据源：tree 与 search-index 只服务对应分支的发布文件
    if (method === 'GET' && (pathname === '/api/tree' || pathname === '/api/search-index')) {
      const slug = query.get('repo')
      const branch = query.get('branch')
      let scope = null
      if (slug) {
        const cfg = loadConfigData()
        const repo = cfg.repos.find(r => r.slug === slug)
        if (!repo) return json(res, 404, { error: `仓库不存在：${slug}` })
        const bare = join(dataDir, 'git', `${repo.slug}.git`)
        const effective = gitOps.hasBare(bare)
          ? (await remoteBranches(bare).catch(() => [])).filter(b =>
              branchInWhitelist(repo.branches, b),
            )
          : []
        const ready = effective.filter(b => isReleaseReady(dataDir, repo.slug, b))
        const use =
          branch && effective.includes(branch) ? branch : (ready[0] ?? effective[0] ?? null)
        if (use) scope = { slug: repo.slug, branch: use }
      } else {
        scope = readMounted(dataDir).current
      }
      if (!scope || !scope.branch) return json(res, 503, { error: '暂无已挂载的文档分支' })
      const dir = releaseDir(dataDir, scope.slug, branchDir(scope.branch))
      const file = pathname === '/api/tree' ? treeJsonPath(dir) : searchIndexJsonPath(dir)
      if (!existsSync(file)) return json(res, 503, { error: '索引缺失（等待索引刷新完成）' })
      return sendJsonFile(res, file)
    }

    if (method === 'GET' && pathname === '/api/audit') {
      if (!tokenOk(req))
        return json(res, token ? 401 : 503, {
          error: token ? 'token 无效' : '未配置 OPS_TOKEN，运维面关闭',
        })
      return json(res, 200, { lines: readAudit(dataDir, 100) })
    }

    // 插件目录（协议 v1）：壳启动装载数据源——全部已安装插件，
    // enabled / disabledComponents 标志随附（壳据此激活与占位）。
    // 公开请求 = 纯目录（不含安装来源）；带运维 token = 全量状态（opsStatus：
    // 附 active/conflicts 诊断与 sourceLabel——浏览器读者面永远拿不到来源信息）
    if (method === 'GET' && pathname === '/api/plugins') {
      if (tokenOk(req)) return json(res, 200, plugins.opsStatus())
      return json(res, 200, plugins.catalog())
    }

    // 组件示例（协议 v1.1，公开——示例/包文件本就经 /plugins/* 公开伺服）：
    // GET /api/plugins/<name>/example/<kind> → 示例 markdown 原文（壳预览页整页渲染）
    if (
      method === 'GET' &&
      parts[0] === 'api' &&
      parts[1] === 'plugins' &&
      parts[3] === 'example' &&
      parts.length === 5
    ) {
      try {
        const file = plugins.resolveComponentExample(
          decodeURIComponent(parts[2]),
          decodeURIComponent(parts[4]),
        )
        if (!file) return json(res, 404, { error: 'no-example', code: 'NO_EXAMPLE' })
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        return createReadStream(file).pipe(res)
      } catch (error) {
        if (error instanceof PluginError) {
          return json(res, error.status, { error: error.message, code: error.code })
        }
        throw error
      }
    }

    if (parts[0] === 'api' && parts[1] === 'webhooks' && method === 'POST') {
      const slug = parts[2]
      const repo = loadConfigData().repos.find(r => r.slug === slug)
      if (!repo || !secretOk(req, repo)) return json(res, 404, { error: 'not found' })
      const outcome = await builder.updateRepo(repo, { trigger: 'webhook' })
      return json(res, 200, outcome)
    }

    // ——以下全部要求运维 token——
    if (!tokenOk(req)) {
      return json(res, token ? 401 : 503, {
        error: token ? 'token 无效' : '未配置 OPS_TOKEN，运维面关闭（启动时注入）',
      })
    }

    // 临时分享管理（运维，token 后）：创建/启停/删除 + 共享根状态。
    // 代理语义：创建只登记路径（不复制内容）；链接 = <origin>/s/<id>/
    if (parts[0] === 'api' && parts[1] === 'shares') {
      try {
        if (method === 'GET' && parts.length === 2) {
          return json(res, 200, {
            shares: shares.list(),
            roots: shares.shareRoots,
            rootsExist: shares.shareRoots.map(root => existsSync(root)),
          })
        }
        if (method === 'POST' && parts.length === 2) {
          const body = await readBody(req)
          return json(res, 200, { share: shares.create({ path: body.path, name: body.name }) })
        }
        if (parts.length === 4 && parts[3] === 'toggle' && method === 'POST') {
          const body = await readBody(req)
          return json(res, 200, {
            share: shares.toggle(decodeURIComponent(parts[2]), body.enabled !== false),
          })
        }
        if (parts.length === 3 && method === 'DELETE') {
          return json(res, 200, shares.remove(decodeURIComponent(parts[2])))
        }
      } catch (error) {
        if (error instanceof ShareError) {
          return json(res, error.status, { error: error.message, code: error.code })
        }
        throw error
      }
      return json(res, 404, { error: 'not found' })
    }

    // 插件管理（运维，协议 v1）：安装 / 启停 / 组件级启停 / 卸载
    //（GET /api/plugins 已在公开段按 token 分流返回 opsStatus）
    if (parts[0] === 'api' && parts[1] === 'plugins') {
      try {
        if (method === 'POST' && parts.length === 2) {
          const body = await readBody(req)
          const outcome = await plugins.install({
            source: body.source,
            credential: body.credential,
            enabled: body.enabled !== false,
          })
          return json(res, 200, outcome)
        }
        if (parts.length === 3 && method === 'DELETE') {
          const name = decodeURIComponent(parts[2])
          return json(res, 200, plugins.uninstall(name))
        }
        if (parts.length === 4 && parts[3] === 'enable' && method === 'POST') {
          const name = decodeURIComponent(parts[2])
          return json(res, 200, plugins.setPluginEnabled(name, true))
        }
        if (parts.length === 4 && parts[3] === 'disable' && method === 'POST') {
          const name = decodeURIComponent(parts[2])
          return json(res, 200, plugins.setPluginEnabled(name, false))
        }
        if (
          parts.length === 6 &&
          parts[3] === 'components' &&
          (parts[5] === 'enable' || parts[5] === 'disable') &&
          method === 'POST'
        ) {
          const name = decodeURIComponent(parts[2])
          const kind = decodeURIComponent(parts[4])
          return json(res, 200, plugins.setComponentEnabled(name, kind, parts[5] === 'enable'))
        }
      } catch (error) {
        if (error instanceof PluginError) {
          return json(res, error.status, { error: error.message, code: error.code })
        }
        throw error
      }
      return json(res, 404, { error: 'not found' })
    }

    if (method === 'GET' && pathname === '/api/repos') {
      const cfg = loadConfigData()
      const repos = []
      for (const repo of cfg.repos) repos.push(await repoFullSummary(repo))
      return json(res, 200, { repos, mounted: readMounted(dataDir).current, busy: builder.busy() })
    }

    if (method === 'POST' && pathname === '/api/repos') {
      const body = await readBody(req)
      const cfg = loadConfigData()
      const repo = {
        slug: String(body.slug ?? ''),
        name: String(body.name ?? body.slug ?? ''),
        url: String(body.url ?? ''),
        branches:
          Array.isArray(body.branches) && body.branches.length
            ? body.branches.map(String)
            : ['main'],
        autoFetch: body.autoFetch ?? 'inherit',
        autoBuild: body.autoBuild ?? 'inherit',
        webhookSecret: generateWebhookSecret(),
        contentOverride:
          typeof body.contentOverride === 'string' && body.contentOverride.trim()
            ? body.contentOverride
            : null,
      }
      const { errors } = { errors: validateRepoInput(repo) }
      if (errors.length) return json(res, 422, { error: errors.join('；') })
      if (cfg.repos.some(r => r.slug === repo.slug))
        return json(res, 409, { error: `slug 已存在：${repo.slug}` })
      // 凭证（可选）：必须在 clone 入队前写好——首轮 provision 就要能访问私有仓库
      const credential =
        body.credential && typeof body.credential === 'object' ? body.credential : null
      if (credential && (credential.username || credential.password)) {
        try {
          writeCredentialFile(credentialFile(dataDir, repo.slug), repo.url, {
            username: String(credential.username ?? ''),
            password: String(credential.password ?? ''),
          })
        } catch (error) {
          return json(res, 422, { error: String(error.message) })
        }
      }
      cfg.repos.push(repo)
      saveConfigData(cfg)
      writeAudit(dataDir, {
        actor: 'ops',
        action: 'repo.add',
        slug: repo.slug,
        url: repo.url,
        branches: repo.branches,
        credential: Boolean(credential),
      })
      builder.enqueue({
        type: 'provision',
        slug: repo.slug,
        branch: repo.branches[0],
        trigger: 'provision',
      })
      return json(res, 202, { ok: true, slug: repo.slug, message: '克隆与首次构建已入队' })
    }

    // 每仓 git 凭证：界面填写（免除 GIT_CREDENTIALS 环境变量）；内容不回显
    if (parts[1] === 'repos' && parts[2] && parts[3] === 'credential') {
      const slug = parts[2]
      const cfg = loadConfigData()
      const repo = cfg.repos.find(r => r.slug === slug)
      if (!repo) return json(res, 404, { error: `仓库不存在：${slug}` })
      if (method === 'PUT') {
        const body = await readBody(req)
        try {
          writeCredentialFile(credentialFile(dataDir, slug), repo.url, {
            username: String(body.username ?? ''),
            password: String(body.password ?? ''),
          })
        } catch (error) {
          return json(res, 422, { error: String(error.message) })
        }
        writeAudit(dataDir, { actor: 'ops', action: 'repo.credential.set', slug })
        return json(res, 200, { ok: true, message: '凭证已保存（下次拉取 / 重建时生效）' })
      }
      if (method === 'DELETE') {
        removeCredentialFile(credentialFile(dataDir, slug))
        writeAudit(dataDir, { actor: 'ops', action: 'repo.credential.clear', slug })
        return json(res, 200, { ok: true, message: '凭证已清除' })
      }
    }

    if (parts[1] === 'repos' && parts[2] && !parts[3]) {
      const slug = parts[2]
      const cfg = loadConfigData()
      const repo = cfg.repos.find(r => r.slug === slug)
      if (!repo) return json(res, 404, { error: `仓库不存在：${slug}` })

      if (method === 'PATCH') {
        const body = await readBody(req)
        if (body.name !== undefined) repo.name = String(body.name)
        if (Array.isArray(body.branches) && body.branches.length)
          repo.branches = body.branches.map(String)
        if (body.autoFetch !== undefined) repo.autoFetch = body.autoFetch
        if (body.autoBuild !== undefined) repo.autoBuild = body.autoBuild
        if (body.contentOverride !== undefined) {
          repo.contentOverride =
            typeof body.contentOverride === 'string' && body.contentOverride.trim()
              ? body.contentOverride
              : null
          const errors = validateRepoInput({
            ...repo,
            contentOverride: repo.contentOverride ?? undefined,
            slug: repo.slug,
            name: repo.name,
            url: repo.url,
          })
          if (errors.length) return json(res, 422, { error: errors.join('；') })
        }
        saveConfigData(cfg)
        writeAudit(dataDir, { actor: 'ops', action: 'repo.patch', slug, fields: Object.keys(body) })
        builder.enqueue({ type: 'reconcile', slug, branch: repo.branches[0], trigger: 'reconcile' })
        return json(res, 200, { ok: true })
      }

      if (method === 'DELETE') {
        const mounted = readMounted(dataDir)
        const nextMounted = {
          current: mounted.current?.slug === slug ? null : mounted.current,
          pending: mounted.pending?.slug === slug ? null : mounted.pending,
        }
        writeMounted(dataDir, nextMounted)
        cfg.repos = cfg.repos.filter(r => r.slug !== slug)
        saveConfigData(cfg)
        rmrf(join(dataDir, 'worktrees', slug))
        rmrf(join(dataDir, 'releases', slug))
        writeAudit(dataDir, { actor: 'ops', action: 'repo.remove', slug })
        return json(res, 200, { ok: true, message: '已移除（工作树与产物已清，git 主库保留）' })
      }
    }

    if (parts[1] === 'repos' && parts[2] && parts[3] === 'fetch' && method === 'POST') {
      const repo = loadConfigData().repos.find(r => r.slug === parts[2])
      if (!repo) return json(res, 404, { error: `仓库不存在：${parts[2]}` })
      const outcome = await builder.updateRepo(repo, { trigger: 'manual', build: false })
      return json(res, 200, outcome)
    }

    // 面板主操作「同步」：fetch + 全部生效分支对齐远端（落后入索引队列），
    // 并补建索引落后（产物缺失 / 产物 commit 落后工作树）的分支——一次点击全部拉齐
    if (parts[1] === 'repos' && parts[2] && parts[3] === 'sync' && method === 'POST') {
      const repo = loadConfigData().repos.find(r => r.slug === parts[2])
      if (!repo) return json(res, 404, { error: `仓库不存在：${parts[2]}` })
      const outcome = await builder.updateRepo(repo, { trigger: 'manual', retryStale: true })
      return json(res, 200, outcome)
    }

    if (
      parts[1] === 'repos' &&
      parts[2] &&
      parts[3] === 'branches' &&
      parts[4] &&
      parts[5] &&
      method === 'POST'
    ) {
      const slug = parts[2]
      const branch = decodeURIComponent(parts[4])
      const action = parts[5]
      const cfg = loadConfigData()
      const repo = cfg.repos.find(r => r.slug === slug)
      if (!repo) return json(res, 404, { error: `仓库不存在：${slug}` })
      if (!branchInWhitelist(repo.branches, branch))
        return json(res, 422, { error: `分支不在白名单：${branch}` })

      if (action === 'update') {
        const outcome = await builder.updateRepo(repo, { trigger: 'manual', onlyBranch: branch })
        return json(res, 200, outcome)
      }
      if (action === 'build') {
        builder.enqueue({ slug, branch, trigger: 'manual' })
        return json(res, 202, { building: true })
      }
      if (action === 'switch') {
        return json(res, 200, await switchTo(slug, branch))
      }
    }

    if (parts[1] === 'repos' && parts[2] && parts[3] === 'switch' && method === 'POST') {
      const slug = parts[2]
      const cfg = loadConfigData()
      const repo = cfg.repos.find(r => r.slug === slug)
      if (!repo) return json(res, 404, { error: `仓库不存在：${slug}` })
      const body = await readBody(req)
      const branch = String(body.branch ?? '')
      if (!branchInWhitelist(repo.branches, branch))
        return json(res, 422, { error: `分支不在白名单：${branch}` })
      return json(res, 200, await switchTo(slug, branch))
    }

    if (parts[1] === 'repos' && parts[2] && parts[3] === 'builds' && method === 'GET') {
      return json(res, 200, { builds: listBuilds(dataDir, { slug: parts[2], limit: 30 }) })
    }

    if (parts[1] === 'builds' && parts[3] === 'log' && parts[2] && method === 'GET') {
      const cfg = loadConfigData()
      const log = readBuildLog(dataDir, parts[2], cfg.global.logTailLines)
      if (log === null) {
        // 无日志文件（旧数据/任务在写日志前失败）：从构建记录合成摘要，别让面板空着
        const record = listBuilds(dataDir, { limit: 500 }).find(r => r.id === parts[2])
        if (!record) return json(res, 404, { error: '日志不存在' })
        const summary = [
          `（无日志文件——任务 ${record.id} 的摘要）`,
          `仓库 / 分支：${record.repo} @ ${record.branch}`,
          `状态：${record.status}`,
          record.error ? `错误：${record.error}` : '',
        ]
          .filter(Boolean)
          .join('\n')
        return json(res, 200, { log: summary })
      }
      return json(res, 200, { log })
    }

    // /api/builds（全局列表，管理页面板用）；带 id 的变体不经此分支
    if (parts[1] === 'builds' && method === 'GET') {
      const builds = listBuilds(dataDir, { limit: 30 })
      return json(res, 200, { builds })
    }

    if (pathname === '/api/config') {
      const cfg = loadConfigData()
      if (method === 'GET') return json(res, 200, { global: cfg.global })
      if (method === 'PUT') {
        const body = await readBody(req)
        const merged = { ...cfg.global, ...(body.global ?? {}) }
        if (!['webhook', 'poll', 'off'].includes(merged.autoFetch))
          return json(res, 422, { error: 'autoFetch 取值非法' })
        cfg.global = merged
        saveConfigData(cfg)
        writeAudit(dataDir, { actor: 'ops', action: 'config.update', global: merged })
        return json(res, 200, { ok: true, global: cfg.global })
      }
    }

    return json(res, 404, { error: 'not found' })
  }

  /** 切挂载：已索引即换指针；未就绪挂 pending + 入队（索引成功由 onSwap 收尾） */
  async function switchTo(slug, branch) {
    const mounted = readMounted(dataDir)
    const ready = isReleaseReady(dataDir, slug, branch)
    if (ready) {
      writeMounted(dataDir, { current: { slug, branch }, pending: null })
      writeAudit(dataDir, { actor: 'ops', action: 'mount', slug, branch })
      return { mounted: true, slug, branch }
    }
    writeMounted(dataDir, { current: mounted.current, pending: { slug, branch } })
    builder.enqueue({ slug, branch, trigger: 'switch' })
    writeAudit(dataDir, { actor: 'ops', action: 'mount.pending', slug, branch })
    return { building: true, slug, branch }
  }

  // ——站点服务与门户（零编译：md 与索引直读磁盘）——

  /**
   * 站点资产根：app 渲染层的 web 变体（`apps/desktop/dist-web`）。
   *
   * 容器与桌面跑同一份 UI 源码，宿主差异由渲染层的 web-host.ts 提供。
   * 产物缺失时不再回退别的壳——镜像与本地都必须先构建它（`pnpm docvi:build:web`），
   * 静默回退会让「到处是旧界面」变成最难查的那类问题。
   */
  const shellRoot = join(platformDir, 'apps', 'desktop', 'dist-web')
  if (!existsSync(join(shellRoot, 'index.html'))) {
    console.warn(
      '[deployer] 缺少 apps/desktop/dist-web/index.html——站点将无法渲染，请先运行 pnpm docvi:build:web',
    )
  }

  /** 索引 JSON：一律 no-cache——切分支/刷新后立即读到新版本 */
  function sendJsonFile(res, file) {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
    createReadStream(file).pipe(res)
  }

  /** dir 模式分享的树/搜索索引：平台索引生成器（与仓库索引同实现，autoscan 兜底） */
  let buildDocsIndexFn = null
  async function buildShareIndex(root) {
    if (!buildDocsIndexFn) {
      const mod = await import(
        pathToFileURL(join(platformDir, 'scripts', 'build-docs-index.mjs')).href
      )
      buildDocsIndexFn = mod.buildDocsIndex
    }
    return buildDocsIndexFn(root, { autoscan: true })
  }

  /** 分享链接失效页（404 文案区分：不存在 / 已停用 / 目标消失——代理语义的诚实表达） */
  function shareGonePage(reason, entry) {
    const text =
      reason === 'disabled'
        ? '这个分享已被停用。'
        : reason === 'missing'
          ? `分享的${entry?.kind === 'dir' ? '目录' : '文件'}已不存在（可能被移动或删除）——临时分享是按实际路径实时读取的，路径变化链接即失效。`
          : '分享不存在或已被撤销。'
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>分享不可用 · docvi</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f9;color:#333;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){body{background:#16181d;color:#c9cdd6}}.box{max-width:480px;padding:40px;text-align:center}.mark{width:44px;height:44px;margin:0 auto 16px;border-radius:50%;background:rgba(99,85,217,.12);color:#6355d9;display:flex;align-items:center;justify-content:center;font-size:22px}p{color:#8a93a3}</style>
</head><body><div class="box"><div class="mark">!</div><h2>${text}</h2><p>临时分享是「本地文件的代理」：由分享者的电脑实时提供，不是平台存档。</p></div></body></html>`
  }

  /**
   * 临时分享代理（/s/<id>/…，公开）：路由与协议在共享实现里，
   * 容器侧只注入「索引构建器」（带 docs-core 搜索语料）与「失效页文案」。
   */
  const handleShare = createShareProxy({
    shares,
    serveShell: res => serveShell(res, null, '/'),
    buildIndex: root => buildShareIndex(root),
    gonePage: (reason, kind) => shareGonePage(reason, kind === 'dir' ? { kind } : undefined),
  })

  /** 站点服务：壳资产 → 内容根静态文件 → 壳入口兜底（共享实现见 packages/server/src/http-kit.mjs） */
  const serveStatic = createStaticSite({ shellRoot })

  /**
   * 内容寻址路由的壳应答：工作树优先（图片 / staticDirs 的自包含 HTML），
   * 未命中回落壳入口（前端按 slug 解析路由）。
   */
  function serveShell(res, worktreeRoot, urlPath) {
    return serveStatic(res, { contentRoot: worktreeRoot ?? null, urlPath })
  }

  // ——容器端 MCP 端点（设计 6.3：Streamable HTTP 最小子集，JSON 响应模式）——
  // 数据源 = 插件服务活查询（每请求现算，无缓存）+ 包内 docs/SKILL.md 直读：
  // 插件启停 / 组件启停 / 升级即查询即变。文档取数回调在此组装，mcp.mjs 保持纯逻辑。

  /** 读插件包内 docs/SKILL.md 全文（包根缺失 / 文件不存在返回 null——说明文案由 mcp 侧统一生成） */
  function readPluginDocs(name) {
    const found = plugins.findPluginRoot(name)
    if (!found) return null
    const rel = found.manifest.docs ?? 'docs/SKILL.md'
    const file = join(found.root, rel)
    if (!file.startsWith(found.root + sep) || !existsSync(file) || !statSync(file).isFile())
      return null
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  /** 容器端 MCP 的检索范围：每仓一个默认分支工作树（与读者面同一优先级）。
   *  范围解析要读各仓远端分支（git 子进程），因此带短 TTL 缓存——
   *  MCP 请求是人工触发的，几秒延迟换取不用每次请求都为每个仓 spawn 一次 git。 */
  const MCP_SCOPE_TTL_MS = 5000
  let mcpScopeCache = { at: 0, scopes: [] }
  // gitOps 在生产里就是 git.mjs 的整个命名空间（bin/deployer.mjs 注入）；单测桩可只给
  // hasBare，故回落到直接 import 的实现
  const listRemoteBranches = gitOps.remoteBranches ?? remoteBranches

  async function refreshMcpScopes() {
    if (Date.now() - mcpScopeCache.at < MCP_SCOPE_TTL_MS) return
    const cfg = loadConfigData()
    const mounted = readMounted(dataDir).current
    const scopes = []
    for (const repo of cfg.repos) {
      const bare = join(dataDir, 'git', `${repo.slug}.git`)
      if (!gitOps.hasBare(bare)) continue
      const effective = (await listRemoteBranches(bare).catch(() => [])).filter(b =>
        branchInWhitelist(repo.branches, b),
      )
      if (!effective.length) continue
      const ready = effective.filter(b => isReleaseReady(dataDir, repo.slug, b))
      const branch =
        mounted && mounted.slug === repo.slug && effective.includes(mounted.branch)
          ? mounted.branch
          : (ready[0] ?? effective[0])
      const root = worktreeDir(dataDir, repo.slug, branchDir(branch))
      if (!existsSync(root)) continue
      // 展示名带分支：同一仓多分支时 AI 才分得清读的是哪一版；前缀供 read_doc 定仓
      scopes.push({
        workspace: `${repo.name || repo.slug}@${branch}`,
        root,
        prefix: `${repo.slug}/`,
      })
    }
    mcpScopeCache = { at: Date.now(), scopes }
  }

  /** MCP 的文档检索（单一实现见 packages/server/src/corpus.mjs） */
  const mcpCorpus = createCorpus(() => mcpScopeCache.scopes)

  /** mcp.mjs 的依赖注入（该模块不触磁盘：清单 / 文档全部经这些回调取数） */
  const mcpDeps = {
    serverVersion: version,
    serverName: 'docvi',
    listPlugins: () =>
      plugins
        .catalog()
        .plugins.filter(p => p.enabled && !p.broken)
        .map(p => ({
          name: p.name,
          displayName: p.displayName,
          version: p.version,
          builtin: p.builtin,
        })),
    listComponents: () =>
      plugins.activeKinds().active.map(item => ({
        kind: item.kind,
        title: item.title,
        description: item.description,
        plugin: item.plugin,
      })),
    componentDocs: kind => {
      const active = plugins.activeKinds().active.find(item => item.kind === kind)
      return active ? readPluginDocs(active.plugin) : null
    },
    pluginDocs: name => readPluginDocs(name),
    searchDocs: (query, limit) => mcpCorpus.search(query, limit),
    readDoc: docPath => mcpCorpus.readDoc(docPath),
  }

  return function handler(req, res) {
    let pathname = '/'
    try {
      pathname = new URL(req.url, 'http://x').pathname
    } catch {
      res.writeHead(400)
      return res.end('bad request')
    }
    if (pathname.startsWith('/api/')) {
      handleApi(req, res, pathname).catch(error => {
        json(res, 500, { error: String(error.message).slice(-300) })
      })
      return
    }

    // 临时分享代理（/s/<id>/…，公开）：独立命名空间——与 /<slug>/ 仓库路由无交集
    if (pathname === '/s' || pathname === '/s/' || pathname.startsWith('/s/')) {
      handleShare(req, res, pathname).catch(error => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String(error.message).slice(-300))
        } else {
          res.end()
        }
      })
      return
    }

    // 容器端 MCP 端点（设计 6.3）：单 POST 端点（JSON 响应模式）——
    // GET（SSE 流）未实现，非 POST 一律 405 + Allow: POST
    if (pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' })
        return res.end('method not allowed')
      }
      // 先刷新检索范围（含 TTL 缓存），再进协议分发：dispatch 是同步的，
      // 范围解析要读 git refs——必须在进同步世界之前完成
      refreshMcpScopes()
        .then(() => handleMcp(req, res, mcpDeps))
        .catch(error => {
          if (!res.headersSent) {
            json(res, 500, { error: String(error.message).slice(-300) })
          } else {
            res.end()
          }
        })
      return
    }

    // 多仓库路由与内容服务都是异步解析（分支实况要读 refs）：统一走 promise 收口
    void (async () => {
      // 旧链接兼容：/_ 门户已退场，301 到首页（仓库列表）
      if (pathname === '/_' || pathname === '/_/') {
        res.writeHead(301, { Location: '/' })
        return res.end()
      }
      if (pathname === '/_/admin' || pathname === '/_/ops') {
        // 运维页（no-cache：平台自渲染页，重建后必须立即生效——2026-10-14 实测教训）
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        return res.end(opsHtml())
      }
      // 壳的前端保留路由不落 /_ 的 404 兜底，放行到下方 serveShell（history fallback → index.html）：
      // - 组件预览页（协议 v1.1）：/_/preview/<name>/<kind>
      // - 本地预览（/__local/…）：内容在浏览器内存，刷新后由壳自行回首页
      if (
        pathname.startsWith('/_') &&
        !pathname.startsWith('/_/preview/') &&
        !pathname.startsWith('/__local')
      ) {
        res.writeHead(404)
        return res.end('not found')
      }

      // 文档原文直出（壳的 ContentSource 协议端）：/docs/<slug>/….md?branch=…
      // 旧形态 /docs/….md（首段不是仓库 slug）回退挂载仓库（向后兼容旧壳)
      if (pathname.startsWith('/docs/') && pathname.endsWith('.md')) {
        const query = new URL(req.url, 'http://x').searchParams
        const innerFull = pathname.slice('/docs'.length)
        const segments = innerFull.split('/').filter(Boolean)
        const cfg = loadConfigData()
        let slug = null
        let inner = innerFull
        if (segments.length > 1 && cfg.repos.some(r => r.slug === segments[0])) {
          slug = segments[0]
          inner = '/' + segments.slice(1).join('/')
        } else {
          const mounted = readMounted(dataDir).current
          if (mounted) {
            slug = mounted.slug
            inner = innerFull
          }
        }
        const repo = slug ? cfg.repos.find(r => r.slug === slug) : null
        if (!repo) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('暂无已挂载的文档分支')
        }
        const bare = join(dataDir, 'git', `${slug}.git`)
        const effective = gitOps.hasBare(bare)
          ? (await remoteBranches(bare).catch(() => [])).filter(b =>
              branchInWhitelist(repo.branches, b),
            )
          : []
        const requested = query.get('branch')
        const branch = requested && effective.includes(requested) ? requested : null
        const mountedNow = readMounted(dataDir).current
        const use =
          branch ??
          (mountedNow && mountedNow.slug === slug ? mountedNow.branch : (effective[0] ?? null))
        if (!use) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('分支工作树未就绪')
        }
        const root = worktreeDir(dataDir, slug, branchDir(use))
        if (!existsSync(root)) {
          res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end('分支工作树未就绪')
        }
        const target = resolveInRoot(root, inner)
        if (!target) {
          res.writeHead(403)
          return res.end('forbidden')
        }
        if (!existsSync(target) || !statSync(target).isFile()) {
          res.writeHead(404)
          return res.end('not found')
        }
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        return createReadStream(target).pipe(res)
      }

      // 插件包文件伺服（公开，协议 v1）：/plugins/<name>/<version>/<包内路径>。
      // 版本段在 URL + 包内容不可变 → immutable 缓存（与 /assets 同口径）；
      // 版本与登记不符即 404（切换/卸载后旧 URL 自然失效）
      if (pathname.startsWith('/plugins/')) {
        const segs = pathname.split('/').filter(Boolean) // ['plugins', name, version, ...path]
        if (segs.length >= 4) {
          let relPath
          try {
            relPath = segs.slice(3).map(decodeURIComponent).join('/')
          } catch {
            res.writeHead(400)
            return res.end('bad path')
          }
          const file = plugins.resolvePluginFile(
            decodeURIComponent(segs[1]),
            decodeURIComponent(segs[2]),
            relPath,
          )
          if (file) return sendFile(res, file, { immutable: true })
        }
        res.writeHead(404)
        return res.end('plugin file not found')
      }

      // 内容寻址：/<slug>/… → 壳资产优先，其后该分支工作树的静态文件，
      // 未命中兜底壳入口（前端按 slug 解析路由）。工作树缺失视同无内容根。
      const scope = await resolveContentScope(req.url)
      if (scope) {
        return serveShell(res, scope.worktreeRoot, scope.rest)
      }

      // 首页与壳资产：首页由壳渲染（仓库列表；空平台带添加引导）
      if (pathname === '/') {
        return serveShell(res, null, '/')
      }
      const legacy = readMounted(dataDir).current
      const root = legacy ? worktreeDir(dataDir, legacy.slug, branchDir(legacy.branch)) : null
      serveShell(res, root && existsSync(root) ? root : null, pathname)
    })().catch(error => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(String(error.message).slice(-300))
      } else {
        res.end()
      }
    })
  }
}
