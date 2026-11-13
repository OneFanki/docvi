#!/usr/bin/env node
/**
 * 在**真实数据目录副本**上复现「切设置标签文档回顶」。
 *
 * 前几轮失败的原因：所有探针都用全新临时数据，而用户的 session.json 里有
 * 历史遗留值。这里把用户真实的数据目录**复制**一份来跑，既复现真实状态，
 * 又不动原文件。
 *
 * 用法：node scripts/dev/probe-real-session.mjs [数据目录]
 *   默认 C:/Users/<user>/AppData/Roaming/docvi-dev
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `rs${Date.now().toString(36)}`
const PORT = 9550 + Math.floor(Math.random() * 40)

const SOURCE_DATA = process.argv[2] ?? join(homedir(), 'AppData', 'Roaming', 'docvi-dev')
const DATA = mkdtempSync(join(tmpdir(), `docvi-rs-data-${TAG}-`))

let child = null
const log = (...args) => console.log('[real]', ...args)

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    call(message.result ?? message.error)
  })
  return new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
  }).then(() => ({
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, message => done(message))
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
    // 忽略
  }
}

/** 读一份 session.json 里所有文档的位置 */
function positions(file) {
  try {
    const session = JSON.parse(readFileSync(file, 'utf8'))
    return (session.tabs ?? []).flatMap(tab =>
      (tab.history ?? []).map(doc => ({
        tab: tab.kind,
        title: doc.title,
        scrollY: Math.round(doc.scrollY ?? 0),
        topLine: doc.topLine,
      })),
    )
  } catch {
    return null
  }
}

