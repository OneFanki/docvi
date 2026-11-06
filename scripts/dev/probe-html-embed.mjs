#!/usr/bin/env node
/**
 * HTML 图解（`<at-html-embed>`）三面回归探针。
 *
 * 为什么需要它：这个组件的失败方式是「静默空白」——iframe 在、标题在，
 * 但图解的内联脚本被 CSP 拦掉后什么都不剩，既不弹错也没有红色提示，
 * 单元测试同样看不见。2026-11-06 修掉的两处缺陷都属于这一类：
 *
 *  1. srcdoc / blob: 子帧继承应用入口页 CSP → 图解脚本全被拦（图表全空）；
 *  2. 覆盖层 `Teleport to="body"` 后脱离 `.doc-surface` → `--at-*` 令牌失效
 *     （底色透明、控件无边框）。
 *
 * 断言五件事（全部程序化，不靠肉眼）：
 *  - A 内嵌：图解脚本真的执行了（读二级帧的 DOM 文本）；
 *  - B 全程零 CSP 违规日志；
 *  - C 新窗口：桌面端真的开出应用内窗口、承载了图解，且拿不到宿主能力；
 *  - D 覆盖层兜底：底色不透明、`--at-bg` 有值、顶栏让到标题栏以下；
 *  - E 导出契约：内容副本能回填成 srcdoc、沙箱 src 被摘掉。
 *
 * ⚠️ 沙箱页是不透明源的**跨进程 iframe**（OOPIF）：它不出现在父页的帧树里，
 * 而是 `/json/list` 的一个独立 `iframe` target。读图解内容必须连到那个 target，
 * 再走它自己的帧树 + `Page.createIsolatedWorld`。直接查父页帧树只会得到空结果。
 *
 * 用法：node scripts/dev/probe-html-embed.mjs   （需先 pnpm docvi:build）
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
const TAG = `embed${Date.now().toString(36)}`
const PORT = 9700 + Math.floor(Math.random() * 120)
const DATA = mkdtempSync(join(tmpdir(), `docvi-embed-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-embed-ws-${TAG}-`))
const SHOT_DIR = join(ROOT, '.temp/probe-html-embed')
const MARKER = 'INLINE-SCRIPT-RAN'

/** 图解内容：内联脚本把标记写进 body，探针据此判断脚本是否真的执行 */
const DIAGRAM = `<body style="margin:0;background:#fff;font:14px system-ui">
<div id="marker">not-run</div>
<script>document.getElementById('marker').textContent = ${JSON.stringify(MARKER)}</script>
</body>`

/**
 * 同一份图解的三个入口，覆盖「内联 / 引用文件 / 正文链接」：
 *  - 图解探针.md：`html:` 内联（原文粘贴）
 *  - 引用探针.md：`src:` 指向 assets/demo.html（子目录相对路径，最容易算错）
 *  - 链接探针.md：正文 `[打开](../assets/demo.html)`，点击开新窗口
 * 三者都要求图解脚本真的执行——只看到 iframe 存在不算通过。
 */
const DOC = `---
title: 图解探针
components:
  board:
    kind: html-embed
    title: 图解探针
    height: 320px
    html: |
${DIAGRAM.split('\n')
  .map(line => `      ${line}`)
  .join('\n')}
---

# 图解探针

<at-html-embed data-key="board"></at-html-embed>
`

const SRC_DOC = `---
title: 引用探针
components:
  board:
    kind: html-embed
    title: 引用探针
    height: 320px
    src: ../../assets/demo.html
---

# 引用探针

<at-html-embed data-key="board"></at-html-embed>
`

const LINK_DOC = `# 链接探针

[打开示意图](../../assets/demo.html)
`

let child = null
const failures = []
const cspErrors = []
const log = (...args) => console.log('[probe]', ...args)
const fail = message => {
  failures.push(message)
  console.error('[probe] ✗', message)
}

