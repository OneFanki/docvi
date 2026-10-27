#!/usr/bin/env node
/**
 * 一次性功能探针：验证「文件被外部改动后界面能看到最新状态」。
 *
 * 用户报的问题是「没有刷新按钮，外部改了文件就看不到最新状态」。这条链路
 * 横跨主进程 watcher → IPC 推送 → 渲染层重读 → 文档模型裁决 → 视图刷新，
 * 任何一环断掉都不报错，只表现为「界面一直显示旧内容」。
 *
 * 断言三件事：
 *   1. 缓冲区干净时，外部改文件 → 界面自动跟上（无需操作）；
 *   2. 有未保存改动时，外部改文件 → 缓冲区不被覆盖（不静默丢用户的字）；
 *   3. 手动刷新按钮真的会重读磁盘。
 *
 * 用法：node scripts/dev/probe-external-change.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const WS = mkdtempSync(join(tmpdir(), `docvi-probe-ws-${TAG}-`))
const DOC = join(WS, '外部改动探针.md')
const V1 = '# 外部改动探针\n\n最初的内容。\n'
const V2 = '# 外部改动探针\n\n外部工具写入的第二版内容。\n'

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

/** 整组杀进程：只 kill 主进程会在 Windows 上留下 GPU / renderer 孤儿 */
function killTree() {
  if (!child) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  child = null
}

function cleanup() {
  killTree()
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 收尾失败不影响结论
    }
  }
}