async function main() {
  if (!existsSync(join(SOURCE_DATA, 'session.json'))) {
    throw new Error(`找不到会话文件：${join(SOURCE_DATA, 'session.json')}`)
  }

  /*
   * 只复制会话与设置文件，不带 Chromium 缓存（几百 MB 且无意义）。
   *
   * ⚠️ workspaces.json 必须一起带：不带的话工作区注册表是空的，
   * `ensureDocLoaded` 读不到文件，正文区是空状态（scrollHeight 只有一屏），
   * 探针量到的「滚动位置」毫无意义——第一版就栽在这里。
   */
  for (const name of ['session.json', 'settings.json', 'workspaces.json', 'recent.json']) {
    const src = join(SOURCE_DATA, name)
    if (existsSync(src)) cpSync(src, join(DATA, name))
  }
  const sessionFile = join(DATA, 'session.json')
  log('复制会话:', JSON.stringify(positions(sessionFile)))

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-rs-${TAG}`,
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
  if (!target) throw new Error('应用窗口没有出现')

  const client = await connect(target.webSocketDebuggerUrl)
  /*
   * 页面脚本执行前就把取证数组挂上去。
   *
   * 不能等 CDP 连上再注入：启动恢复（会话 → 打开标签 → 恢复位置）在渲染进程
   * 起来后立刻发生，那时 CDP 还没连上，日志会全部丢失——上一版就是这么拿到
   * 0 条记录的。
   */
  await client.send('Page.enable')
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'window.__posLog = [];',
  })
  await client.evaluate('window.__posLog = window.__posLog || []')
  await sleep(6000)

  const state = await client.evaluate(`(() => {
    const el = document.querySelector('.reader')
    const surface = document.querySelector('.at-doc')
    const tabs = [...document.querySelectorAll('.tab')].map(t => (t.textContent || '').trim())
    return {
      hasReader: Boolean(el),
      scrollTop: el ? Math.round(el.scrollTop) : null,
      scrollHeight: el ? el.scrollHeight : null,
      clientHeight: el ? el.clientHeight : null,
      /* 正文是否真的渲染出来了：块数与首块文本 */
      blocks: surface ? surface.querySelectorAll('[data-source-line]').length : 0,
      firstText: surface ? (surface.textContent || '').trim().slice(0, 60) : '',
      warn: document.querySelector('.reader__warn')?.textContent?.trim() ?? null,
      emptyHint: document.querySelector('.reader__empty-hint')?.textContent?.trim() ?? null,
      tabs,
    }
  })()`)
  log('启动后:', JSON.stringify(state))
  if (!state.hasReader) {
    log('❗ 没有恢复到阅读视图，无法复现')
    process.exitCode = 1
    return
  }

  /*
   * 用户的操作：往下滚一段 → 点设置 → 点回文档。
   *
   * 判据用两样东西：session.json 里存了什么（写盘真相），以及切回后画布上的
   * 源行（用户视角真相）。两者一起看才能分清「没存对」还是「存对了没恢复」。
   */
  const scrolled = await client.evaluate(`(() => {
    const el = document.querySelector('.reader')
    const range = el.scrollHeight - el.clientHeight
    el.scrollTop = Math.round(range * 0.45)
    return { range, top: Math.round(el.scrollTop) }
  })()`)
  log(`滚到 ${scrolled.top} / 可滚 ${scrolled.range}`)
  await sleep(1200)
  log('滚动后会话:', JSON.stringify(positions(sessionFile)))

  const opened = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '').includes('设置'))
    if (!btn) return { error: 'no settings button' }
    btn.click()
    return { ok: true }
  })()`)
  log('点设置:', JSON.stringify(opened))
  await sleep(1600)
  log('切到设置后会话:', JSON.stringify(positions(sessionFile)))

  /*
   * 切回文档标签：按**当前正在看的那一篇**的标题匹配。
   *
   * 不能取「最后一个标签」——设置刚被打开，它往往就是最后一个，点了等于
   * 原地不动（第一版就点回了设置页，量到 hasReader:false）。
   */
  const docTitle = state.tabs.find(label => !/文档库|设置|插件/.test(label)) ?? ''
  const back = await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    const docTab = tabs.find(t => (t.textContent || '').includes(${JSON.stringify(docTitle)}))
    if (!docTab) return { error: 'no doc tab', labels: tabs.map(t => (t.textContent || '').trim()) }
    docTab.click()
    return { ok: true, label: (docTab.textContent || '').trim() }
  })()`)
  log('切回:', JSON.stringify(back))

  /*
   * 连续采样而不是只读一次。
   *
   * `rendered` 会触发多次（首次渲染、高亮完成、mermaid 完成各一次），恢复也
   * 就执行多次。只读一次很容易落在「第一次恢复后、最后一 次恢复前」的中间态，
   * 量到一个不代表最终结果的数字。
   */
  for (const wait of [1000, 2000, 4000, 6000]) {
    await sleep(wait === 1000 ? 1000 : 1000)
    const snapshot = await client.evaluate(`(() => {
      const el = document.querySelector('.reader')
      const surface = document.querySelector('.at-doc')
      if (!el || !surface) return { hasReader: false }
      const base = el.getBoundingClientRect().top
      let line = null
      for (const block of surface.querySelectorAll('[data-source-line]')) {
        if (block.getBoundingClientRect().top - base <= 2) line = Number(block.dataset.sourceLine)
      }
      return { hasReader: true, scrollTop: Math.round(el.scrollTop), line }
    })()`)
    log(`切回后 +${wait}ms:`, JSON.stringify(snapshot))
  }
  log('切回后会话:', JSON.stringify(positions(sessionFile)))

  const final = await client.evaluate(`(() => {
    const el = document.querySelector('.reader')
    return el ? Math.round(el.scrollTop) : 0
  })()`)
  const ok = final > 100
  if (ok) {
    log(`✓ 位置保住（最终 scrollTop=${final}）`)
  } else {
    log(`❗ 位置丢失（最终 scrollTop=${final}）`)
    process.exitCode = 1
  }

  const posLog = await client.evaluate('window.__posLog')
  log(`取证日志 ${posLog?.length ?? 0} 条:`)
  for (const entry of posLog ?? []) log('  ' + JSON.stringify(entry))

  client.close()
}

main()
  .catch(error => {
    log('失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
  })
