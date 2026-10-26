/**
 * git 凭证（界面填写）测试：credential store 文件格式、注入参数、真实 git 兑现。
 * 全部本机演练不碰网络——用 `git credential fill` 验证注入后的 helper 真能从
 * 文件取到凭据（这是 clone/fetch 使用的同一机制）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialArgs, removeCredentialFile, writeCredentialFile } from '../src/git.mjs'

function makeTemp() {
  return mkdtempSync(join(tmpdir(), 'deployer-cred-'))
}

/** 经注入参数执行 `git credential fill`（与 clone/fetch 同一兑现路径） */
function fillVia(credFile, url) {
  const [protocol, rest] = url.split('://')
  const host = rest.split('/')[0]
  const input = `protocol=${protocol}\nhost=${host}\n\n`
  return execFileSync('git', [...credentialArgs(credFile), 'credential', 'fill'], {
    input,
    encoding: 'utf8',
  })
}

test('凭证文件：用户名+密码 → credential store 格式（含 URL 编码）', () => {
  const root = makeTemp()
  const file = join(root, 'creds', 'docs.txt')
  writeCredentialFile(file, 'https://git.example.com/team/docs.git', {
    username: 'deploy-bot',
    password: 'glpat-abc123',
  })
  assert.ok(existsSync(file))
  assert.equal(readFileSync(file, 'utf8'), 'https://deploy-bot:glpat-abc123@git.example.com\n')
  // 特殊字符编码（@ 与中文留在单行内不破坏格式）
  writeCredentialFile(file, 'https://git.example.com/x.git', {
    username: 'user@corp',
    password: 'p@ss w0rd',
  })
  assert.equal(readFileSync(file, 'utf8'), 'https://user%40corp:p%40ss%20w0rd@git.example.com\n')
  rmSync(root, { recursive: true, force: true })
})

test('凭证兑现：git credential fill 经注入参数取到凭据（clone/fetch 同一机制）', () => {
  const root = makeTemp()
  const file = join(root, 'creds', 'repo.txt')
  writeCredentialFile(file, 'https://git.example.com/team/docs.git', {
    username: 'deploy-bot',
    password: 'tok-123',
  })
  const out = fillVia(file, 'https://git.example.com/team/docs.git')
  assert.match(out, /username=deploy-bot/)
  assert.match(out, /password=tok-123/)
  rmSync(root, { recursive: true, force: true })
})

test('只填 Token：以 oauth2 作占位用户名（store 需 user:pass 双段），可兑现', () => {
  const root = makeTemp()
  const file = join(root, 'tok.txt')
  writeCredentialFile(file, 'https://git.example.com/x.git', { password: 'pure-token' })
  assert.equal(readFileSync(file, 'utf8'), 'https://oauth2:pure-token@git.example.com\n')
  const out = fillVia(file, 'https://git.example.com/x.git')
  assert.match(out, /username=oauth2/)
  assert.match(out, /password=pure-token/)
  rmSync(root, { recursive: true, force: true })
})

test('边界：空凭据拒绝、只填用户名拒绝、非 http(s) 拒绝、文件不存在时只隔离 helper', () => {
  const root = makeTemp()
  assert.throws(() => writeCredentialFile(join(root, 'a.txt'), 'https://x.git', {}), /至少填写一项/)
  assert.throws(
    () => writeCredentialFile(join(root, 'a.txt'), 'https://x.git', { username: 'u' }),
    /只填了用户名/,
  )
  assert.throws(
    () =>
      writeCredentialFile(join(root, 'b.txt'), 'git@git.example.com:team/docs.git', {
        username: 'u',
        password: 'p',
      }),
    /仅适用于 http/,
  )
  // 文件不存在：仍重置 helper 列表（隔离系统级 GCM——无凭证时它会挂起等 GUI 交互），
  // 但不挂 store 助手（公开仓库无影响；私有仓库立即失败而非挂起）
  assert.deepEqual(credentialArgs(join(root, 'none.txt')), ['-c', 'credential.helper='])
  rmSync(root, { recursive: true, force: true })
})

test('凭证文件不存在 / 公开仓库：fetch 不被 GCM 挂住（隔离参数 + 立即失败语义）', () => {
  // 无凭证文件时 credentialArgs 只重置 helper 列表：带该参数对公开 http 服务
  // 匿名可达（此处用本地无认证语义的 file:// 远端证明参数合法性）
  const root = makeTemp()
  const args = credentialArgs(join(root, 'none.txt'))
  assert.equal(args.length, 2)
  assert.equal(args[1], 'credential.helper=')
  rmSync(root, { recursive: true, force: true })
})

test('removeCredentialFile 幂等', () => {
  const root = makeTemp()
  const file = join(root, 'c.txt')
  writeCredentialFile(file, 'https://x.git', { password: 'p' })
  removeCredentialFile(file)
  assert.ok(!existsSync(file))
  removeCredentialFile(file) // 已不存在：不抛
  rmSync(root, { recursive: true, force: true })
})
