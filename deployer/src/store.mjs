/**
 * 磁盘布局与状态存取（PRD 五、数据设计；零编译形态）：
 * /data/{config.yaml, git/<slug>.git, worktrees/<slug>/<分支目录>/,
 *        releases/<slug>/<分支目录>/{tree.json, search-index.json},
 *        builds/<任务ID>.{json,log}, creds/<slug>.txt, mounted.json, audit.log}
 * 发布 = 索引刷新：分支发布目录是普通目录，内容为两份索引 JSON
 * （单文件临时文件 + rename 原子写；旧编译布局的 snapshots symlink 会被替换）。
 * 凭证文件独立于 config.yaml（600 权限，API 不回显内容——只报有无）。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { join } from 'node:path'

export function ensureLayout(dataDir) {
  for (const dir of ['git', 'worktrees', 'releases', 'builds', 'creds', 'sync']) {
    mkdirSync(join(dataDir, dir), { recursive: true })
  }
}

export const bareDir = (dataDir, slug) => join(dataDir, 'git', `${slug}.git`)
export const worktreeDir = (dataDir, slug, branchDirName) =>
  join(dataDir, 'worktrees', slug, branchDirName)
export const releasesDir = (dataDir, slug) => join(dataDir, 'releases', slug)
/** 分支发布目录（普通目录，存放 tree.json 与 search-index.json） */
export const releaseDir = (dataDir, slug, branchDirName) =>
  join(releasesDir(dataDir, slug), branchDirName)
export const treeJsonPath = releaseDirPath => join(releaseDirPath, 'tree.json')
export const searchIndexJsonPath = releaseDirPath => join(releaseDirPath, 'search-index.json')

/** git 凭证文件（credential store 格式；每仓一个，界面填写时写入） */
export const credentialsDir = dataDir => join(dataDir, 'creds')
export const credentialFile = (dataDir, slug) => join(credentialsDir(dataDir), `${slug}.txt`)
export const hasCredential = (dataDir, slug) => existsSync(credentialFile(dataDir, slug))

// ---- mounted（两级挂载指针：仓库 × 分支）----

const MOUNTED_FILE = 'mounted.json'

export function readMounted(dataDir) {
  const file = join(dataDir, MOUNTED_FILE)
  if (!existsSync(file)) return { current: null, pending: null }
  try {
    return { current: null, pending: null, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return { current: null, pending: null }
  }
}

export function writeMounted(dataDir, mounted) {
  writeFileSync(join(dataDir, MOUNTED_FILE), JSON.stringify(mounted, null, 2))
}

// ---- 构建记录 ----

export function buildRecordPath(dataDir, id) {
  return join(dataDir, 'builds', `${id}.json`)
}

export function buildLogPath(dataDir, id) {
  return join(dataDir, 'builds', `${id}.log`)
}

/** 确保构建日志可写（append 前建目录） */
export function ensureBuildsDir(dataDir) {
  mkdirSync(join(dataDir, 'builds'), { recursive: true })
}

export function saveBuildRecord(dataDir, record) {
  mkdirSync(join(dataDir, 'builds'), { recursive: true })
  writeFileSync(buildRecordPath(dataDir, record.id), JSON.stringify(record, null, 2))
}

export function listBuilds(dataDir, { slug, branch, limit = 20 } = {}) {
  const dir = join(dataDir, 'builds')
  if (!existsSync(dir)) return []
  const records = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .filter(r => (slug ? r.repo === slug : true))
    .filter(r => (branch ? r.branch === branch : true))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  return records.slice(0, limit)
}

export function readBuildLog(dataDir, id, tailLines = 200) {
  const file = buildLogPath(dataDir, id)
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').split('\n')
  return lines.slice(Math.max(0, lines.length - tailLines)).join('\n')
}

// ---- 同步状态（读者面展示：每仓库上次 fetch 成功时间 + 每分支上次索引成功时间）----

export function syncFilePath(dataDir, slug) {
  return join(dataDir, 'sync', `${slug}.json`)
}

/** { at: ISO|null, error: {at, message}|null, branches: { <分支名>: { buildAt: ISO, commit } } } */
export function readSync(dataDir, slug) {
  const file = syncFilePath(dataDir, slug)
  if (!existsSync(file)) return { at: null, error: null, branches: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return {
      at: parsed?.at ?? null,
      error: parsed?.error ?? null,
      branches: parsed?.branches ?? {},
    }
  } catch {
    return { at: null, error: null, branches: {} }
  }
}

function writeSyncAtomic(dataDir, slug, data) {
  mkdirSync(join(dataDir, 'sync'), { recursive: true })
  const file = syncFilePath(dataDir, slug)
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

/** 主库 fetch 成功（或首次 clone 完成）时盖章；成功后清掉上一轮的失败标记 */
export function touchSync(dataDir, slug) {
  const current = readSync(dataDir, slug)
  writeSyncAtomic(dataDir, slug, { ...current, at: new Date().toISOString(), error: null })
}

/** 主库 fetch 失败时留痕（运维面可见；不覆盖上一次成功时间） */
export function touchSyncError(dataDir, slug, message) {
  const current = readSync(dataDir, slug)
  writeSyncAtomic(dataDir, slug, {
    ...current,
    error: { at: new Date().toISOString(), message: String(message).slice(-300) },
  })
}

/**
 * 把同步错误转成读者面能看的摘要。
 *
 * 原始报错是 git 的 stderr，里面含服务器上的绝对路径（凭证临时文件
 * `/data/creds/<slug>.git-credentials`、工作树路径等）。把它直接显示在读者面的
 * 仓库卡片上，既泄露部署内部结构，也对读者毫无信息量（用户实测看到的是
 * `... credential.helper=store --file=/data/creds...`）。
 *
 * 读者只需要知道「能不能看到新内容、大概什么原因」；完整报错留在运维面
 * （`/api/repos` 的 `syncError`），那里才是排查现场。
 */
export function readerFacingSyncError(message) {
  const text = String(message ?? '')
  if (!text) return '同步失败'
  if (/401|403|authenticat|authorization|credential|permission denied|access denied/i.test(text)) {
    return '远程仓库认证失败（请联系运维检查 git 凭证）'
  }
  if (
    /could not resolve|unable to access|connection (refused|reset|timed out)|timed out|network/i.test(
      text,
    )
  ) {
    return '无法连接远程仓库（网络或地址不可达）'
  }
  if (/not found|does not exist|no such|unknown revision/i.test(text)) {
    return '远程仓库或分支不存在'
  }
  return '同步失败（详情见运维面）'
}

/** 某分支索引成功时盖章（分支面板的「上次更新」依据） */
export function touchBranchBuilt(dataDir, slug, branch, commit = '') {
  const current = readSync(dataDir, slug)
  current.branches[branch] = { buildAt: new Date().toISOString(), commit }
  writeSyncAtomic(dataDir, slug, current)
}

/** 目录名列表（不存在/不可读返回空数组） */
export function listDirNames(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
}

// ---- 审计（PRD R13）----

export function audit(dataDir, entry) {
  appendFileSync(
    join(dataDir, 'audit.log'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  )
}

export function readAudit(dataDir, limit = 100) {
  const file = join(dataDir, 'audit.log')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
  return lines.slice(-limit)
}

function readlinkIfExists(p) {
  try {
    return readlinkSync(p)
  } catch {
    return null
  }
}

export const readlinkSafe = readlinkIfExists

// ---- 通用 ----

export function rmrf(path) {
  rmSync(path, { recursive: true, force: true })
}

export function dirExists(path) {
  return existsSync(path)
}