/** 读取正文区域的文本（阅读态 .at-doc / 编辑态 .cm-content） */
const READ_BODY = `(() => {
  const doc = document.querySelector('.at-doc')
  if (doc) return doc.textContent || ''
  const cm = document.querySelector('.cm-content')
  return cm ? cm.textContent || '' : null
})()`

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, V1, 'utf8')

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
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

  await client.evaluate('location.reload()')
  await sleep(3200)

  const opened = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    const hit = cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))
    if (!hit) return { ok: false, texts: cards.map(c => (c.textContent || '').trim().slice(0, 60)) }
    hit.click()
    return { ok: true }
  })()`)
  if (!opened?.ok) throw new Error(`找不到工作区卡片：${JSON.stringify(opened?.texts ?? [])}`)
  await sleep(3000)

  const clicked = await client.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-tree-path]')]
    const hit = rows.find(el => (el.dataset.treePath || '').endsWith('外部改动探针.md'))
    if (!hit) return { ok: false, paths: rows.map(el => el.dataset.treePath) }
    hit.click()
    return { ok: true }
  })()`)
  if (!clicked?.ok) throw new Error(`找不到文档：${JSON.stringify(clicked?.paths ?? [])}`)
  await sleep(2600)

  const before = await client.evaluate(READ_BODY)
  log('打开后正文：', JSON.stringify(before))
  if (!before || !before.includes('最初的内容')) throw new Error('文档没有正确渲染')

  /* ---------- 场景一：缓冲区干净，外部改写 ---------- */

  writeFileSync(DOC, V2, 'utf8')
  log('已从外部写入第二版，等待界面自动跟上…')
  let adopted = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(300)
    const body = await client.evaluate(READ_BODY)
    if (body && body.includes('外部工具写入的第二版内容')) {
      adopted = body
      break
    }
  }
  if (!adopted) {
    const now = await client.evaluate(READ_BODY)
    throw new Error(`外部改动没有被界面采用，当前正文：${JSON.stringify(now)}`)
  }
  if (adopted.includes('最初的内容')) throw new Error('界面同时显示了新旧两版内容')
  log('场景一通过：外部改动已自动反映到界面')

  /* ---------- 场景二：有未保存改动，外部再改 ---------- */

  // 切到实时预览，敲字制造未保存改动
  const switched = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.status__btn')]
      .find(b => (b.textContent || '').trim() === '实时预览')
    if (!btn) return { ok: false, labels: [...document.querySelectorAll('.status__btn')].map(b => (b.textContent || '').trim()) }
    btn.click()
    return { ok: true }
  })()`)
  if (!switched?.ok) throw new Error(`切不到实时预览：${JSON.stringify(switched?.labels ?? [])}`)
  await sleep(2600)

  const box = await client.evaluate(`(() => {
    const line = [...document.querySelectorAll('.cm-line')]
      .find(el => (el.textContent || '').includes('第二版内容'))
    if (!line) return null
    const r = line.getBoundingClientRect()
    return { x: Math.round(r.right - 6), y: Math.round(r.top + r.height / 2) }
  })()`)
  if (!box) throw new Error('编辑态找不到目标行')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    })
  }
  await sleep(400)
  await client.send('Input.dispatchKeyEvent', { type: 'char', text: '我' })
  await sleep(600)
  // 读缓冲区（不经界面断言，避免受渲染影响）
  const dirtyText = await client.evaluate(`(() => {
    const cm = document.querySelector('.cm-content')
    return cm ? cm.textContent || '' : null
  })()`)
  log('打字后编辑区：', JSON.stringify(dirtyText))
  if (!dirtyText || !dirtyText.includes('我')) throw new Error('没能输入未保存改动')

  writeFileSync(DOC, '# 外部改动探针\n\n第三方版本，不该覆盖我的输入。\n', 'utf8')
  log('已从外部写入第三方版本，断言缓冲区不被覆盖…')
  await sleep(2600)
  const afterConflict = await client.evaluate(`(() => {
    const cm = document.querySelector('.cm-content')
    const dialog = document.querySelector('.conflict__card')
    return {
      text: cm ? cm.textContent || '' : null,
      conflictOpen: Boolean(dialog),
      conflictText: dialog ? (dialog.textContent || '').slice(0, 40) : null,
    }
  })()`)
  log('冲突后状态：', JSON.stringify(afterConflict))
  if (!afterConflict.text?.includes('我')) {
    throw new Error(`未保存改动被外部内容覆盖了：${JSON.stringify(afterConflict.text)}`)
  }
  if (!afterConflict.conflictOpen) throw new Error('检测到冲突但没有弹出冲突框')

  /* ---------- 场景三：手动刷新入口存在且可用 ---------- */

  const reloadBtn = await client.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.status__btn')]
    const hit = btns.find(b => (b.textContent || '').trim() === '重新载入')
    return hit ? { ok: true, disabled: hit.disabled } : { ok: false, labels: btns.map(b => (b.textContent || '').trim()) }
  })()`)
  if (!reloadBtn?.ok)
    throw new Error(`状态栏没有「重新载入」按钮：${JSON.stringify(reloadBtn?.labels ?? [])}`)
  log('场景三：找到重新载入按钮，disabled =', reloadBtn.disabled)

  /* ---------- 场景四：先关掉冲突框，再点刷新，走「重新载入磁盘版本」 ---------- */

  // 先按「稍后处理」把场景二弹的框关掉，模拟用户先放着不管
  const dismissed = await client.evaluate(`(() => {
    const card = document.querySelector('.conflict__card')
    if (!card) return { ok: false }
    const btn = [...card.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim() === '稍后处理')
    if (!btn) return { ok: false, buttons: [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()) }
    btn.click()
    return { ok: true }
  })()`)
  if (!dismissed?.ok) throw new Error(`关不掉冲突框：${JSON.stringify(dismissed?.buttons ?? [])}`)
  await sleep(600)

  await client.evaluate(`(() => {
    const hit = [...document.querySelectorAll('.status__btn')]
      .find(b => (b.textContent || '').trim() === '重新载入')
    hit.click()
  })()`)
  await sleep(2000)

  /*
   * 关键不变量：编辑态点刷新只能有**一个**冲突框。两个框叠在一起时，
   * 用户点哪个都会以为另一个的决定生效，实际只有一个 write 出去。
   */
  const dialogs = await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.conflict__card, .dialog')]
    return {
      count: cards.length,
      buttons: cards.map(c => [...c.querySelectorAll('button')].map(b => (b.textContent || '').trim())),
    }
  })()`)
  log('刷新后的冲突框：', JSON.stringify(dialogs))
  if (dialogs.count !== 1) throw new Error(`刷新应只弹一个冲突框，实际 ${dialogs.count} 个`)
  if (!dialogs.buttons[0]?.some(label => label.includes('重新载入磁盘版本'))) {
    throw new Error(`冲突框缺少「重新载入磁盘版本」：${JSON.stringify(dialogs.buttons[0])}`)
  }

  const picked = await client.evaluate(`(() => {
    const card = document.querySelector('.conflict__card')
    const btn = [...card.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim().includes('重新载入磁盘版本'))
    if (!btn) return { ok: false }
    btn.click()
    return { ok: true }
  })()`)
  if (!picked?.ok) throw new Error('点不到「重新载入磁盘版本」按钮')
  await sleep(2200)

  const final = await client.evaluate(READ_BODY)
  log('刷新后正文：', JSON.stringify(final))
  if (!final || !final.includes('第三方版本')) {
    throw new Error(`手动刷新没有载入磁盘版本：${JSON.stringify(final)}`)
  }

  log('全部断言通过')
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
