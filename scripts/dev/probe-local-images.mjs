#!/usr/bin/env node
/**
 * 一次性探针：验证单文件文档（工作区外）的相对路径图片能正常显示。
 *
 * 用户报「相对路径的图片无法预览」。根因是单文件文档没有内容根，图片前缀为
 * 空 → `images/a.png` 被解析成 `docvi://app/images/a.png`（渲染产物目录）→
 * 必然 404。修法是主进程在 `fileRead` 时登记文档所在目录并回传
 * `docvi://local/<id>` 前缀。
 *
 * 走**真实打开链路**：把文件路径作为命令行参数启动应用（与「双击 .md 关联」
 * 完全同一条路），而不是手工调 IPC。
 *
 * 断言：
 *   1. 页面里的 <img> 真的解码成功（naturalWidth > 0）；
 *   2. src 带 `docvi://local/<id>` 前缀，没有落进 `docvi://app/`；
 *   3. 资产协议对存在的文件返回 200、对不存在的返回 404；
 *   4. 点图片能开灯箱，且灯箱背景不透明（旧实现只有 96% 底色，正文透出来）。
 *
 * 用法：node scripts/dev/probe-local-images.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
/* 刻意**不**登记为工作区：这就是「单文件」场景 */
const DIR = mkdtempSync(join(tmpdir(), `docvi-probe-local-${TAG}-`))
const IMG_DIR = join(DIR, 'images')
const DOC = join(DIR, '单文件图片探针.md')

/** 1×1 PNG：内容不重要，能解码就行 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

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
  for (const dir of [DATA, DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 收尾失败不影响结论
    }
  }
}

const IMAGES = `(() => [...document.querySelectorAll('.at-doc img')].map(img => ({
  src: img.getAttribute('src'),
  loaded: img.complete && img.naturalWidth > 0,
  w: img.naturalWidth,
})))()`

async function main() {
  mkdirSync(IMG_DIR, { recursive: true })
  writeFileSync(join(IMG_DIR, 'a.png'), PNG)
  writeFileSync(DOC, '# 单文件图片探针\n\n![图 A](images/a.png)\n', 'utf8')

  // 文件路径作为参数：走主进程 markdownArgs → openPath → openStandalone
  child = spawn(ELECTRON, [APP_DIR, DOC, '--no-sandbox'], {
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
  await sleep(3500)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(2500)

  /* ---------- 1. 界面里的图片真的解码成功 ---------- */

  const images = await client.evaluate(IMAGES)
  log('页面图片：', JSON.stringify(images))
  if (!images?.length) throw new Error('单文件里没找到 <img>（文档没打开？）')

  const expectedId = createHash('sha256')
    .update(DOC.replaceAll('\\', '/').toLowerCase())
    .digest('hex')
    .slice(0, 16)
  const expected = `docvi://local/${expectedId}/images/a.png`
  if (images[0].src !== expected) {
    throw new Error(`图片 src 不对：期望 ${expected}，实际 ${images[0].src}`)
  }
  if (images[0].src.startsWith('docvi://app/')) {
    throw new Error('图片仍落在渲染产物目录（docvi://app/），单文件前缀没生效')
  }
  if (!images[0].loaded) {
    throw new Error(`图片没有解码成功（naturalWidth=${images[0].w}），说明取不到字节`)
  }
  log('单文件图片通过：src 带 local 前缀且解码成功')

  /* ---------- 2. 资产协议的边界 ---------- */

  const probe = await client.evaluate(`(async () => {
    const base = ${JSON.stringify(`docvi://local/${expectedId}`)}
    const urls = [
      base + '/images/a.png',
      base + '/images/不存在.png',
      base + '/../probe-outside.txt',
      'docvi://local/0000000000000000/images/a.png',
    ]
    const out = []
    for (const url of urls) {
      try {
        const res = await fetch(url)
        out.push({ url: url.replace(base, '<base>'), status: res.status })
      } catch (error) {
        out.push({ url: url.replace(base, '<base>'), error: error.message })
      }
    }
    return out
  })()`)
  log('协议探测：', JSON.stringify(probe))
  if (probe?.[0]?.status !== 200) throw new Error('资产协议没有伺服出图片')
  if (probe?.[1]?.status !== 404) throw new Error('不存在的图片应 404')
  if (probe?.[2]?.status === 200) throw new Error('越界路径必须被拒绝（不能 200）')
  if (probe?.[3]?.status !== 404) throw new Error('未登记的 id 必须 404')

  /* ---------- 3. 点击图片：灯箱打开且背景不透明 ---------- */

  await client.evaluate(`document.querySelector('.at-doc img')?.click()`)
  await sleep(1500)
  const lightbox = await client.evaluate(`(() => {
    const box = document.querySelector('.lightbox')
    if (!box) return { open: false }
    const style = getComputedStyle(box)
    return {
      open: true,
      background: style.backgroundColor,
      backdrop: style.backdropFilter,
      hasSurfaceToken: box.classList.contains('doc-surface'),
      imgVisible: (() => {
        const img = box.querySelector('.lightbox__img')
        return Boolean(img && img.complete && img.naturalWidth > 0)
      })(),
    }
  })()`)
  log('灯箱：', JSON.stringify(lightbox))
  if (!lightbox?.open) throw new Error('点图片没有打开灯箱')
  if (!lightbox.imgVisible) throw new Error('灯箱里的图片没有加载')
  // 透明的判定：rgba 的 alpha 必须为 1（旧实现是 0.96）
  const alpha = Number(lightbox.background.match(/rgba?\([^)]*?([\d.]+)\)$/)?.[1] ?? '1')
  if (alpha < 1) throw new Error(`灯箱背景仍然半透明（alpha=${alpha}）`)
  if (lightbox.backdrop && lightbox.backdrop !== 'none') {
    throw new Error(`灯箱不该再有背景模糊（backdrop-filter=${lightbox.backdrop}）`)
  }
  if (!lightbox.hasSurfaceToken) {
    throw new Error('灯箱缺少 doc-surface 类，配色 token 会全部失效')
  }
  log('灯箱通过：实底背景、无模糊、配色 token 生效')

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
