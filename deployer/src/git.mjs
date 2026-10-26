/**
 * git 编排（PRD R4/R5）：每仓一个 bare 主库（--mirror，对象共享），白名单分支各一个
 * **detached 工作树**（检出 refs/heads/<分支> 引用）。服务器对仓库只读不写、零本地
 * 提交——「更新」= fetch + reset --hard，冲突在结构上不存在，强推后更新即对齐云端。
 *
 * 凭证（私有仓库）：每仓一个 credential store 文件（creds/<slug>.txt，600 权限，由
 * 运维界面填写）；clone/fetch 时经 `-c credential.helper=` 注入——先空值重置 helper
 * 列表（隔离全局 GIT_CREDENTIALS 的 store），再挂本仓文件。凭证不进 config.yaml、
 * 不进 URL、不落 git config、任何 API 不回显。
 */
import { execFile } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

async function git(args, opts = {}) {
  try {
    const { stdout } = await pExecFile('git', args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 120_000,
      cwd: opts.cwd,
      env: {
        ...process.env,
        // 无凭证的私有仓必须「立即失败」而非挂起等交互提示（实测矩阵，2026-10-13）：
        // - GIT_TERMINAL_PROMPT=0 只拦终端提示；
        // - GIT_ASKPASS/SSH_ASKPASS 置空才拦住 Git for Windows 的默认 askpass 弹窗
        //   （git-askpass.exe 在无桌面会话下挂满超时）；
        // - 系统级 Git Credential Manager 另由 credentialArgs 的 helper 重置隔离。
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
      },
    })
    return stdout.trim()
  } catch (error) {
    const detail = String(error.stderr || error.message).slice(-400)
    // 认证失败给出行动指引（面板/管理页可直配凭证，无需碰环境变量）
    const authHint =
      /Authentication failed|could not read Username|terminal prompts disabled|401/i.test(detail)
        ? '\n（远端要求认证：请在管理页或运维面板为该仓库配置 git 凭证）'
        : ''
    const err = new Error(`git ${args.join(' ')} 失败：${detail}${authHint}`)
    err.cause = error
    throw err
  }
}

/* ---------- 凭证（界面填写 → credential store 文件） ---------- */

/**
 * 写出一个凭证文件（credential store 格式，一行）：`<proto>://<user>:<pass>@<host>`。
 * store 格式要求 user:pass 双段（单段会被 git 直接跳过）；故只填 Token（密码位）
 * 时以 `oauth2` 作占位用户名——GitLab 文档口径、GitHub 的 PAT 认证同样不校验用户名；
 * 只填用户名则拒绝（无法形成有效凭证）。特殊字符按 URL 编码。
 * 仅支持 http(s) 远端（ssh 用部署机密钥）。
 */
export function writeCredentialFile(credFile, repoUrl, { username = '', password = '' } = {}) {
  const user = String(username).trim()
  const pass = String(password)
  if (!user && !pass) throw new Error('用户名与密码 / Token 至少填写一项')
  if (!pass) throw new Error('只填了用户名：请同时提供密码 / Token（HTTP 认证需要两部分）')
  // 先按前缀判协议再解析：scp 形态（git@host:path）new URL 解析不了，
  // 但两者的正确提示都是「仅支持 http(s)」
  if (!/^https?:\/\//i.test(repoUrl)) {
    throw new Error('凭证仅适用于 http(s) 远端（ssh 形式请使用服务器上的部署密钥）')
  }
  const parsed = new URL(repoUrl)
  const auth = `${encodeURIComponent(user || 'oauth2')}:${encodeURIComponent(pass)}`
  mkdirSync(dirname(credFile), { recursive: true, mode: 0o700 })
  writeFileSync(credFile, `${parsed.protocol}//${auth}@${parsed.host}\n`, { mode: 0o600 })
  try {
    chmodSync(credFile, 0o600)
  } catch {
    // Windows 上 chmod 语义有限：尽力而为
  }
}

export function removeCredentialFile(credFile) {
  rmSync(credFile, { force: true })
}

/** 凭证注入参数：先空值重置 helper 列表（隔离系统级 Git Credential Manager——
 *  它不受 GIT_TERMINAL_PROMPT 管辖，无凭证时会挂起等 GUI 交互），再挂本仓文件。
 *  Windows 路径必须转正斜杠：git 经 sh 执行 helper，反斜杠会被当转义符吞掉
 *  （实测 helper 找不到文件后转交互提示而挂起）。
 *  无凭证文件也返回隔离参数：公开仓库无影响；私有仓库立即失败而非挂起等提示。 */
export function credentialArgs(credFile) {
  const reset = ['-c', 'credential.helper=']
  if (!credFile || !existsSync(credFile)) return reset
  return [...reset, '-c', `credential.helper=store --file=${credFile.replaceAll('\\', '/')}`]
}

/** 分支名 → 磁盘目录名（分支可含 /，目录名不允许） */
export function branchDir(branch) {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '__')
}

/**
 * 主库可用性：HEAD 与 refs 都存在才算完整。clone --mirror 被中断会在磁盘留下
 * 只有 HEAD、没有 refs 的残缺目录——只看 HEAD 会在启动恢复时误判为可用，
 * 后续 worktree add 报「invalid reference」且无法自愈（实测）。
 */
export const hasBare = dir => existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'refs'))

