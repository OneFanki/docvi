/**
 * 容器端 MCP 端到端冒烟：真实 git 仓 → provision（clone + 工作树 + 索引）→ /mcp 检索与读取。
 *
 * 手动运行（不进门禁）：node scripts/smoke-deployer-mcp.mjs
 * 唯一临时数据卷 + 唯一端口，finally 里无条件清理；绝不触碰用户数据目录。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 300 } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await fn().catch(() => null)
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await new Promise(done => setTimeout(done, intervalMs))
  }
}

const temp = mkdtempSync(join(tmpdir(), 'docs-mcp-smoke-'))
const repoDir = join(temp, 'repo-src')
const dataDir = join(temp, 'data')
const port = await freePort()
let deployer = null

try {
  // 1) 造一个真实 git 仓（main 分支，两篇文档）
  mkdirSync(join(repoDir, 'guides'), { recursive: true })
  writeFileSync(
    join(repoDir, 'guides', 'deploy.md'),
    '# 部署指南\n\n容器部署用 docker run 起服务，数据卷挂 /data。\n',
    'utf8',
  )
  writeFileSync(join(repoDir, 'README.md'), '# 工程手册\n\n总目录。\n', 'utf8')
  const git = (...args) =>
    execFileSync('git', args, { cwd: repoDir, stdio: 'pipe', encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.email', 'smoke@example.com')
  git('config', 'user.name', 'smoke')
  git('add', '.')
  git('commit', '-m', 'docs: 初始化')
  const remoteDir = join(temp, 'origin.git')
  execFileSync('git', ['clone', '--bare', repoDir, remoteDir], { stdio: 'pipe' })

  // 2) 配一个仓库并把 autoFetch 关掉（冒烟只跑一次 provision）
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'config.yaml'),
    [
      'global:',
      '  autoFetch: off',
      '  autoBuild: true',
      'repos:',
      '  - slug: handbook',
      '    name: 工程手册',
      `    url: file://${remoteDir.replaceAll('\\', '/')}`,
      '    branches:',
      '      - main',
    ].join('\n'),
    'utf8',
  )

  // 3) 起 deployer（真进程）
  deployer = spawn(process.execPath, [join(ROOT, 'deployer/bin/deployer.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DEPLOYER_DATA_DIR: dataDir,
      DEPLOYER_PLATFORM_DIR: ROOT,
      DEPLOYER_PORT: String(port),
      OPS_TOKEN: '',
    },
    stdio: 'pipe',
  })
  deployer.stdout.on('data', () => {})
  deployer.stderr.on('data', () => {})

  const origin = `http://127.0.0.1:${port}`
  const rpc = async message => {
    const res = await fetch(`${origin}/mcp`, { method: 'POST', body: JSON.stringify(message) })
    return res.json()
  }

  // 4) 等 provision 完成：initialize 能应答即服务已起；再轮询 search_docs 直到命中
  await waitFor(async () => (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })).result)

  const hit = await waitFor(async () => {
    const out = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_docs', arguments: { query: 'docker run' } },
    })
    const text = out.result?.content?.[0]?.text ?? ''
    return text.includes('handbook/guides/deploy.md') ? text : null
  })

  const read = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'read_doc', arguments: { path: 'handbook/guides/deploy.md' } },
  })
  const readText = read.result.content[0].text
  if (!readText.includes('数据卷挂 /data')) throw new Error('read_doc 未读到全文')

  const tools = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
  const names = tools.result.tools.map(tool => tool.name)
  if (names.length !== 6) throw new Error(`工具数应为 6，实际 ${names.join(',')}`)

  console.log('[smoke] search_docs：')
  console.log(
    hit
      .split('\n')
      .map(line => `  ${line}`)
      .join('\n'),
  )
  console.log('[smoke] read_doc 首行：', readText.split('\n')[0])
  console.log('[smoke] 工具面：', names.join(', '))
  console.log('[smoke] 通过')
} finally {
  if (deployer) {
    deployer.kill()
    await new Promise(done => deployer.once('exit', done))
  }
  rmSync(temp, { recursive: true, force: true })
}
