/**
 * `apps/desktop/src/main/git.mjs` 的类型声明（主进程 TypeScript 侧消费）。
 */
export interface GitProgress {
  phase: string
  message: string
  percent: number | null
}

export interface GitCloneInput {
  url: string
  branch?: string | null
  /** 副本名（取用户填的名称，净化后作为目录名） */
  name: string
  onProgress?: (progress: GitProgress) => void
}

export interface GitCloneResult {
  /** 平台自持副本名（数据目录 git/<repo>.git） */
  repo: string
  /** 分支工作树绝对路径 */
  path: string
  branch: string
}

export interface GitBranchesInput {
  repo: string
}

export interface GitSwitchInput {
  repo: string
  branch: string
}

export interface GitPullInput {
  repo: string
  branch: string
}

export interface GitRepoInfo {
  isRepo: boolean
  remoteUrl: string | null
  branch: string | null
}

export interface GitMigrationResult {
  kind: 'local' | 'managed'
  repo: string | null
  url: string | null
  worktreePath: string | null
  branch: string | null
  /** 该目录本身是不是 git 仓库（只读徽标用） */
  localGit: boolean
}

export interface GitService {
  /** `git --version`；未安装时抛出带指引的错误 */
  gitAvailable(): Promise<string>
  clone(input: GitCloneInput): Promise<GitCloneResult>
  pull(input: GitPullInput): Promise<{ branch: string; commits: number; changed: boolean }>
  branches(input: GitBranchesInput): Promise<{ branches: string[] }>
  switchBranch(input: GitSwitchInput): Promise<{ path: string; branch: string }>
  /** 旧版平台副本目录迁移（repos/<名> → git/<名>.git + 工作树） */
  migrateEntry(input: { path: string }): Promise<GitMigrationResult>
  /** 本地目录的 git 徽标信息（只读） */
  repoInfo(input: { path: string }): Promise<GitRepoInfo>
}

export declare function createGitService(dataDir: string): GitService

/** 目录名净化（分支名 / 副本名共用） */
export declare function sanitizeDirName(name: string): string
export declare function branchDir(branch: string): string
/** git stderr → 可行动的中文提示 */
export declare function friendlyError(raw: string): string
export declare function parsePercent(line: string): number | null
export declare function phaseMessage(line: string): string