export const cloneMirror = (url, dir, { credFile } = {}) =>
  git([...credentialArgs(credFile), 'clone', '--mirror', url, dir], { timeout: 600_000 })

/**
 * fetch 主库。传入 url 时先对齐 remote origin——配置里改了远端地址立即生效
 * （仅靠 clone 时的 origin，换 url 后 fetch 永远打旧地址：实测缺口）。
 * set-url 失败（如 origin 不存在）静默跳过，后续 fetch 会给出明确错误。
 */
export async function fetchBare(dir, { credFile, url } = {}) {
  if (url) {
    try {
      await git(['-C', dir, 'remote', 'set-url', 'origin', url])
    } catch {
      try {
        await git(['-C', dir, 'remote', 'add', 'origin', url])
      } catch {
        // 极端残缺库：交给 fetch 报错
      }
    }
  }
  return git([...credentialArgs(credFile), '-C', dir, 'fetch', 'origin', '--prune'], {
    timeout: 300_000,
  })
}

export async function remoteBranches(bareDir) {
  const out = await git(['-C', bareDir, 'for-each-ref', 'refs/heads', '--format=%(refname:short)'])
  return out ? out.split('\n').filter(Boolean) : []
}

export const branchSha = (bareDir, branch) =>
  git(['-C', bareDir, 'rev-parse', `refs/heads/${branch}`])

/** 分支领先 fromSha 多少个提交（落后计数） */
export const behindCount = (bareDir, branch, fromSha) =>
  git(['-C', bareDir, 'rev-list', '--count', `${fromSha}..refs/heads/${branch}`]).then(Number)

export const headSha = wtDir => git(['-C', wtDir, 'rev-parse', 'HEAD'])

/**
 * 工作树完整性：.git 文件里的 gitdir 指针必须指向存在的位置。
 * 数据卷目录被整体迁移（换机器/换挂载路径）后，指针还是旧绝对路径——
 * 直接操作会报「fatal: not a git repository: (NULL)」且无法自愈（实测）。
 * 无法解析 / 非文件形态一律宽容放行（交给后续 git 命令报真实错误）。
 */
function worktreeHealthy(wtDir) {
  const gitFile = join(wtDir, '.git')
  if (!existsSync(gitFile)) return false
  try {
    if (!statSync(gitFile).isFile()) return true
    const match = readFileSync(gitFile, 'utf8').match(/gitdir:\s*(.+)/)
    if (!match) return true
    return existsSync(resolve(dirname(gitFile), match[1].trim()))
  } catch {
    return false
  }
}

/** 建 detached 工作树；已存在且指针完好视为就绪（幂等）。
 *  指针损坏（数据卷迁移残留）时先清理再重建——平台自持目录，清理安全。 */
export async function ensureWorktree(bareDir, wtDir, branch) {
  if (existsSync(join(wtDir, '.git'))) {
    if (worktreeHealthy(wtDir)) return
    await removeWorktree(bareDir, wtDir)
    rmSync(wtDir, { recursive: true, force: true })
  }
  await git(['-C', bareDir, 'worktree', 'prune'])
  await git(['-C', bareDir, 'worktree', 'add', '--detach', wtDir, `refs/heads/${branch}`], {
    timeout: 300_000,
  })
}

/**
 * 更新工作树到分支最新（PRD R5）。detached HEAD 下的 reset --hard 只移动该工作树，
 * 不碰主库分支引用；工作树脏（理论不该发生）同样被强制对齐云端。
 */
export const resetWorktree = (wtDir, branch) =>
  git(['-C', wtDir, 'reset', '--hard', `refs/heads/${branch}`])

/**
 * 恢复粘贴配置写入的 docs.config.yaml：有覆盖时由 builder 先写覆盖文件；这里负责
 * 「无覆盖」时还原——文件在 HEAD 中就 checkout 回来，不在 HEAD（仓库本无此文件、
 * 上一轮被覆盖写入过）就直接删除，避免上一次的覆盖残留污染本次构建（PRD R9）。
 */
export async function restoreContentConfig(wtDir, fileName = 'docs.config.yaml') {
  const abs = join(wtDir, fileName)
  try {
    await git(['-C', wtDir, 'checkout', 'HEAD', '--', fileName])
  } catch {
    // 不在 HEAD：仓库本没有这个文件，删掉可能残留的覆盖副本
    if (existsSync(abs)) unlinkSync(abs)
  }
}

export async function removeWorktree(bareDir, wtDir) {
  await git(['-C', bareDir, 'worktree', 'remove', '--force', wtDir]).catch(() => {
    // 目录已被手工删除等场景：prune 收尾即可
  })
  await git(['-C', bareDir, 'worktree', 'prune'])
}

/**
 * 调和：删除「该仓库下不在白名单内」的工作树（PRD R10）。遍历主库 worktree 列表，
 * 只处理 worktrees/<slug>/ 下的项；白名单内的分支即使远端暂时删除也保留。
 */
export async function pruneForeignWorktrees(bareDir, slug, wantedDirNames) {
  const out = await git(['-C', bareDir, 'worktree', 'list', '--porcelain'])
  const paths = out
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
  for (const wt of paths) {
    const parts = wt.split(/[\\/]/)
    if (parts[parts.length - 2] !== slug) continue // 主库自身的 bare 行跳过
    const dirName = parts[parts.length - 1]
    if (!wantedDirNames.has(dirName)) await removeWorktree(bareDir, wt)
  }
}