function connect(url, onEvent) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) {
      onEvent?.(message)
      return
    }
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    call(message.result)
  })
  return new Promise((done, failed) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => failed(new Error('CDP 连接失败')), { once: true })
  }).then(() => ({
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, result => done(result))
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

/** 列出调试目标（沙箱页是独立 iframe target，不在父页帧树里） */
async function listTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
}

/**
 * 连到承载图解的沙箱页 target，读出二级帧（`about:srcdoc`）里的文本。
 *
 * 沙箱帧是不透明源，主上下文读不到它的 DOM；`Page.createIsolatedWorld` 能按
 * frameId 开隔离世界，从而读到真实渲染结果。
 */
/**
 * 读出承载图解的二级帧文本。
 *
 * 两种拓扑都要认：
 *  - 内嵌态：沙箱页（`docvi://app` 的 iframe target）内联着 `about:srcdoc` 子帧，
 *    走 `Page.getFrameTree` + `Page.createIsolatedWorld`；
 *  - 新窗口态：srcdoc 帧会单独成为 OOPIF target（`type: iframe`, `url: about:srcdoc`），
 *    不在沙箱页的帧树里，只能连它自己求值。
 * 用 `knownIds` 排除点击前就存在的 srcdoc 帧（内嵌态那个），只认新出现的。
 */
async function readDiagramText(sandboxUrlPart, knownIds = new Set()) {
  const targets = await listTargets()
  const sandboxTarget = targets.find(
    item => (item.type === 'iframe' || item.type === 'page') && item.url.includes(sandboxUrlPart),
  )
  if (!sandboxTarget) return { ok: false, reason: '没找到沙箱页 target' }

  const client = await connect(sandboxTarget.webSocketDebuggerUrl)
  try {
    await client.send('Page.enable')
    // 投递是「宿主重试 → 沙箱页挂载」的异步过程：轮询等二级帧出现，别赌时序
    let inner = null
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(250)
      const tree = await client.send('Page.getFrameTree')
      inner = tree?.frameTree?.childFrames?.[0]?.frame ?? null
      if (inner) break
    }
    if (inner) {
      const world = await client.send('Page.createIsolatedWorld', {
        frameId: inner.id,
        worldName: 'docvi-probe',
      })
      const result = await client.send('Runtime.evaluate', {
        expression: 'document.body.innerText.trim()',
        returnByValue: true,
        contextId: world?.executionContextId,
      })
      return { ok: true, text: String(result?.result?.value ?? ''), via: 'childFrame' }
    }
  } finally {
    client.close()
  }

  // 退路：srcdoc 帧独立成 target
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = await listTargets()
    const srcdoc = targets.find(
      item => item.type === 'iframe' && item.url === 'about:srcdoc' && !knownIds.has(item.id),
    )
    if (srcdoc) {
      const frameClient = await connect(srcdoc.webSocketDebuggerUrl)
      try {
        const result = await frameClient.evaluate('document.body.innerText.trim()')
        return { ok: true, text: String(result ?? ''), via: 'oopif' }
      } finally {
        frameClient.close()
      }
    }
    await sleep(250)
  }
  return { ok: false, reason: '沙箱页里没有承载图解的二级帧' }
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

async function waitForApp() {
  for (let attempt = 0; attempt < 140; attempt += 1) {
    await sleep(300)
    try {
      const list = await listTargets()
      const target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) return target
    } catch {
      // 端口还没开
    }
  }
  throw new Error('应用窗口没有出现（CDP 不可达）')
}

