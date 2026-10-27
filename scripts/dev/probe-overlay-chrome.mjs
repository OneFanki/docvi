#!/usr/bin/env node
/**
 * 一次性探针：验证所有全屏 / 覆盖层组件都不会被窗口按钮遮挡。
 *
 * 窗口按钮由系统画在标题栏那一条上：Windows 在右上角（最小化/最大化/关闭），
 * macOS 在左上角（红绿灯）。全屏覆盖层若从窗口顶端铺下来、控件也排在最上面，
 * 就会与它们重叠——用户报的「大图查看右上角一部分内容会被遮挡」正是这个。
 *
 * 本探针逐个打开带覆盖层的组件，断言：头栏里每个按钮的竖直范围都在标题栏
 * 高度以下，`document.elementFromPoint` 命中测试也不会落到别的元素。
 *
 * 用法：node scripts/dev/probe-overlay-chrome.mjs   （需先 pnpm docvi:build）
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
const DOC = join(WS, '覆盖层探针.md')

/**
 * 三个带覆盖层的组件各来一份。data 段给最小可用数据：组件渲染出本体就能点开
 * 覆盖层，不需要真实业务内容。
 */
const CONTENT = `---
title: 覆盖层探针
components:
  flow:
    kind: flow-diagram
    title: 流程
    nodes:
      - { id: a, label: 开始 }
      - { id: b, label: 处理 }
      - { id: c, label: 结束 }
    edges:
      - { from: a, to: b }
      - { from: b, to: c }
  states:
    kind: state-flow
    title: 状态
    states:
      - { id: s1, label: 草稿 }
      - { id: s2, label: 已上架 }
    transitions:
      - { from: s1, to: s2, label: 上架 }
  tables:
    kind: table-tabs
    title: 表设计
    tables:
      - name: demo
        title: 示例表
        fields:
          - { name: id, type: bigint, note: 主键 }
---

# 覆盖层探针

<at-flow-diagram data-key="flow"></at-flow-diagram>

<at-state-flow data-key="states"></at-state-flow>

<at-table-tabs data-key="tables"></at-table-tabs>
`

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
  for (const dir of [DATA, WS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 收尾失败不影响结论
    }
  }
}

/**
 * 打开某个组件的覆盖层，然后返回所有可见覆盖层的头栏几何。
 *
 * ⚠️ 必须先找「全屏」再考虑「放大」：ZoomBar 里就有个 aria-label="放大" 的
 * 缩放按钮，按「放大」优先匹配会点到它——组件一点反应都没有，探针却以为
 * 已经打开了覆盖层（实测踩到）。
 */
const OPEN_OVERLAY = selector => `(() => {
  const root = document.querySelector(${JSON.stringify(selector)})
  if (!root) return { ok: false, reason: '组件未渲染' }
  const labelOf = b =>
    ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).trim()
  const buttons = [...root.querySelectorAll('button')]
  const btn =
    buttons.find(b => labelOf(b).includes('全屏')) ??
    buttons.find(b => labelOf(b).includes('放大查看'))
  if (!btn) return { ok: false, reason: '找不到全屏按钮', buttons: buttons.map(labelOf) }
  btn.click()
  return { ok: true, label: labelOf(btn).slice(0, 20) }
})()`

/** 量出覆盖层头栏的几何：每个控件的 top 必须 ≥ 标题栏高度 */
const MEASURE = `(() => {
  const titlebarH = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--dv-ui-titlebar-h'),
  ) || 0
  const overlays = [...document.querySelectorAll('.is-overlay, .at-htmlembed-overlay, .lightbox')]
    .filter(el => el.getBoundingClientRect().width > 0)
  if (!overlays.length) return { ok: false, reason: '没有可见覆盖层' }
  const results = overlays.map(el => {
    const r = el.getBoundingClientRect()
    // 头栏 = 覆盖层里第一个横向容器；按「含按钮的最上层子节点」定位更稳
    const head = el.querySelector('header, .at-flow__head, .at-stateflow__head, .at-tablegraph__head, .at-tabletabs__head') || el
    const headRect = head.getBoundingClientRect()
    const buttons = [...head.querySelectorAll('button')].map(btn => {
      const br = btn.getBoundingClientRect()
      const cx = Math.round(br.left + br.width / 2)
      const cy = Math.round(br.top + br.height / 2)
      const hit = document.elementFromPoint(cx, cy)
      return {
        label: (btn.getAttribute('aria-label') || btn.textContent || '').trim().slice(0, 12),
        top: Math.round(br.top),
        bottom: Math.round(br.bottom),
        right: Math.round(br.right),
        hitSelf: Boolean(hit && btn.contains(hit)),
        hitTag: hit ? hit.tagName : null,
      }
    })
    return {
      class: el.className.split(' ').find(c => c.startsWith('at-') || c === 'lightbox') || el.className,
      box: { top: Math.round(r.top), height: Math.round(r.height), windowH: window.innerHeight },
      headTop: Math.round(headRect.top),
      titlebarH,
      buttons,
    }
  })
  return { ok: true, titlebarH, results }
})()`

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, CONTENT, 'utf8')

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
  await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(3000)
  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('覆盖层探针.md'))
    row?.click()
  })()`)
  await sleep(3500)

  const cases = [
    { name: 'flow-diagram', selector: '.at-flow' },
    { name: 'state-flow', selector: '.at-stateflow' },
    { name: 'table-tabs', selector: '.at-tabletabs' },
  ]

  /*
   * 强制走**覆盖层**降级路径。
   *
   * 这些组件优先用原生 Fullscreen API，而原生全屏会连标题栏一起隐藏——那里没有
   * 窗口按钮，天然不冲突。真正需要避让的是降级路径：嵌入式页面（iframe / 容器版
   * 读者面）拿不到 Fullscreen 权限时，组件退化成 `position: fixed` 覆盖层，
   * 铺在带窗口按钮的窗口上。把 requestFullscreen 打掉即可稳定复现这条路径。
   */
  await client.evaluate(`(() => {
    Element.prototype.requestFullscreen = function () {
      return Promise.reject(new Error('probe: fullscreen disabled'))
    }
    return true
  })()`)

  const failures = []
  for (const item of cases) {
    const opened = await client.evaluate(OPEN_OVERLAY(item.selector))
    log(`${item.name} 打开覆盖层：`, JSON.stringify(opened))
    if (!opened?.ok) {
      failures.push(
        `${item.name}: ${opened?.reason ?? '打开失败'}${opened?.buttons ? `（按钮：${JSON.stringify(opened.buttons)}）` : ''}`,
      )
      continue
    }
    await sleep(1200)
    const measured = await client.evaluate(MEASURE)
    log(`${item.name} 几何：`, JSON.stringify(measured))
    if (!measured?.ok) {
      failures.push(`${item.name}: ${measured?.reason ?? '测量失败'}`)
      continue
    }
    for (const overlay of measured.results) {
      if (overlay.headTop < measured.titlebarH) {
        failures.push(
          `${item.name}: 头栏顶边 ${overlay.headTop}px 在窗口按钮带（${measured.titlebarH}px）内`,
        )
      }
      const bad = overlay.buttons.filter(btn => btn.top < measured.titlebarH || !btn.hitSelf)
      if (bad.length) {
        failures.push(`${item.name}: 顶栏控件被遮挡/不可点 ${JSON.stringify(bad)}`)
      }
    }
    // Esc 关掉，准备下一个
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    await client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    await sleep(900)
  }

  if (failures.length) throw new Error(`覆盖层避让失败：\n  - ${failures.join('\n  - ')}`)
  log('全部覆盖层避让通过')
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
