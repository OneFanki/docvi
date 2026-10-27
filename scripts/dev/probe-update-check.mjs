#!/usr/bin/env node
/**
 * 一次性探针：验证更新检查真的能从 GitHub 拿到「本机平台对应的资产」。
 *
 * 这一步是自动更新的前置条件，也是最容易静默失败的一环：
 *  - 清单可读但 Release API 不可达 → 检查显示有新版本，却没有下载按钮；
 *  - 资产匹配错架构 → 用户装完打不开；
 *  - 网络需要代理 → 这里用的必须是 `net.fetch`（Chromium 栈），不能用 Node fetch。
 *
 * 断言：能返回 outdated（或 latest），且 outdated 时 asset 非空、URL 是可信域、
 * 带 64 位 SHA-256。
 *
 * 用法：node scripts/dev/probe-update-check.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `probe${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-probe-data-${TAG}-`))

let child = null
const log = (...args) => console.log('[probe]', ...args)

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    call(message)
  })
  return new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
  }).then(() => ({
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, message => done(message.result))
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本报错')
      }
      return result?.result?.value
    },
    close() {
      socket.close()
    },
  }))
}

function cleanup() {
  if (child) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    child = null
  }
  try {
    rmSync(DATA, { recursive: true, force: true, maxRetries: 5 })
  } catch {
    // 收尾失败不影响结论
  }
}

async function main() {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-probe-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
    },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })

  let target = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
    } catch {
      // 端口还没开
    }
  }
  if (!target) throw new Error('应用窗口没有出现（CDP 不可达）')

  const client = await connect(target.webSocketDebuggerUrl)
  await sleep(3000)

  const info = await client.evaluate('window.docvi.appRuntimeInfo().then(r => r)')
  log(
    '运行时：',
    JSON.stringify({
      version: info?.data?.version,
      platform: info?.data?.platform,
      arch: info?.data?.arch,
      homepage: info?.data?.homepage,
    }),
  )
  if (!info?.data?.homepage?.includes('github.com')) {
    throw new Error(`关于信息应带 GitHub 主页，实际 ${info?.data?.homepage}`)
  }

  const result = await client.evaluate('window.docvi.appUpdateCheck().then(r => r)')
  log('检查更新：', JSON.stringify(result))
  if (!result?.ok) throw new Error(`检查失败：${JSON.stringify(result?.error)}`)
  const update = result.data
  if (update.status === 'unavailable') {
    throw new Error(`检查不可用（网络或清单问题）：${update.message}`)
  }
  if (update.notes === undefined) {
    log('提示：清单没有 notes（应用内更新提示会为空）')
  }

  if (update.status === 'latest') {
    log('已是最新版本，无法验证资产匹配——请先有一版未安装的新版本再跑这条探针')
    client.close()
    return
  }

  // outdated：资产必须齐全且可信
  const asset = update.asset
  log('资产：', JSON.stringify(asset))
  if (!asset) throw new Error('有新版但没有匹配到本机平台的可下载资产')
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(asset.url)) {
    throw new Error(`资产地址不在可信域：${asset.url}`)
  }
  if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? '')) {
    throw new Error(`资产缺少 64 位 SHA-256：${asset.sha256}`)
  }
  if (!asset.size || asset.size <= 0) throw new Error('资产缺少字节数（进度条会退化成不确定态）')

  log(
    `通过：${update.current} → ${update.latest}，资产 ${asset.name}（${(asset.size / 1024 / 1024).toFixed(1)} MB）`,
  )
  client.close()
}

main()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch(error => {
    console.error('[probe] 失败：', error.message)
    cleanup()
    process.exit(1)
  })
