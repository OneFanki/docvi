/**
 * 桌面端 git 支持：平台自持镜像 + 分支工作树（与旧 Rust 实现同一套模型）。
 *
 * 独立于窗口层实现：既有单测与
 * 实仓验证沉淀，重写只会引入回归。旧宿主退役时随该包一起删除，届时这里是唯一实现。
 *
 * 原则（沿用原设计）：
 * - 克隆远端 → 数据目录 `git/<名>.git`（--mirror 裸库，对象共享、零本地提交）；
 * - 浏览 = 每个分支一个 detached 工作树 `worktrees/<名>/<分支目录>/`；
 * - 拉取 = fetch + `reset --hard refs/heads/<分支>`（一切以云端为准）；
 * - **绝不触碰用户自己的目录**；本地已有目录只做只读浏览。
 *
 * 凭证继承系统 Git（GCM / SSH 密钥），平台不存任何凭证。
 */
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 构造 git 调用环境：禁交互提示（防无终端挂起），GCM 不受该变量影响 */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }

function run(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: GIT_ENV, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(friendlyError(String(stderr || error.message))))
          return
        }
        resolve(String(stdout).trim())
      },
    )
  })
}

/** git 未安装时的指引 */
function friendlySpawnError(error) {
  if (error?.code === 'ENOENT') {
    return '未检测到 git——请安装 Git for Windows（https://git-scm.com/download/win）并确保它在系统 PATH 中，然后重试。'
  }
  return `无法启动 git：${error?.message ?? error}`
}

/** 把 git stderr 翻译成可行动的提示（认不出时回退前两行） */
export function friendlyError(raw) {
  const low = String(raw).toLowerCase()
  if (low.includes('does not appear to be a git repository')) {
    return '该地址不是有效的 git 仓库——请检查地址是否完整、可访问。'
  }
  if (low.includes('could not read username') || low.includes('terminal prompts disabled')) {
    return '该仓库需要登录凭证。请先在系统 Git 中配置好访问凭证（Git Credential Manager 通常会自动弹窗登录），然后重试。'
  }
  if (low.includes('authentication failed') || low.includes('403')) {
    return '凭证被拒绝（Authentication failed）。请检查系统 Git 中该平台的账号或访问令牌。'
  }
  if (low.includes('repository not found') || low.includes('not found')) {
    return '仓库不存在，或当前账号没有访问权限。'
  }
  if (low.includes('could not resolve host') || low.includes('network is unreachable')) {
    return '无法解析仓库域名——请检查网络连接与地址拼写。'
  }
  if (low.includes("couldn't find remote ref") || low.includes('remote branch')) {
    return '远端不存在该分支，请检查分支名。'
  }
  if (
    low.includes('timed out') ||
    low.includes('connection reset') ||
    low.includes('connection refused')
  ) {
    return '网络连接失败或超时，请检查网络后重试。'
  }
  const lines = String(raw)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  if (!lines.length) return 'git 执行失败'
  return lines.slice(0, 2).join('；')
}

/** 目录名净化（跨平台非法字符；保留中文；截断 60 字符） */
export function sanitizeDirName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '-')
  let trimmed = cleaned
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if ([...trimmed].length > 60) trimmed = [...trimmed].slice(0, 60).join('')
  return trimmed || 'repo'
}

/** 分支名 → 磁盘目录名（连续特殊字符压成一个下划线，与 deployer 同口径） */
export function branchDir(branch) {
  let out = ''
  let lastSpecial = false
  for (const ch of String(branch ?? '')) {
    if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch
      lastSpecial = false
    } else if (!lastSpecial) {
      out += '_'
      lastSpecial = true
    }
  }
  return out || 'branch'
}

/**
 * git 操作集合。所有路径都在 `dataDir` 内（平台自持），不接触用户目录。
 */
