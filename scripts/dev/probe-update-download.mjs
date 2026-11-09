#!/usr/bin/env node
/**
 * 探针：用**真实 release 资产**完整跑一遍下载 + 校验，再验证取消。
 *
 * ⚠️ 会下载一个约 100MB 的真实安装包到系统临时目录，跑完即删。
 * 不执行安装。
 *
 * 三段断言，每一段都对应过真实故障：
 *  1. **下载能完成、SHA-256 与发布记录一致**——走 `net.fetch`（Chromium 栈）
 *     才读系统代理；换成 Node 全局 fetch 会「检查能过、下载一动不动」。
 *  2. **进度事件真的在推**——没有中间事件，界面就是一格空白。
 *  3. **取消真的能停下**（2026-11-09 补，实测曾是空操作）：`request.abort()`
 *     只在响应头到达前有效，响应一到再 abort 什么也不做，body 继续把 100MB
 *     下完然后「成功」返回，用户点了取消进度条照走。修法是把 abort 挂到响应流上。
 *
 * 用法：node scripts/dev/probe-update-download.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

/**
 * 目标资产：取自线上 v0.6.0 的 Release（含 GitHub 自己算的 digest）。
 * 内置而不是现场查：查询会走 CORS / 速率限制，与「下载是否走代理」这件事无关。
 */
const KNOWN = {
  name: 'docvi-0.6.0-win-x64-setup.exe',
  url: 'https://github.com/OneFanki/docvi/releases/download/v0.6.0/docvi-0.6.0-win-x64-setup.exe',
  size: 103861658,
  sha256: 'b87ffc64cdb7655050abbce76eeaa568f8220b441e692741320a8ab6877a834e',
}

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
  // 删掉本探针下载的产物（不碰安装脚本 .cmd，那是别的场景的）
  try {
    if (existsSync(UPDATE_DIR)) {
      for (const name of readdirSync(UPDATE_DIR)) {
        if (!name.endsWith('.cmd')) rmSync(join(UPDATE_DIR, name), { force: true })
      }
    }
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

  // 订阅进度：确认进度事件真的在推，而不是只有最终结果
  await client.evaluate(`(() => {
    window.__probeProgress = []
    window.docvi.onUpdateProgress(p => window.__probeProgress.push({
      phase: p.phase, received: p.received, total: p.total,
    }))
    return true
  })()`)

  log('目标资产：', KNOWN.name, `${(KNOWN.size / 1024 / 1024).toFixed(1)} MB`)
  const started = Date.now()
  const result = await client.evaluate(
    `window.docvi.appUpdateDownload({ asset: ${JSON.stringify(KNOWN)}, version: '0.6.0' }).then(r => r)`,
  )
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  log(`下载结果（${elapsed}s）：`, JSON.stringify(result))
  if (!result?.ok) {
    throw new Error(
      `下载失败：${result?.error?.message}——若网络必须走代理，这条失败正好说明「没用 Chromium 网络栈」`,
    )
  }

  const progress = await client.evaluate('window.__probeProgress')
  log('进度事件数：', progress?.length ?? 0, '最后一次：', JSON.stringify(progress?.at(-1)))
  if (!progress?.length) throw new Error('没有收到任何进度事件（UI 进度条会一直空着）')
  if (progress.at(-1)?.phase !== 'ready') {
    throw new Error(`最终阶段应为 ready，实际 ${progress.at(-1)?.phase}`)
  }
  // 必须有中间的 downloading 阶段，否则进度条是假的
  if (!progress.some(item => item.phase === 'downloading' && (item.received ?? 0) > 0)) {
    throw new Error('没有任何带字节数的下载中间事件')
  }

  /* 独立复算 SHA-256：不信任主进程自己的结论 */
  const file = join(UPDATE_DIR, result.data.fileName)
  if (!existsSync(file)) throw new Error(`下载完成但文件不存在：${file}`)
  const bytes = readFileSync(file)
  const actual = createHash('sha256').update(bytes).digest('hex')
  log('文件：', result.data.fileName, `${(bytes.length / 1024 / 1024).toFixed(1)} MB`)
  log('SHA-256：', actual)
  if (actual !== KNOWN.sha256) {
    throw new Error(`探针复算的校验和与发布记录不一致：${actual} ≠ ${KNOWN.sha256}`)
  }
  if (bytes.length !== KNOWN.size) {
    throw new Error(`文件大小不符：${bytes.length} ≠ ${KNOWN.size}`)
  }

  log('通过：真实资产下载完整、SHA-256 与 GitHub 发布记录一致、进度事件正常')

  /*
   * ③ 取消：再下一次，收到字节后中断。
   *
   * 必须等到真开始收字节再取消——「响应头到达前的 abort」本来就能用，
   * 那样测不出这个缺陷（缺陷正是响应到达后 abort 变成空操作）。
   */
  await client.evaluate(`(() => {
    window.__probeCancel = []
    window.docvi.onUpdateProgress(p => window.__probeCancel.push({ phase: p.phase, received: p.received ?? 0 }))
    window.__probeCancelResult = null
    window.docvi.appUpdateDownload({ asset: ${JSON.stringify(KNOWN)}, version: '0.6.0' })
      .then(r => { window.__probeCancelResult = r })
      .catch(e => { window.__probeCancelResult = { threw: String(e) } })
    return true
  })()`)

  // 等到收到 >2MB 再取消：确保响应头早已到达、body 正在流
  let before = { count: 0, received: 0 }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(300)
    before = await client.evaluate(`(() => {
      const list = window.__probeCancel
      return { count: list.length, received: list.at(-1)?.received ?? 0 }
    })()`)
    if ((before?.received ?? 0) > 2 * 1024 * 1024) break
  }
  if (!before || before.received <= 0) {
    throw new Error('取消测试拿不到任何字节——无法验证「流已开始后能否中断」')
  }
  const receivedAtCancel = before.received
  log(`取消测试：已收 ${(receivedAtCancel / 1024 / 1024).toFixed(1)}MB 后调用取消`)

  const cancelAt = Date.now()
  await client.evaluate('window.docvi.appUpdateCancel()')
  await sleep(5000)
  const after = await client.evaluate(`(() => ({
    count: window.__probeCancel.length,
    last: window.__probeCancel.at(-1) ?? null,
    result: window.__probeCancelResult,
  }))()`)
  const settledMs = Date.now() - cancelAt

  if (after.result?.ok) {
    throw new Error(
      '取消后下载仍然成功返回——取消是空操作（响应流没有被 destroy）。' +
        '这正是 2026-11-09 修的那个缺陷，别退回去。',
    )
  }
  if (after.last?.phase !== 'error') {
    throw new Error(`取消后最后阶段应为 error，实际 ${after.last?.phase}`)
  }
  // 取消后不该再有字节继续流进来。
  //
  // 只统计 downloading 阶段的事件：error 事件的 received 是 0（主进程用它表示
  // 「这次没下成」，不是「已下 0 字节」），直接拿它相减会得出负数。
  const downloadedAfter = await client.evaluate(
    `(() => window.__probeCancel.filter(e => e.phase === 'downloading').at(-1)?.received ?? 0)()`,
  )
  const leakedAfter = downloadedAfter - receivedAtCancel
  if (leakedAfter > 3 * 1024 * 1024) {
    throw new Error(`取消后仍多收了 ${(leakedAfter / 1024 / 1024).toFixed(1)}MB，流没有被真正中断`)
  }
  log(`取消测试：${settledMs}ms 内以 error 收尾，取消后仅多收 ${(leakedAfter / 1024).toFixed(0)}KB`)
  log('通过：进度可见、下载可校验、取消有效')
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