async function openDocument(client, name) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  const added = await client.evaluate(
    `window.docvi.workspaceAddAt(${JSON.stringify(WS)}).then(r => r)`,
  )
  if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

  await client.evaluate('location.reload()')
  await sleep(3400)
  await client.evaluate(`(() => {
    [...document.querySelectorAll('.card')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))?.click()
  })()`)
  await sleep(2500)

  /*
   * 树节点是「点击切换展开」，盲点会折叠掉目标目录。按 aria-expanded 判断状态，
   * 并用正文 h1 确认文档真的切过去了——否则断言会在上一篇文档上跑。
   */
  const ensureExpanded = async folder => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await client.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-tree-path]')]
        const el = rows.find(n => {
          const p = n.dataset.treePath || ''
          return p === ${JSON.stringify(folder)} || p.endsWith('/' + ${JSON.stringify(folder)})
        })
        if (!el) return { found: false }
        return { found: true, expanded: el.getAttribute('aria-expanded') === 'true' }
      })()`)
      if (!state?.found) {
        await sleep(600)
        continue
      }
      if (state.expanded) return true
      await client.evaluate(`(() => {
        const rows = [...document.querySelectorAll('[data-tree-path]')]
        const el = rows.find(n => {
          const p = n.dataset.treePath || ''
          return p === ${JSON.stringify(folder)} || p.endsWith('/' + ${JSON.stringify(folder)})
        })
        el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })()`)
      await sleep(800)
    }
    return false
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await ensureExpanded('docs')
    await ensureExpanded('04-业务')
    await client.evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-tree-path]')]
      const row = rows.find(n => {
        const p = n.dataset.treePath || ''
        return p.endsWith('/' + ${JSON.stringify(name)}) || p.endsWith('/' + ${JSON.stringify(name)} + '.md')
      })
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })()`)
    await sleep(3200)
    const h1 = await client.evaluate(
      `document.querySelector('.at-doc h1')?.textContent?.trim() || null`,
    )
    if (h1 && h1.includes(name)) return
    await sleep(700)
  }
  throw new Error(`没能打开文档：${name}`)
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  mkdirSync(join(WS, 'docs', '04-业务'), { recursive: true })
  mkdirSync(join(WS, 'assets'), { recursive: true })
  // 图解文件本体：引用式与链接式都指向它，且它必须真的执行内联脚本
  writeFileSync(join(WS, 'assets', 'demo.html'), DIAGRAM, 'utf8')
  writeFileSync(join(WS, 'docs.config.yaml'), 'title: 探针\nstaticDirs:\n  - assets\n', 'utf8')
  writeFileSync(join(WS, 'docs', '04-业务', '图解探针.md'), DOC, 'utf8')
  writeFileSync(join(WS, 'docs', '04-业务', '引用探针.md'), SRC_DOC, 'utf8')
  writeFileSync(join(WS, 'docs', '04-业务', '链接探针.md'), LINK_DOC, 'utf8')

  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-embed-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
    },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })

  const target = await waitForApp()
  const client = await connect(target.webSocketDebuggerUrl, message => {
    if (message.method === 'Log.entryAdded') {
      const text = message.params?.entry?.text ?? ''
      if (/Content Security Policy/i.test(text)) cspErrors.push(text)
    }
  })
  await client.send('Log.enable')
  await client.send('Runtime.enable')
  await openDocument(client, '图解探针')

  /* ---------- A + B：内嵌态 ---------- */
  const inline = await client.evaluate(`(() => {
    const fig = document.querySelector('.at-htmlembed')
    const frame = fig?.querySelector('iframe.at-htmlembed__frame')
    return {
      error: fig?.querySelector('.at-htmlembed__state--error')?.textContent?.trim() || null,
      src: frame?.getAttribute('src') || '',
      sandbox: frame?.getAttribute('sandbox') || '',
      height: frame ? Math.round(frame.getBoundingClientRect().height) : 0,
    }
  })()`)
  log('内嵌 iframe：', JSON.stringify(inline))

  if (inline.error) fail(`内嵌态显示了错误提示：${inline.error}`)
  if (!inline.src.includes('embed-sandbox.html')) {
    fail(`内嵌 iframe 没有指向沙箱宿主页（实际：${inline.src || '空'}）`)
  }
  if (inline.sandbox !== 'allow-scripts') {
    fail(`内嵌 iframe 的 sandbox 不是 allow-scripts（实际：${inline.sandbox || '缺省'}）`)
  }
  if (inline.height <= 100) fail(`内嵌 iframe 高度异常：${inline.height}px`)

  const inlineDiagram = await readDiagramText('embed-sandbox.html')
  if (!inlineDiagram.ok) {
    fail(`内嵌图解读取失败：${inlineDiagram.reason}`)
  } else if (!inlineDiagram.text.includes(MARKER)) {
    fail(`图解内联脚本没有执行（二级帧文本：${JSON.stringify(inlineDiagram.text)}）`)
  } else {
    log('内嵌图解脚本已执行：', JSON.stringify(inlineDiagram.text))
  }

  if (cspErrors.length) {
    fail(`出现 ${cspErrors.length} 条 CSP 违规：${cspErrors[0].slice(0, 160)}`)
  }

  /*
   * 导出契约：屏幕态留一份内容副本（iframe 指向沙箱页），导出时把副本回填成
   * srcdoc 并摘掉 src。selector 一旦漂移，导出文件里就会剩一个加载不了的沙箱地址。
   */
  const exportView = await client.evaluate(`(() => {
    const clone = document.querySelector('.at-htmlembed')?.cloneNode(true)
    if (!clone) return { missing: true }
    for (const figure of [clone]) {
      const payload = figure.querySelector('.at-htmlembed__payload')
      const frame = figure.querySelector('iframe')
      if (!payload || !frame) continue
      frame.setAttribute('srcdoc', payload.textContent ?? '')
      frame.removeAttribute('src')
      payload.remove()
    }
    const frame = clone.querySelector('iframe')
    return {
      hasSrcdoc: Boolean(frame?.getAttribute('srcdoc')),
      srcdocHasMarker: (frame?.getAttribute('srcdoc') || '').includes(${JSON.stringify(MARKER)}),
      srcRemoved: !frame?.getAttribute('src'),
      payloadRemoved: !clone.querySelector('.at-htmlembed__payload'),
    }
  })()`)
  if (exportView.missing) {
    fail('导出契约检查找不到 .at-htmlembed')
  } else if (
    !exportView.hasSrcdoc ||
    !exportView.srcdocHasMarker ||
    !exportView.srcRemoved ||
    !exportView.payloadRemoved
  ) {
    fail(`导出回填契约不成立：${JSON.stringify(exportView)}`)
  } else {
    log('导出回填契约通过')
  }

  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOT_DIR, 'inline.png'), Buffer.from(shot.data, 'base64'))

  /* ---------- C：新窗口 ---------- */
  const beforeTargets = await listTargets()
  const beforeIds = new Set(beforeTargets.map(item => item.id))
  await client.evaluate(`document.querySelector('.at-htmlembed__open')?.click()`)
  await sleep(3500)
  const popupTargets = (await listTargets()).filter(
    item =>
      (item.type === 'page' || item.type === 'iframe') &&
      item.url.includes('embed-sandbox.html') &&
      !beforeIds.has(item.id),
  )
  if (!popupTargets.length) {
    fail('新窗口没有打开（桌面端窗口白名单可能没放行沙箱页）')
  } else {
    const popupDiagram = await readDiagramText(popupTargets[0].url, beforeIds)
    if (!popupDiagram.ok) {
      fail(`新窗口图解读取失败：${popupDiagram.reason}`)
    } else if (!popupDiagram.text.includes(MARKER)) {
      fail(`新窗口里的图解脚本没有执行：${JSON.stringify(popupDiagram.text)}`)
    } else {
      log('新窗口图解脚本已执行')
    }

    // 安全边界：承载文档内容的那一层不能拿到宿主能力
    const popupClient = await connect(popupTargets[0].webSocketDebuggerUrl)
    const bridge = await popupClient.evaluate(
      '({ docvi: typeof window.docvi, node: typeof require, process: typeof process })',
    )
    if (bridge?.docvi !== 'undefined' || bridge?.node !== 'undefined') {
      fail(`新窗口拿到了宿主能力：${JSON.stringify(bridge)}`)
    } else {
      log('新窗口无宿主能力：', JSON.stringify(bridge))
    }

    /*
     * 刷新恢复：新窗口态的 opener 已被切断，重载后没人能再投递内容。
     * 沙箱页必须靠自己的 sessionStorage 自恢复，否则用户按 Ctrl+R 就得到白屏
     * （2026-11-06 用户实测）。连刷两次，确认不是「碰巧还留在内存里」。
     */
    await popupClient.send('Page.enable')
    for (let round = 1; round <= 2; round += 1) {
      await popupClient.send('Page.reload')
      await sleep(2500)
      const restored = await readDiagramText('embed-sandbox.html', beforeIds)
      if (!restored.ok || !restored.text.includes(MARKER)) {
        fail(
          `第 ${round} 次刷新后图解丢失（${restored.ok ? JSON.stringify(restored.text) : restored.reason}）`,
        )
        break
      }
      log(`第 ${round} 次刷新后图解仍在`)
    }
    popupClient.close()
  }

  /* ---------- D：覆盖层兜底（打掉 window.open 强制走这条路） ---------- */
  await client.evaluate(`window.open = () => null`)
  await client.evaluate(`document.querySelector('.at-htmlembed__open')?.click()`)
  await sleep(3000)
  const overlay = await client.evaluate(`(() => {
    const el = document.querySelector('.at-htmlembed-overlay')
    if (!el) return { present: false }
    const style = getComputedStyle(el)
    const close = el.querySelector('.at-htmlembed-overlay__close')
    const closeStyle = close ? getComputedStyle(close) : null
    const head = el.querySelector('header')
    return {
      present: true,
      hasDocSurface: el.classList.contains('doc-surface'),
      background: style.backgroundColor,
      atBg: style.getPropertyValue('--at-bg').trim(),
      closeBorder: closeStyle?.borderTopWidth ?? '',
      headTop: head ? Math.round(head.getBoundingClientRect().top) : null,
      titlebarH:
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--dv-ui-titlebar-h'),
        ) || 0,
    }
  })()`)
  log('覆盖层：', JSON.stringify(overlay))

  if (!overlay.present) {
    fail('覆盖层没有出现（新窗口被拦后应走页内放大兜底）')
  } else {
    if (overlay.background === 'rgba(0, 0, 0, 0)') fail('覆盖层底色透明：主题令牌没生效')
    if (!overlay.atBg) fail('覆盖层拿不到 --at-bg：Teleport 后丢了 .doc-surface 作用域')
    if (overlay.closeBorder === '0px') fail('覆盖层关闭按钮没有边框：控件样式丢失')
    if (overlay.headTop !== null && overlay.headTop < overlay.titlebarH) {
      fail(`覆盖层顶栏 ${overlay.headTop}px 落进了窗口按钮带（${overlay.titlebarH}px）`)
    }
  }

  const overlayShot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOT_DIR, 'overlay.png'), Buffer.from(overlayShot.data, 'base64'))

  /* ---------- F：引用文件（src:）—— 不粘贴 HTML 也能显示 ---------- */
  await openDocument(client, '引用探针')
  const srcMode = await client.evaluate(`(() => {
    const fig = document.querySelector('.at-htmlembed')
    const frame = fig?.querySelector('iframe.at-htmlembed__frame')
    return {
      error: fig?.querySelector('.at-htmlembed__state--error')?.textContent?.trim() || null,
      placeholder: fig?.querySelector('.at-htmlembed__state')?.textContent?.trim().slice(0, 60) || null,
      frameSrc: frame?.getAttribute('src') || null,
    }
  })()`)
  log('引用式内嵌：', JSON.stringify(srcMode))
  if (srcMode.error) fail(`引用式显示了错误提示：${srcMode.error}`)
  if (!srcMode.frameSrc) fail('引用式没有渲染出 iframe（src 没有被解析到可读地址）')

  const srcDiagram = await readDiagramText('embed-sandbox.html')
  if (!srcDiagram.ok) {
    fail(`引用式图解读取失败：${srcDiagram.reason}`)
  } else if (!srcDiagram.text.includes(MARKER)) {
    fail(`引用式图解脚本没有执行：${JSON.stringify(srcDiagram.text)}`)
  } else {
    log('引用式图解脚本已执行')
  }

  /* ---------- G：正文链接（[打开](../assets/x.html)）→ 新窗口 ---------- */
  await openDocument(client, '链接探针')
  const href = await client.evaluate(`(() => {
    const links = [...document.querySelectorAll('.at-doc a[href]')]
    const a = links.find(x => (x.textContent || '').includes('打开示意图'))
    return a?.getAttribute('href') || null
  })()`)
  log('正文链接 href：', JSON.stringify(href))
  // `.html` 链接必须被归一到内容根（保留扩展名），否则宿主拿到相对路径无从解析
  if (!href || !/^\/.*\.html?$/i.test(href)) {
    fail(`.html 链接没有被归一为根相对地址（实际：${href ?? '空'}）`)
  }

  const beforeLinkIds = new Set((await listTargets()).map(item => item.id))
  await client.evaluate(
    `[...document.querySelectorAll('.at-doc a[href]')].find(x => (x.textContent || '').includes('打开示意图'))?.click()`,
  )
  await sleep(4500)
  const linkPopup = (await listTargets()).find(
    item =>
      !beforeLinkIds.has(item.id) &&
      (item.type === 'page' || item.type === 'iframe') &&
      item.url.includes('embed-sandbox.html'),
  )
  if (!linkPopup) {
    fail('点击 .html 链接没有打开沙箱窗口')
  } else {
    const linkDiagram = await readDiagramText('embed-sandbox.html')
    if (!linkDiagram.ok) fail(`链接打开后读不到图解：${linkDiagram.reason}`)
    else if (!linkDiagram.text.includes(MARKER)) {
      fail(`链接打开的图解脚本没有执行：${JSON.stringify(linkDiagram.text)}`)
    } else {
      log('链接打开的图解脚本已执行')
    }
  }

  client.close()

  if (failures.length) {
    throw new Error(`图解探针失败 ${failures.length} 项：\n  - ${failures.join('\n  - ')}`)
  }
  log('内嵌 / 引用 / 链接 / 新窗口 / 覆盖层 / 导出 全部通过')
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