export function createGitService(dataDir) {
  const mirrorsDir = join(dataDir, 'git')
  const worktreesDir = join(dataDir, 'worktrees')
  const legacyReposDir = join(dataDir, 'repos')

  const mirrorPath = repo => join(mirrorsDir, `${repo}.git`)
  const worktreePath = (repo, branch) => join(worktreesDir, repo, branchDir(branch))

  async function gitAvailable() {
    try {
      return await run(['--version'])
    } catch (error) {
      throw new Error(friendlySpawnError(error))
    }
  }

  /** 副本名分配：同 URL 复用；否则净化名 + 数字后缀 */
  async function findOrAllocRepo(name, url) {
    if (existsSync(mirrorsDir)) {
      for (const entry of readdirSync(mirrorsDir)) {
        if (!entry.endsWith('.git')) continue
        const dir = join(mirrorsDir, entry)
        try {
          const existing = await run(['-C', dir, 'remote', 'get-url', 'origin'])
          if (existing.trim() === url) return entry.slice(0, -4)
        } catch {
          // 没有 origin 的裸库：跳过
        }
      }
    }
    const stem = sanitizeDirName(name)
    let candidate = stem
    let index = 2
    while (existsSync(mirrorPath(candidate))) {
      candidate = `${stem}-${index}`
      index += 1
    }
    return candidate
  }

  async function defaultBranch(mirror) {
    try {
      const head = await run(['-C', mirror, 'symbolic-ref', 'HEAD'])
      const branch = head.replace(/^refs\/heads\//, '')
      if (branch && branch !== head) return branch
    } catch {
      // 退化：取第一个引用
    }
    const refs = await run([
      '-C',
      mirror,
      'for-each-ref',
      'refs/heads',
      '--format=%(refname:short)',
    ])
    const first = refs
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)[0]
    if (!first) throw new Error('远端仓库没有任何分支。')
    return first
  }

  async function requireBranch(mirror, branch) {
    try {
      await run(['-C', mirror, 'rev-parse', '--verify', `refs/heads/${branch}`])
    } catch {
      throw new Error(`副本里没有分支「${branch}」（可能远端已删除）——请刷新分支列表后重试。`)
    }
  }

  async function ensureWorktree(repo, branch) {
    const mirror = mirrorPath(repo)
    const target = worktreePath(repo, branch)
    if (existsSync(join(target, '.git'))) return target
    if (existsSync(target)) {
      // 平台自持路径下的残留目录：直接清理重建
      rmSync(target, { recursive: true, force: true })
    }
    try {
      await run(['-C', mirror, 'worktree', 'prune'])
    } catch {
      // 无残留时 prune 的报错可忽略
    }
    mkdirSync(join(target, '..'), { recursive: true })
    await run(['-C', mirror, 'worktree', 'add', '--detach', target, `refs/heads/${branch}`])
    return target
  }

  /** 网络操作统一关掉交互提示后调用 */
  async function withGit(args, options) {
    try {
      return await run(args, options)
    } catch (error) {
      throw new Error(friendlyError(error.message))
    }
  }

  return {
    gitAvailable,

    /**
     * 克隆（带进度回调）：镜像克隆 → 建目标分支工作树。
     * @param {{url: string, branch?: string|null, name: string, onProgress?: (p: {phase: string, message: string, percent: number|null}) => void}} input
     */
    async clone({ url, branch, name, onProgress = () => {} }) {
      const cleanUrl = String(url ?? '').trim()
      if (!cleanUrl) throw new Error('请填写 Git 仓库地址。')
      const wanted = String(branch ?? '').trim() || null
      const repo = await findOrAllocRepo(name, cleanUrl)
      const mirror = mirrorPath(repo)
      onProgress({ phase: 'start', message: '正在连接仓库…', percent: null })

      if (existsSync(mirror)) {
        onProgress({ phase: 'clone', message: '已存在平台副本，正在同步最新…', percent: null })
        await withGit(['-C', mirror, 'fetch', 'origin', '--prune'])
      } else {
        mkdirSync(mirrorsDir, { recursive: true })
        await new Promise((resolve, reject) => {
          const child = spawn('git', ['clone', '--mirror', '--progress', cleanUrl, mirror], {
            env: GIT_ENV,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          })
          const errorLines = []
          if (child.stderr) {
            const reader = createInterface({ input: child.stderr })
            reader.on('line', line => {
              const text = line.trim()
              if (!text) return
              errorLines.push(text)
              onProgress({
                phase: 'clone',
                message: phaseMessage(text),
                percent: parsePercent(text),
              })
            })
          }
          child.on('error', error => reject(new Error(friendlySpawnError(error))))
          child.on('close', code => {
            if (code === 0) return resolve()
            // 失败：清理半成品副本（目录名由本函数独占分配）
            rmSync(mirror, { recursive: true, force: true })
            reject(new Error(friendlyError(errorLines.join('\n'))))
          })
        })
      }

      const target = wanted ?? (await defaultBranch(mirror))
      if (wanted) await requireBranch(mirror, wanted)
      onProgress({ phase: 'clone', message: '正在检出浏览副本…', percent: null })
      const worktree = await ensureWorktree(repo, target)
      onProgress({ phase: 'done', message: '克隆完成', percent: 100 })
      return { repo, path: worktree, branch: target }
    },

    /** 拉取更新：fetch → reset --hard；返回新增提交数 */
    async pull({ repo, branch }) {
      const cleanBranch = String(branch ?? '').trim()
      if (!cleanBranch) throw new Error('无法确定要拉取的分支。')
      const cleanRepo = String(repo ?? '').trim()
      if (!cleanRepo) throw new Error('平台副本名缺失——请移除该工作区后重新添加。')
      const mirror = mirrorPath(cleanRepo)
      if (!existsSync(mirror)) {
        throw new Error('平台副本不存在（应用数据可能被清理）——请移除该工作区后重新添加。')
      }
      await withGit(['-C', mirror, 'fetch', 'origin', '--prune'])
      await requireBranch(mirror, cleanBranch)
      const worktree = await ensureWorktree(cleanRepo, cleanBranch)
      const head = await run(['-C', worktree, 'rev-parse', 'HEAD'])
      const countText = await run([
        '-C',
        worktree,
        'rev-list',
        '--count',
        `${head}..refs/heads/${cleanBranch}`,
      ])
      const commits = Number.parseInt(countText, 10) || 0
      if (commits > 0) {
        await run(['-C', worktree, 'reset', '--hard', `refs/heads/${cleanBranch}`])
      }
      return { branch: cleanBranch, commits, changed: commits > 0 }
    },

    /** 分支列表（先 fetch，离线时容忍） */
    async branches({ repo }) {
      const cleanRepo = String(repo ?? '').trim()
      const mirror = mirrorPath(cleanRepo)
      if (!existsSync(mirror)) {
        throw new Error('平台副本不存在（应用数据可能被清理）——请移除该工作区后重新添加。')
      }
      try {
        await run(['-C', mirror, 'fetch', 'origin', '--prune'])
      } catch {
        // 离线：用本地 refs 快照
      }
      const refs = await run([
        '-C',
        mirror,
        'for-each-ref',
        'refs/heads',
        '--format=%(refname:short)',
      ])
      const branches = [
        ...new Set(
          refs
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean),
        ),
      ]
      branches.sort()
      return { branches }
    },

    /** 切分支：确保工作树就绪 */
    async switchBranch({ repo, branch }) {
      const cleanBranch = String(branch ?? '').trim()
      if (!cleanBranch) throw new Error('请选择要切换的分支。')
      const cleanRepo = String(repo ?? '').trim()
      const mirror = mirrorPath(cleanRepo)
      if (!existsSync(mirror)) {
        throw new Error('平台副本不存在（应用数据可能被清理）——请移除该工作区后重新添加。')
      }
      try {
        await run(['-C', mirror, 'fetch', 'origin', '--prune'])
      } catch {
        // 离线容忍
      }
      await requireBranch(mirror, cleanBranch)
      const worktree = await ensureWorktree(cleanRepo, cleanBranch)
      return { path: worktree, branch: cleanBranch }
    },

    /** 旧版条目迁移：旧 repos/<名> → 自持镜像 + 工作树；其余按本地目录处理 */
    async migrateEntry({ path }) {
      const target = String(path ?? '').trim()
      const isGitDir = existsSync(join(target, '.git'))
      const localResult = localGit => ({
        kind: 'local',
        repo: null,
        url: null,
        worktreePath: null,
        branch: null,
        localGit,
      })
      if (!isGitDir || !target.startsWith(legacyReposDir)) return localResult(isGitDir)

      let url
      try {
        url = (await run(['remote', 'get-url', 'origin'], { cwd: target })).trim()
      } catch {
        return localResult(true)
      }
      if (!url) return localResult(true)

      const name = basename(target) || 'repo'
      const repo = await findOrAllocRepo(name, url)
      const mirror = mirrorPath(repo)
      if (!existsSync(mirror)) {
        await run(['clone', '--mirror', target, mirror])
        await run(['-C', mirror, 'remote', 'set-url', 'origin', url])
      }
      let branch = ''
      try {
        branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target })
      } catch {
        branch = ''
      }
      if (!branch || branch === 'HEAD') branch = await defaultBranch(mirror)
      try {
        await requireBranch(mirror, branch)
      } catch {
        branch = await defaultBranch(mirror)
      }
      const worktree = await ensureWorktree(repo, branch)
      // 旧目录仅在无未提交改动时删除（防误删用户改动）
      let dirty = true
      try {
        dirty = (await run(['status', '--porcelain'], { cwd: target })).length > 0
      } catch {
        dirty = true
      }
      if (!dirty) rmSync(target, { recursive: true, force: true })
      return {
        kind: 'managed',
        repo,
        url,
        worktreePath: worktree,
        branch,
        localGit: true,
      }
    },

    /** 检测本地目录最外层是否 git 仓库（只读徽标用） */
    async repoInfo({ path }) {
      const target = String(path ?? '').trim()
      if (!existsSync(join(target, '.git'))) {
        return { isRepo: false, remoteUrl: null, branch: null }
      }
      let remoteUrl = null
      let branch = null
      try {
        const value = (await run(['remote', 'get-url', 'origin'], { cwd: target })).trim()
        remoteUrl = value || null
      } catch {
        remoteUrl = null
      }
      try {
        const value = (await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target })).trim()
        branch = value && value !== 'HEAD' ? value : null
      } catch {
        branch = null
      }
      return { isRepo: true, remoteUrl, branch }
    },
  }
}

