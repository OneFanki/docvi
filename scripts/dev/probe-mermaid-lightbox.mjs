#!/usr/bin/env node
/**
 * 一次性探针：量出 mermaid 大图查看里 SVG 的真实排版尺寸。
 *
 * 用户报「mermaid 大图看不清」。看不清有两种完全不同的成因：
 *   a) 光栅分辨率不足（SVG 被 layout 成一个小尺寸再放上去）；
 *   b) 变换挂在包裹层而非 SVG 自身（Chromium 对 SVG 的已知绘制缺陷）。
 * 这里把 SVG 的属性、布局尺寸、缩放倍率一起打出来，用数据判断是哪一种。
 *
 * 用法：node scripts/dev/probe-mermaid-lightbox.mjs   （需先 pnpm docvi:build）
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
const DOC = join(WS, '图探针.md')

const MERMAID = `# 图探针

下面是一张真实的宽流程图，节点文字很密——正是阅读列里看不清、需要大图的那类。

\`\`\`mermaid
flowchart TD
  A[数据货架管理列表] --> B[添加数据商品]
  B --> C[填写商品表单抽屉]
  C --> D{确认校验通过?}
  D -->|通过| E[创建成功 状态=已下架 草稿]
  D -->|失败| F[字段下方红字提示 不发请求]
  E --> G[上架确认弹窗]
  E --> H[下架确认弹窗]
  E --> I[删除确认弹窗]
  G --> J[状态=已上架 商城可见]
  H --> K[状态=已下架 草稿]
  I --> L[删除成功 列表刷新]
  J --> M[前台商城展示为商品卡片/详情]
\`\`\`
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

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC, MERMAID, 'utf8')

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
    const hit = cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))
    hit?.click()
  })()`)
  await sleep(3000)

  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('图探针.md'))
    row?.click()
  })()`)
  await sleep(3500)

  const inDoc = await client.evaluate(`(() => {
    const svg = document.querySelector('.at-mermaid svg')
    if (!svg) return { ok: false }
    const r = svg.getBoundingClientRect()
    return {
      ok: true,
      attr: { width: svg.getAttribute('width'), height: svg.getAttribute('height'), viewBox: svg.getAttribute('viewBox'), style: svg.getAttribute('style') },
      box: { w: Math.round(r.width), h: Math.round(r.height) },
    }
  })()`)
  log('正文里的 SVG：', JSON.stringify(inDoc))

  // 点开大图
  await client.evaluate(`document.querySelector('.at-mermaid')?.click()`)
  await sleep(2500)

  const inLightbox = await client.evaluate(`(() => {
    const root = document.querySelector('.lightbox')
    if (!root) return { ok: false }
    const svg = root.querySelector('.lightbox__svg svg')
    const content = root.querySelector('.lightbox__content')
    const svgRect = svg?.getBoundingClientRect()
    const contentRect = content?.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const head = root.querySelector('.lightbox__head')
    const headRect = head?.getBoundingClientRect()
    /*
     * 顶栏控件不能被窗口按钮压住。
     *
     * Windows 把最小化/最大化/关闭画在窗口右上角，macOS 把红绿灯画在左上角。
     * 覆盖层若让头栏落在同一条带上，最右那个关闭按钮会被窗口的 ✕ 盖住，
     * 点下去是关窗口而不是关大图。
     *
     * 判据：
     *   1. 覆盖层仍需铺满全窗（不留应用标题栏在上方）；
     *   2. 头栏与它内部每个按钮都整体低于标题栏高度。
     */
    const titlebarH = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--dv-ui-titlebar-h'),
    ) || 0
    const buttons = [...(head?.querySelectorAll('button') ?? [])].map(btn => {
      const r = btn.getBoundingClientRect()
      return { label: (btn.textContent || '').trim(), top: Math.round(r.top), right: Math.round(r.right) }
    })
    return {
      ok: true,
      attr: svg ? {
        width: svg.getAttribute('width'),
        height: svg.getAttribute('height'),
        viewBox: svg.getAttribute('viewBox'),
        style: svg.getAttribute('style'),
      } : null,
      svgBox: svgRect ? { w: Math.round(svgRect.width), h: Math.round(svgRect.height) } : null,
      contentOffset: content ? { w: content.offsetWidth, h: content.offsetHeight } : null,
      transform: content ? getComputedStyle(content).transform : null,
      percent: (document.querySelector('.at-zoom__value')?.textContent || '').trim(),
      overlayTop: Math.round(rootRect.top),
      overlayCoversWindow: Math.round(rootRect.top) === 0 && Math.round(rootRect.height) === window.innerHeight,
      headTop: headRect ? Math.round(headRect.top) : null,
      titlebarH,
      buttons,
      toolbar: [...root.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
    }
  })()`)
  log('大图里的 SVG：', JSON.stringify(inLightbox))

  if (!inLightbox?.ok) throw new Error('灯箱没有打开')
  if (!inLightbox.overlayCoversWindow) {
    throw new Error(
      `灯箱应铺满整个窗口（顶边 ${inLightbox.overlayTop}px、高 ${inLightbox.overlayCoversWindow}），否则应用标题栏会浮在大图上`,
    )
  }
  const intruding = inLightbox.buttons.filter(btn => btn.top < inLightbox.titlebarH)
  if (intruding.length) {
    throw new Error(`顶栏控件落在窗口按钮带里，会被遮住：${JSON.stringify(intruding)}`)
  }
  log('避让通过：头栏顶边', inLightbox.headTop, 'px，窗口按钮带高', inLightbox.titlebarH, 'px')

  // 默认视图截图：看顶栏与窗口按钮的实际位置关系
  mkdirSync(join(ROOT, '.temp'), { recursive: true })
  const shot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(ROOT, '.temp', 'mermaid-lightbox.png'), Buffer.from(shot.data, 'base64'))

  // 再验证最右侧的关闭按钮真的能点到（命中测试不被别的元素接管）
  const hitTest = await client.evaluate(`(() => {
    const root = document.querySelector('.lightbox')
    const closeBtn = [...root.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '') === '关闭大图')
    if (!closeBtn) return { ok: false }
    const r = closeBtn.getBoundingClientRect()
    // 取按钮中心做命中测试：返回最顶层元素，必须仍是这个按钮（或它的子节点）
    const top = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    return {
      ok: true,
      box: { top: Math.round(r.top), right: Math.round(r.right), w: Math.round(r.width) },
      hitInside: Boolean(top && closeBtn.contains(top)),
      hitTag: top ? top.tagName + '.' + (top.className || '') : null,
    }
  })()`)
  log('关闭按钮命中测试：', JSON.stringify(hitTest))
  if (!hitTest?.ok) throw new Error('找不到灯箱的关闭按钮')
  if (!hitTest.hitInside) {
    throw new Error(`关闭按钮被别的元素盖住了：命中 ${hitTest.hitTag}`)
  }

  // 拖拽一下，检查是否选中了文本
  const box = await client.evaluate(`(() => {
    const el = document.querySelector('.lightbox__viewport')
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)
  for (const type of ['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: box.x + (type === 'mouseMoved' ? 80 : 0),
      y: box.y - (type === 'mouseMoved' ? 40 : 0),
      button: 'left',
      buttons: 1,
      clickCount: 1,
    })
    await sleep(120)
  }
  await sleep(500)
  const selection = await client.evaluate(`(() => ({
    text: String(window.getSelection() || ''),
    bodyUserSelect: getComputedStyle(document.body).userSelect,
  }))()`)
  log('拖拽后选区：', JSON.stringify(selection))

  // 缩放 200% 后再检查一次：文字必须跟着一起缩放（Chromium SVG 绘制缺陷的守门断言）
  await client.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.lightbox button')]
    const plus = btns.find(b => (b.getAttribute('aria-label') || '') === '放大')
    plus?.click()
  })()`)
  await sleep(400)
  await client.evaluate(`(() => {
    const btns = [...document.querySelectorAll('.lightbox button')]
    const plus = btns.find(b => (b.getAttribute('aria-label') || '') === '放大')
    plus?.click()
  })()`)
  await sleep(600)
  const zoomed = await client.evaluate(`(() => {
    const svg = document.querySelector('.lightbox__svg svg')
    const text = svg?.querySelector('text, .nodeLabel, foreignObject div')
    const r = text?.getBoundingClientRect()
    const content = document.querySelector('.lightbox__content')
    return {
      percent: (document.querySelector('.at-zoom__value')?.textContent || '').trim(),
      svgTransform: svg?.style.transform || null,
      contentTransform: content ? getComputedStyle(content).transform : null,
      textBox: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
    }
  })()`)
  log('放大 144% 后：', JSON.stringify(zoomed))
  const shot2 = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(
    join(ROOT, '.temp', 'mermaid-lightbox-zoomed.png'),
    Buffer.from(shot2.data, 'base64'),
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
