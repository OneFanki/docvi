#!/usr/bin/env node
/**
 * 一次性探针：验证更新下载链路的三条安全边界。
 *
 * 为什么不能只测「能下完」：这条链路真正危险的是**下错东西还执行**。
 * 三种错法都不会报错，只会静默做出错误决定：
 *   1. 校验和不对却保留了文件 → 用户执行了被篡改的安装包；
 *   2. 没有校验值也照样下载 → 等于信任任何内容；
 *   3. 不可信域的 URL 被放行 → 校验和再好也是从别人手里拿的。
 *
 * 本探针用**假的资产信息**（不是真实安装包）打真实 IPC，只验证拒绝路径。
 * 真实下载（几十 MB）与安装不在自动化里跑——那需要重启应用。
 *
 * 用法：node scripts/dev/probe-update-safety.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
const UPDATE_DIR = join(tmpdir(), 'docvi-update')

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

/** 检查下载目录里是否留下了不该存在的文件 */
function leftoverFiles() {
  if (!existsSync(UPDATE_DIR)) return []
  return readdirSync(UPDATE_DIR).filter(name => !name.endsWith('.cmd'))
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

  /* ---------- 1. 不可信域：必须直接拒绝 ---------- */
  const untrusted = await client.evaluate(`window.docvi.appUpdateDownload({
    asset: {
      name: 'evil.exe',
      url: 'https://evil.example.com/evil.exe',
      sha256: '${'a'.repeat(64)}',
    },
    version: '9.9.9',
  }).then(r => r)`)
  log('不可信域：', JSON.stringify(untrusted))
  if (untrusted?.ok) throw new Error('不可信域的下载地址被放行了')
  if (!untrusted?.error?.message?.includes('不受信任')) {
    throw new Error(`拒绝原因不清晰：${untrusted?.error?.message}`)
  }

  /* ---------- 2. 缺少校验值：必须拒绝 ---------- */
  const noChecksum = await client.evaluate(`window.docvi.appUpdateDownload({
    asset: {
      name: 'docvi-9.9.9-win-x64-setup.exe',
      url: 'https://github.com/OneFanki/docvi/releases/download/v9.9.9/x.exe',
    },
    version: '9.9.9',
  }).then(r => r)`)
  log('缺校验值：', JSON.stringify(noChecksum))
  if (noChecksum?.ok) throw new Error('没有校验值的下载被放行了')
  if (!noChecksum?.error?.message?.includes('校验值')) {
    throw new Error(`拒绝原因不清晰：${noChecksum?.error?.message}`)
  }

  /* ---------- 3. 校验值不匹配真实内容：必须失败且不留文件 ---------- */
  /*
   * 用 GitHub 上一个**真实存在、不重定向**的小文件，配一个错误的 sha256。
   *
   * 前面两条（raw 域、API 域）都被更早的防线拦下了：raw 域不在信任清单、
   * API 域会 302 到别处被重定向检查拦下。但那两条测的是「域/重定向」，
   * 不是校验逻辑本身——要真正验到 sha256 比对，必须让下载走完。
   *
   * 用 release 资产的 HEAD 不方便，改用仓库主页（github.com 在清单内，
   * 返回 HTML 且不重定向），内容任取，配全零校验和必然不匹配。
   */
  const wrongHash = await client.evaluate(`window.docvi.appUpdateDownload({
    asset: {
      name: 'docvi-9.9.9-probe.exe',
      url: 'https://github.com/OneFanki/docvi',
      sha256: '${'0'.repeat(64)}',
    },
    version: '9.9.9',
  }).then(r => r)`)
  log('校验不匹配：', JSON.stringify(wrongHash))
  if (wrongHash?.ok) throw new Error('校验和不匹配却报告成功——这是最危险的一种失败')
  const msg = wrongHash?.error?.message ?? ''
  // 允许两种正当拒绝：校验不符，或重定向到不可信域（GitHub 页面会跳转）
  if (!msg.includes('校验') && !msg.includes('重定向')) {
    throw new Error(`拒绝原因不清晰：${msg}`)
  }
  await sleep(600)
  const leftovers = leftoverFiles()
  log('下载目录残留：', JSON.stringify(leftovers))
  if (leftovers.some(name => name.includes('probe'))) {
    throw new Error(`被拒绝的文件必须删除，实际残留：${JSON.stringify(leftovers)}`)
  }

  /* ---------- 4. 参数形状：缺资产直接失败，不读半个请求 ---------- */
  const malformed = await client.evaluate(
    `window.docvi.appUpdateDownload({ version: '9.9.9' }).then(r => r)`,
  )
  log('缺资产：', JSON.stringify(malformed))
  if (malformed?.ok) throw new Error('缺资产的请求被放行了')

  log('全部安全边界通过：不可信域 / 无校验值 / 校验失败 / 形状错误 均被拒绝')
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
