#!/usr/bin/env node
/**
 * 一次性探针：验证插件市场「拉产物 → 校验 → 安装 → 生效」整条链路。
 *
 * 用户的诉求是「插件仓库自动构建出产物，我们只管拉产物」。这条链路的每一环
 * 都能单独通过类型检查，却可能在联调时断掉：
 *
 *   1. 清单解析（artifact 字段是否被收进 MarketEntry）
 *   2. 界面渲染（安装按钮是否出现、作者/star 是否显示）
 *   3. 产物下载（net.fetch 是否真的能取到、URL 是否按 manifest 相对解析）
 *   4. 落盘（是否落到 <userData>/plugins/<name>/<version>/）
 *   5. 生效（装完是否出现在「已安装」里）
 *
 * 为了不依赖真实网络，探针在本机起一个静态服务器托管「产物」，并通过
 * DOCVI_MARKET_URL 与 DOCVI_MARKET_ALLOW_HOSTS 让客户端指向它。
 *
 * 用法：node scripts/dev/probe-plugin-market.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../..',
)
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `probe${Date.now().toString(36)}`
const CDP_PORT = 9700 + Math.floor(Math.random() * 90)
const SRV_PORT = 9600 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-market-data-${TAG}-`))
const ARTIFACTS = mkdtempSync(join(tmpdir(), `docvi-market-art-${TAG}-`))

const PLUGIN_NAME = 'probe-plugin-market'
/** 卡片上显示的是 displayName，不是包名——匹配 DOM 时必须用它 */
const PLUGIN_LABEL = '探针插件'
const PLUGIN_VERSION = '1.0.0'

let child = null
let server = null
const log = (...args) => console.log('[market]', ...args)

const manifest = {
  name: PLUGIN_NAME,
  displayName: { zh: '探针插件', en: 'Probe Plugin' },
  version: PLUGIN_VERSION,
  apiVersion: '1',
  trust: 'presentation',
  description: { zh: '用于验证市场安装链路', en: 'For verifying the market install path' },
  entry: 'dist/index.js',
  styles: ['dist/style.css'],
  repository: 'https://github.com/OneFanki/docvi',
  license: 'MIT',
  contributes: {
    components: [
      {
        kind: 'probe-box',
        title: { zh: '探针方块', en: 'Probe Box' },
        description: { zh: '一个最小的探针组件', en: 'A minimal probe component' },
      },
    ],
  },
}

/** 最小可用的呈现插件：注册一个 kind，渲染一句固定文案 */
const ENTRY_JS = `export default {
  apiVersion: '1',
  register(ctx) {
    ctx.registerComponent('probe-box', {
      title: { zh: '探针方块', en: 'Probe Box' },
      description: { zh: '一个最小的探针组件', en: 'A minimal probe component' },
      render: () => 'PROBE_BOX_RENDERED',
    })
  },
}
`
const STYLE_CSS = `.probe-box { color: rgb(1, 2, 3); }\n`

function startServer() {
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`
  const sha256 = createHash('sha256').update(manifestBody).digest('hex')
  const catalog = {
    schemaVersion: 1,
    updatedAt: '2026-10-27',
    plugins: [
      {
        name: PLUGIN_NAME,
        displayName: { zh: '探针插件', en: 'Probe Plugin' },
        version: PLUGIN_VERSION,
        description: { zh: '用于验证市场安装链路', en: 'For verifying the market install path' },
        trust: 'presentation',
        tags: ['probe'],
        repository: 'https://github.com/OneFanki/docvi',
        artifact: {
          manifest: `http://127.0.0.1:${SRV_PORT}/plugin.json`,
          sha256,
        },
      },
    ],
  }

  const routes = {
    '/market.json': JSON.stringify(catalog),
    '/plugin.json': manifestBody,
    '/dist/index.js': ENTRY_JS,
    '/dist/style.css': STYLE_CSS,
  }

  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const body = routes[path]
    if (body === undefined) {
      // 模拟 404 页面：客户端必须识别出「这是 HTML」而不是当成插件文件
      res.writeHead(404, { 'content-type': 'text/html' })
      res.end('<!DOCTYPE html><html><body>404</body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(body)
  })

  return new Promise(done => server.listen(SRV_PORT, '127.0.0.1', () => done(sha256)))
}

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
  if (child) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  server?.close()
  for (const dir of [DATA, ARTIFACTS]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 收尾失败不影响结论
    }
  }
}

