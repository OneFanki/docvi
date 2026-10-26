/**
 * git 协议集成测试（PRD R4/R5/R9/R10）：全部用本机临时目录里的真实 git 仓演练，
 * 不碰网络。覆盖：mirror 克隆、detached 工作树、fetch+reset 对齐强推、
 * 粘贴配置还原、白名单外工作树清理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  behindCount,
  branchSha,
  branchDir,
  cloneMirror,
  ensureWorktree,
  fetchBare,
  headSha,
  pruneForeignWorktrees,
  removeWorktree,
  resetWorktree,
  restoreContentConfig,
} from '../src/git.mjs'

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=test@test', '-c', 'user.name=test', ...args], { cwd })
}

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'deployer-git-'))
}

test('git 协议全流程：克隆 → 工作树 → fetch/reset 对齐 → 覆盖还原 → 白名单清理', async () => {
  const root = makeTemp()
  const src = join(root, 'src')
  const dataDir = join(root, 'data')

  // 源仓：main + 1.3.0 两个分支
  mkdirSync(src, { recursive: true })
  git(src, 'init', '-b', 'main')
  writeFileSync(join(src, 'hello.md'), '# v1\n')
  git(src, 'add', '.')
  git(src, 'commit', '-m', 'v1')
  git(src, 'branch', '1.3.0')

  const bare = join(dataDir, 'git', 'docs.git')
  mkdirSync(bare, { recursive: true })
  await cloneMirror(src, bare)

  // detached 工作树：HEAD 与分支引用一致
  const wtMain = join(dataDir, 'worktrees', 'docs', branchDir('main'))
  await ensureWorktree(bare, wtMain, 'main')
  assert.equal(await headSha(wtMain), await branchSha(bare, 'main'))

  // 幂等：已存在不重建
  await ensureWorktree(bare, wtMain, 'main')

  // 源仓新提交 + 强推改写历史 → fetch + reset 后与云端一致（PRD R5）
  writeFileSync(join(src, 'hello.md'), '# v2\n')
  git(src, 'add', '.')
  git(src, 'commit', '-m', 'v2', '--amend') // 强推形态：改写历史
  await fetchBare(bare)
  const oldSha = await headSha(wtMain)
  const remoteSha = await branchSha(bare, 'main')
  assert.notEqual(oldSha, remoteSha, '强推后本地应落后于（偏离）云端')
  assert.equal((await behindCount(bare, 'main', oldSha)) >= 1, true)

  await resetWorktree(wtMain, 'main')
  assert.equal(await headSha(wtMain), remoteSha, 'reset --hard 后与云端对齐')

  // 粘贴配置还原：仓库本无 docs.config.yaml → 覆盖写入后还原即删除
  writeFileSync(join(wtMain, 'docs.config.yaml'), 'title: 覆盖\n')
  await restoreContentConfig(wtMain)
  assert.ok(!existsSync(join(wtMain, 'docs.config.yaml')), '非 HEAD 文件的覆盖副本应被删除')

  // 粘贴配置还原：仓库有 docs.config.yaml → 恢复为 HEAD 版本
  writeFileSync(join(src, 'docs.config.yaml'), 'title: 仓库自带\n')
  git(src, 'add', '.')
  git(src, 'commit', '-m', 'cfg')
  await fetchBare(bare)
  await resetWorktree(wtMain, 'main')
  writeFileSync(join(wtMain, 'docs.config.yaml'), 'title: 平台粘贴\n')
  await restoreContentConfig(wtMain)
  assert.equal(readFileSync(join(wtMain, 'docs.config.yaml'), 'utf8'), 'title: 仓库自带\n')

  // 白名单清理：1.3.0 工作树建好后，prune 只留白名单内的 main
  const wt130 = join(dataDir, 'worktrees', 'docs', branchDir('1.3.0'))
  await ensureWorktree(bare, wt130, '1.3.0')
  assert.ok(existsSync(join(wt130, '.git')))
  await pruneForeignWorktrees(bare, 'docs', new Set([branchDir('main')]))
  assert.ok(!existsSync(join(wt130, '.git')), '白名单外工作树应被移除')
  assert.ok(existsSync(join(wtMain, '.git')), '白名单内工作树保留')

  // removeWorktree 幂等收尾
  await removeWorktree(bare, wtMain)
  await removeWorktree(bare, wtMain)

  rmSync(root, { recursive: true, force: true })
})