/** 从进度行提取百分比 */
export function parsePercent(line) {
  const match = /(\d{1,3})%/.exec(String(line))
  if (!match) return null
  const value = Number(match[1])
  return value <= 100 ? value : null
}

/** 进度行 → 中文阶段（认不出回退原文，超 90 字符截断） */
export function phaseMessage(line) {
  const text = String(line)
  if (text.startsWith('Cloning into')) return '初始化平台副本…'
  const prefix = text.split(':')[0].trim()
  const map = {
    'Enumerating objects': '枚举对象…',
    'Counting objects': '计数对象…',
    'Compressing objects': '压缩对象…',
    'Receiving objects': '接收数据…',
    'Resolving deltas': '解算差异…',
    'Updating files': '检出文件…',
    'Checking out files': '检出文件…',
  }
  if (prefix === 'remote') {
    const inner = text.split(':').slice(1).join(':').split(':')[0].trim()
    const remoteMap = {
      'Enumerating objects': '枚举对象（远端）…',
      'Counting objects': '计数对象（远端）…',
      'Compressing objects': '压缩对象（远端）…',
    }
    return remoteMap[inner] ?? (text.length > 90 ? text.slice(0, 90) : text)
  }
  return map[prefix] ?? (text.length > 90 ? text.slice(0, 90) : text)
}