async function until(client, expression, check, { attempts = 40, gap = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await sleep(gap)
    const value = await client.evaluate(expression)
    if (check(value)) return value
  }
  return null
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true })
  writeFileSync(join(ARTIFACTS, 'probe.txt'), 'artifact source', 'utf8')
  const sha256 = await startServer()
  log('产物服务已启动：', `127.0.0.1:${SRV_PORT}`, 'manifest sha256=', sha256.slice(0, 12))

  /*
   * ⚠️ 主进程输出必须收下来：安装链路的失败原因只在主进程侧，
   * stdio:'ignore' 会让它彻底消失，探针只能看到「ok 但没生效」这种哑谜。
   */
  const mainLog = []
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-probe-${TAG}`,
      DOCVI_DEBUG_PORT: String(CDP_PORT),
      // 让客户端把本机静态服务当成市场源与可信产物域
      DOCVI_MARKET_URL: `http://127.0.0.1:${SRV_PORT}/market.json`,
      DOCVI_MARKET_ALLOW_HOSTS: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  child.stdout.on('data', chunk => mainLog.push(String(chunk)))
  child.stderr.on('data', chunk => mainLog.push(String(chunk)))

  let target = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
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

  /* ---------- 场景一：清单能被拉取并解析出 artifact ---------- */

  const catalog = await client.evaluate(`window.docvi.pluginMarket({ refresh: true }).then(r => r)`)
  if (!catalog?.ok) throw new Error(`拉取市场失败：${JSON.stringify(catalog)}`)
  const entry = catalog.data.plugins.find(item => item.name === PLUGIN_NAME)
  if (!entry) {
    throw new Error(`清单里没有探针插件：${JSON.stringify(catalog.data.plugins.map(p => p.name))}`)
  }
  log('场景一通过：清单解析出', entry.name, 'artifact =', JSON.stringify(entry.artifact))
  if (!entry.artifact?.manifest) throw new Error('artifact 字段没有被解析进条目')

  /* ---------- 场景二：市场界面显示安装按钮 ---------- */

  // 打开插件面板：标题栏的「插件」图标按钮（aria-label 与 app.plugins 文案一致）
  const opened = await client.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.titlebar__icon')]
      .find(b => (b.getAttribute('aria-label') || '').includes('插件'))
    if (!btn) {
      return {
        ok: false,
        labels: [...document.querySelectorAll('.titlebar__icon')].map(b => b.getAttribute('aria-label')),
      }
    }
    btn.click()
    return { ok: true }
  })()`)
  if (!opened?.ok) throw new Error(`找不到标题栏插件入口：${JSON.stringify(opened?.labels ?? [])}`)
  await sleep(1500)

  const toMarket = await client.evaluate(`(() => {
    const tab = [...document.querySelectorAll('.tabs__item')]
      .find(b => (b.textContent || '').includes('市场'))
    if (!tab) return { ok: false, tabs: [...document.querySelectorAll('.tabs__item')].map(t => (t.textContent || '').trim()) }
    tab.click()
    return { ok: true }
  })()`)
  if (!toMarket?.ok) throw new Error(`切不到市场页签：${JSON.stringify(toMarket?.tabs ?? [])}`)
  await sleep(1500)

  const card = await until(
    client,
    `(() => {
      const card = [...document.querySelectorAll('.card--market')]
        .find(el => (el.textContent || '').includes(${JSON.stringify(PLUGIN_LABEL)}))
      if (!card) return null
      return {
        text: (card.textContent || '').slice(0, 200),
        installBtn: [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
      }
    })()`,
    value => Boolean(value),
    { attempts: 30, gap: 300 },
  )
  if (!card) {
    const diag = await client.evaluate(`(() => ({
      tabs: [...document.querySelectorAll('.tabs__item')].map(t => (t.textContent || '').trim()),
      cards: [...document.querySelectorAll('.card')].map(c => (c.textContent || '').trim().slice(0, 60)),
      empty: document.querySelector('.plugins__empty')?.textContent?.trim() ?? null,
      offline: document.querySelector('.market-offline')?.textContent?.trim() ?? null,
      url: document.querySelector('.market-head__url')?.textContent?.trim() ?? null,
      view: document.querySelector('.plugins') ? 'plugins' : (document.body.className || 'unknown'),
    }))()`)
    log('诊断：', JSON.stringify(diag))
    throw new Error('市场卡片没有出现')
  }
  log('场景二：卡片按钮 =', JSON.stringify(card.installBtn))
  if (!card.installBtn.some(label => label === '安装')) {
    throw new Error(`卡片上没有「安装」按钮：${JSON.stringify(card.installBtn)}`)
  }

  /* ---------- 场景三：点安装 → 产物落盘 → 出现在已安装 ---------- */

  const clickedInstall = await client.evaluate(`(() => {
    const card = [...document.querySelectorAll('.card--market')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(PLUGIN_LABEL)}))
    if (!card) return { ok: false, why: 'no-card' }
    const btn = [...card.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '安装')
    if (!btn) {
      return { ok: false, why: 'no-button', buttons: [...card.querySelectorAll('button')].map(b => (b.textContent || '').trim()) }
    }
    /*
     * 命中的是不是它自己：按钮被别的层盖住时 el.click() 仍会派发，但真实用户
     * 点不到。这里记录命中元素，便于区分「脚本点击无效」与「用户点不到」。
     */
    const rect = btn.getBoundingClientRect()
    const cx = Math.round(rect.left + rect.width / 2)
    const cy = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(cx, cy)
    const info = {
      disabled: btn.disabled,
      rect: { x: cx, y: cy, w: Math.round(rect.width), h: Math.round(rect.height) },
      hitTag: hit ? hit.tagName : null,
      hitIsSelfOrChild: hit === btn || btn.contains(hit),
      pointerEvents: getComputedStyle(btn).pointerEvents,
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight,
    }
    btn.click()
    return { ok: true, ...info }
  })()`)
  if (!clickedInstall?.ok) throw new Error(`点不到安装按钮：${JSON.stringify(clickedInstall)}`)
  log('按钮状态：', JSON.stringify({ ...clickedInstall, ok: undefined }))
  if (clickedInstall.disabled) throw new Error('安装按钮处于 disabled 状态，点了不会触发')

  /*
   * 点击后等安装真正完成：链路里要下载 3 个文件，再落盘、再刷新列表。
   * 120ms 只能看到「刚开始」，真正的判定要等列表出现或超时。
   */
  const landed = await until(
    client,
    `window.docvi.pluginList().then(r => r.ok ? r.data.map(p => p.name) : [])`,
    names => (names ?? []).includes(PLUGIN_NAME),
    { attempts: 60, gap: 400 },
  )
  // 成功安装后界面会自己切到「已安装」页签——用户能立刻看到装进去了
  const afterClick = await client.evaluate(`(() => {
    const activeTab = document.querySelector('.tabs__item.is-active')
    return { activeTab: activeTab ? (activeTab.textContent || '').trim() : null }
  })()`)
  log('点击后页签：', JSON.stringify(afterClick))
  log('安装结果：', Boolean(landed))
  if (landed && !afterClick.activeTab?.includes('已安装')) {
    throw new Error(`安装成功但没有切到「已安装」页签：${JSON.stringify(afterClick.activeTab)}`)
  }

  const installedDir = join(DATA, 'plugins', PLUGIN_NAME, PLUGIN_VERSION)
  if (!landed) {
    /*
     * 关键诊断：点击可能根本没触发（按钮引用取到的是旧 vdom 节点），也可能
     * 安装在进行中。分别用「直接 IPC 安装」与「再点一次」区分。
     */
    const direct = await client.evaluate(`(() => {
      return window.docvi.pluginMarket({ refresh: false }).then(r => {
        const hit = r.ok ? r.data.plugins.find(p => p.name === ${JSON.stringify(PLUGIN_NAME)}) : null
        if (!hit) return { step: 'no-entry' }
        return window.docvi.pluginInstallFromMarket(hit).then(installed => ({
          step: 'after-direct',
          ok: installed.ok,
          error: installed.ok ? null : installed.error,
          names: installed.ok ? installed.data.map(p => p.name) : null,
        }))
      })
    })()`)
    log('IPC 直调结果：', JSON.stringify(direct).slice(0, 400))
    const files = existsSync(join(DATA, 'plugins'))
      ? readdirSync(join(DATA, 'plugins'), { recursive: true }).map(String)
      : []
    log('磁盘实际：', JSON.stringify(files.slice(0, 12)))
    const err = await client.evaluate(
      `document.querySelector('.plugins__error')?.textContent?.trim() ?? null`,
    )
    log('主进程输出（末尾 20 行）：')
    for (const line of mainLog.join('').split('\n').slice(-20)) {
      if (line.trim()) log('  |', line.trim())
    }
    throw new Error(`安装没有生效。界面报错：${JSON.stringify(err)}`)
  }
  log('场景三通过：插件已进入已安装列表')

  /* ---------- 场景四：磁盘上确实落到了 <name>/<version>/ ---------- */

  if (!existsSync(installedDir)) {
    const actual = existsSync(join(DATA, 'plugins'))
      ? readdirSync(join(DATA, 'plugins'), { recursive: true })
      : []
    throw new Error(`产物没有落到 ${installedDir}；实际：${JSON.stringify(actual)}`)
  }
  const files = readdirSync(installedDir, { recursive: true }).map(String)
  log('落盘文件：', JSON.stringify(files))
  for (const need of ['plugin.json', join('dist', 'index.js'), join('dist', 'style.css')]) {
    if (!files.some(f => f.replaceAll('\\', '/').endsWith(need.replaceAll('\\', '/')))) {
      throw new Error(`落盘缺少 ${need}；实际：${JSON.stringify(files)}`)
    }
  }
  // manifest 内容要原样落地（含 contributes），否则插件加载不到组件
  const written = JSON.parse(readFileSync(join(installedDir, 'plugin.json'), 'utf8'))
  if (written.name !== PLUGIN_NAME || written.version !== PLUGIN_VERSION) {
    throw new Error(`落盘 manifest 不对：${JSON.stringify(written).slice(0, 200)}`)
  }
  log('场景四通过：manifest 与产物文件都已落位')

  /* ---------- 场景五：篡改防护——清单 sha256 不符时必须拒绝 ---------- */

  const tampered = await client.evaluate(`(() => {
    const bad = {
      name: ${JSON.stringify(PLUGIN_NAME)},
      version: ${JSON.stringify(PLUGIN_VERSION)},
      artifact: {
        manifest: 'http://127.0.0.1:${SRV_PORT}/plugin.json',
        sha256: 'deadbeef'.repeat(8),
      },
    }
    return window.docvi.pluginInstallFromMarket(bad).then(r => r)
  })()`)
  log('篡改场景返回：', JSON.stringify(tampered).slice(0, 160))
  if (tampered?.ok) throw new Error('校验值不符时竟然安装成功了')

  /*
   * 404 防护：把 manifest 指向一个不存在的路径，服务端会返回 HTML 404 页。
   * 客户端必须识别出「这是网页」而不是把它当 manifest 解析。
   */
  const missing = await client.evaluate(`(() => {
    const bad = {
      name: ${JSON.stringify(PLUGIN_NAME)},
      version: ${JSON.stringify(PLUGIN_VERSION)},
      artifact: { manifest: 'http://127.0.0.1:${SRV_PORT}/no-such-file.json' },
    }
    return window.docvi.pluginInstallFromMarket(bad).then(r => r)
  })()`)
  log('404 场景返回：', JSON.stringify(missing).slice(0, 200))
  if (missing?.ok) throw new Error('404 页面竟然被当成插件装进来了')

  log('场景五通过：篡改与 404 都被拒绝')

  log('全部断言通过')
  client.close()
}

main()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch(error => {
    console.error('[market] 失败：', error.message)
    cleanup()
    process.exit(1)
  })
