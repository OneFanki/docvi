#!/usr/bin/env node
/**
 * 更新弹窗的端到端验证。
 *
 * 用本地 HTTP 服务冒充发布清单（`DOCVI_UPDATE_MANIFEST_URL` 可覆盖地址），
 * 让主进程在启动 8 秒后真的"发现新版本"，然后检查：
 *  1. 弹窗真的弹出来了（后台检查 → 主进程事件 → 渲染层订阅这条链通了）；
 *  2. 摘要只显示短摘要，不是整篇 changelog；
 *  3. 点「以后再说」把**版本号**写进设置，且该版本之后不再弹；
 *  4. 关掉自动检查开关后不再弹。
 *
 * 为什么不用线上真实清单：那需要真的存在一个更高版本，而发版节奏不允许
 * 每次验证都先发一版。伪造清单是这条链唯一可控的驱动方式。
 *
 * 用法：node scripts/dev/probe-update-dialog.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `dlg${Date.now().toString(36)}`
const PORT = 9200 + Math.floor(Math.random() * 60)
const MANIFEST_PORT = 5000 + Math.floor(Math.random() * 400)
const DATA = mkdtempSync(join(tmpdir(), `docvi-dlg-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-dlg-ws-${TAG}-`))

/**
 * 比当前构建版本高，保证必然被判为 outdated。
 *
 * 用真实存在的 `v0.8.0` 而不是虚构版本号：资产来自 GitHub Release API
 * （按版本号查，与清单地址无关），所以只有真实存在的 tag 才能拿到本平台
 * 安装包，「下载」按钮才可用——Proxy 那条路径要验的正是真实下载入口。
 *
 * 为了让 0.8.0 高于「当前版本」，探针会把应用复制到临时目录并把
 * package.json 的 version 降到 0.7.0（见 prepareAppCopy）。
 */
const FAKE_VERSION = '0.8.0'
/** 副本里声明的版本：低于 FAKE_VERSION 才能被判成「有新版本」 */
const COPY_VERSION = '0.7.0'
const NOTES_ZH =
  '- 第一条：这是摘要的第一行\n- 第二条：这是摘要的第二行\n- 第三条：这是摘要的第三行'

let child = null
let manifest = null
/** 临时应用副本，收尾时一并删除 */
const appCopies = []
const log = (...args) => console.log('[dialog]', ...args)

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
        pending.set(id, done)
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
  if (manifest) {
    manifest.close()
    manifest = null
  }
  for (const dir of [DATA, WS, ...appCopies]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    } catch {
      // 忽略
    }
  }
}

const failures = []
function check(name, ok, detail) {
  log(`${ok ? '✓' : '❗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/**
 * 假的 Release 列表：模拟「用户从 COPY_VERSION 连跳三版」。
 *
 * 顺序故意打乱（GitHub 通常倒序，但契约不保证），验证代码真的按版本号排序。
 * 每条带中英双段摘要 + 一段「完整变更」明细，用来验证摘要截断。
 */
const FAKE_RELEASES = [
  {
    tag_name: `v${FAKE_VERSION}`,
    html_url: `http://127.0.0.1:${MANIFEST_PORT}/release/${FAKE_VERSION}`,
    published_at: '2026-11-18T00:00:00Z',
    prerelease: false,
    draft: false,
    body: `### 中文\n\n- 最新版摘要 A\n- 最新版摘要 B\n\n#### 完整变更\n\n- 这条明细不该出现在弹窗里\n\n### English\n\n- latest summary A\n- latest summary B\n\n#### Full changelog\n\n- this detail must stay out`,
    // 给一份真实可下载的资产：保住「下载」按钮，才能继续验 Proxy 那条路径
    assets: [
      {
        name: 'docvi-0.8.0-win-x64-setup.exe',
        browser_download_url:
          'https://github.com/OneFanki/docvi/releases/download/v0.8.0/docvi-0.8.0-win-x64-setup.exe',
        size: 118051879,
        digest: 'sha256:473ea40fd4bd7c45b529b6ace9f9ed9d623f913635f080badad3b0b73ec025d9',
      },
    ],
  },
  {
    tag_name: 'v0.7.5',
    html_url: `http://127.0.0.1:${MANIFEST_PORT}/release/0.7.5`,
    published_at: '2026-11-10T00:00:00Z',
    prerelease: false,
    draft: false,
    body: `### 中文\n\n- 中间版摘要\n\n### English\n\n- middle summary`,
    assets: [],
  },
  {
    tag_name: 'v0.7.1',
    html_url: `http://127.0.0.1:${MANIFEST_PORT}/release/0.7.1`,
    published_at: '2026-11-05T00:00:00Z',
    prerelease: false,
    draft: false,
    body: `### 中文\n\n- 最旧一版摘要\n\n### English\n\n- oldest summary`,
    assets: [],
  },
  {
    // 预发布：不该出现在区间里
    tag_name: 'v0.7.9',
    prerelease: true,
    draft: false,
    body: `### 中文\n\n- 预发布不该出现\n\n### English\n\n- prerelease must not appear`,
    assets: [],
  },
  {
    // 等于当前版本：不该出现
    tag_name: `v${COPY_VERSION}`,
    prerelease: false,
    draft: false,
    body: `### 中文\n\n- 当前版本不该出现\n\n### English\n\n- current version must not appear`,
    assets: [],
  },
]

/** 启动本地清单服务：给出一个必然更高的版本 */
async function startManifest() {
  manifest = createServer((request, response) => {
    if (request.url?.startsWith('/latest.json')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          version: FAKE_VERSION,
          downloadUrl: `http://127.0.0.1:${MANIFEST_PORT}/releases`,
          notes: NOTES_ZH,
          homepage: `http://127.0.0.1:${MANIFEST_PORT}/`,
        }),
      )
      return
    }
    if (request.url?.startsWith('/releases')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(FAKE_RELEASES))
      return
    }
    response.writeHead(404)
    response.end('{}')
  })
  await new Promise(done => manifest.listen(MANIFEST_PORT, '127.0.0.1', done))
  log(`清单服务: http://127.0.0.1:${MANIFEST_PORT}/latest.json`)
  log(`Release 列表: http://127.0.0.1:${MANIFEST_PORT}/releases`)
}

/**
 * 把应用复制到临时目录并把声明版本降到 COPY_VERSION。
 *
 * 只复制必要文件（package.json + out/），27MB 左右，比整仓复制快得多。
 * 复制而不是原地改：探针绝不能改动工作区里受版本控制的文件。
 */
function prepareAppCopy() {
  const dest = mkdtempSync(join(tmpdir(), `docvi-dlg-app-${TAG}-`))
  cpSync(join(APP_DIR, 'out'), join(dest, 'out'), { recursive: true })
  const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'))
  pkg.version = COPY_VERSION
  writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8')
  appCopies.push(dest)
  return dest
}

async function launch(appDir = APP_DIR) {
  child = spawn(ELECTRON, [appDir, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: DATA,
      DOCVI_INSTANCE: `docvi-dlg-${TAG}`,
      DOCVI_DEBUG_PORT: String(PORT),
      DOCVI_UPDATE_MANIFEST_URL: `http://127.0.0.1:${MANIFEST_PORT}/latest.json`,
      DOCVI_RELEASES_API_URL: `http://127.0.0.1:${MANIFEST_PORT}/releases`,
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
  return connect(target.webSocketDebuggerUrl)
}

function killApp() {
  if (!child) return
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  child = null
}

/**
 * 等弹窗出现。
 *
 * 后台检查在启动后 8 秒触发，加一次 HTTP 往返 + 一次 GitHub API 往返
 * （取资产），给 25 秒上限足够宽松。
 */
async function waitForDialog(client, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(600)
    const state = await client.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (!dialog) return null
      const title = dialog.querySelector('h2')?.textContent?.trim() ?? ''
      // 跨版本时按版本分段；每段有版本号标题与若干条摘要
      const releases = [...dialog.querySelectorAll('.release')].map(section => ({
        version: section.querySelector('.release__version')?.textContent?.trim() ?? '',
        lines: [...section.querySelectorAll('.notes li')].map(el => el.textContent.trim()),
      }))
      const omitted = dialog.querySelector('.omitted')?.textContent?.trim() ?? null
      return {
        title,
        releases,
        omitted,
        text: (dialog.textContent || '').slice(0, 600),
      }
    })()`)
    if (state) {
      log(`${label} 弹窗出现: ${JSON.stringify(state.title)}`)
      return state
    }
  }
  return null
}

async function main() {
  writeFileSync(join(WS, '占位.md'), '# 占位\n', 'utf8')
  await startManifest()

  /*
   * 复制一份应用到临时目录，把版本号降到 COPY_VERSION。
   *
   * 为什么必须这么做：`checkForUpdate` 拿 `app.getVersion()`（来自
   * apps/desktop/package.json）当当前版本。仓库里是 0.8.1，而线上最新的真实
   * Release 也是 0.8.1——不降版本就永远「已是最新」，弹窗不会出现，
   * 「下载」这条路更没机会走。伪造版本号做不到（资产 API 按 tag 查），
   * 所以只能伪造"当前版本"。
   */
  const appCopy = prepareAppCopy()
  log(`应用副本: ${appCopy}（声明版本 ${COPY_VERSION}）`)

  /* ---------- 第一段：默认设置下应当弹窗 ---------- */
  let client = await launch(appCopy)
  await sleep(3000)
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const first = await waitForDialog(client, '首次启动')
  check('后台检查发现了新版本并弹出提示', first !== null, first?.title ?? '25 秒内没出现')
  if (!first) {
    client.close()
    return
  }
  check('弹窗显示版本号', first.title.includes(FAKE_VERSION), `标题=${first.title}`)

  /*
   * 跨版本展示：从 0.7.0 到 0.8.0 之间有三个稳定版本（0.7.1 / 0.7.5 / 0.8.0），
   * 另有 0.7.9 是预发布、0.7.0 等于当前版本——这两条都不该出现。
   * 顺序必须是旧→新（读下来是「你错过的东西」）。
   */
  check(
    '按版本分段列出，旧→新',
    JSON.stringify(first.releases.map(item => item.version)) ===
      JSON.stringify(['0.7.1', '0.7.5', FAKE_VERSION]),
    JSON.stringify(first.releases.map(item => item.version)),
  )
  check(
    '每版都带自己的摘要（不是只有最新一版）',
    first.releases.length === 3 && first.releases.every(item => item.lines.length > 0),
    first.releases.map(item => `${item.version}:${item.lines.length}条`).join(' / '),
  )
  check(
    '预发布版本不出现在区间里',
    !first.releases.some(item => item.version === '0.7.9'),
    JSON.stringify(first.releases.map(item => item.version)),
  )
  check(
    '等于当前版本的条目不出现在区间里',
    !first.releases.some(item => item.version === COPY_VERSION),
    JSON.stringify(first.releases.map(item => item.version)),
  )
  check(
    '「完整变更」的明细没有被塞进弹窗',
    !first.text.includes('这条明细不该出现在弹窗里'),
    first.text.includes('这条明细') ? '明细泄漏了' : '未泄漏',
  )

  /* ---------- 第二段：真实点「下载」，验证响应式对象能跨 contextBridge ---------- */
  const downloadUi = await client.evaluate(`(async () => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    const btn = [...(dialog?.querySelectorAll('button') ?? [])]
      .find(b => /^下载 0\\./.test((b.textContent || '').trim()))
    if (!btn) {
      return {
        found: false,
        buttons: [...(dialog?.querySelectorAll('button') ?? [])]
          .map(b => (b.textContent || '').trim())
          .filter(Boolean),
      }
    }
    btn.click()
    // contextBridge 克隆 + IPC 往返 + 主进程发起请求
    await new Promise(r => setTimeout(r, 3500))
    const text = document.querySelector('[role="dialog"][aria-modal="true"]')?.textContent ?? ''
    return {
      found: true,
      cloned: text.includes('could not be cloned'),
      errorShown: text.includes('更新失败'),
      snippet: text.slice(0, 300),
    }
  })()`)
  log(`弹窗里点下载: ${JSON.stringify(downloadUi)}`)
  check(
    '弹窗里有「下载 x.y.z」按钮（资产取到了）',
    downloadUi.found === true,
    downloadUi.found ? '' : `按钮=${JSON.stringify(downloadUi.buttons)}`,
  )
  if (downloadUi.found) {
    check(
      '点下载不再报 An object could not be cloned.',
      downloadUi.cloned === false,
      downloadUi.cloned ? '仍然报克隆错误' : '无克隆错误',
    )
  }
  /* 收尾：中止这次下载，别留 100MB 的临时文件 */
  await client.evaluate('window.docvi.appUpdateCancel()')
  await sleep(1500)

  /* ---------- 第三段：点「以后再说」应当记住版本号 ---------- */
  const dismissed = await client.evaluate(`(async () => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    const btn = [...(dialog?.querySelectorAll('button') ?? [])]
      .find(b => (b.textContent || '').trim() === '以后再说')
    if (!btn) return { clicked: false }
    btn.click()
    await new Promise(r => setTimeout(r, 800))
    return { clicked: true, stillOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')) }
  })()`)
  log(`点以后再说: ${JSON.stringify(dismissed)}`)
  check('点「以后再说」关闭了弹窗', dismissed.clicked && !dismissed.stillOpen)

  const savedVersion = await client.evaluate(
    `window.docvi.settingsRead().then(r => r.ok ? r.data.dismissedUpdateVersion : null)`,
  )
  check(
    '忽略的是版本号而不是布尔',
    savedVersion === FAKE_VERSION,
    `settings.dismissedUpdateVersion=${JSON.stringify(savedVersion)}`,
  )

  client.close()
  killApp()
  await sleep(1500)

  /* ---------- 第三段：重启后同一版本不再弹 ---------- */
  client = await launch(appCopy)
  await sleep(3000)
  const second = await waitForDialog(client, '忽略后重启')
  check(
    '点了「以后再说」之后，同一版本不再弹',
    second === null,
    second ? `又弹了：${second.title}` : '25 秒内没弹（正确）',
  )
  client.close()
  killApp()
  await sleep(1500)

  /* ---------- 第四段：关掉开关后不再弹 ---------- */
  // 直接改设置文件：模拟用户在关于页关掉了自动检查
  const settingsPath = join(DATA, 'settings.json')
  if (existsSync(settingsPath)) {
    const current = JSON.parse(readFileSync(settingsPath, 'utf8'))
    current.autoCheckUpdates = false
    current.dismissedUpdateVersion = ''
    writeFileSync(settingsPath, JSON.stringify(current, null, 2), 'utf8')
    log('已把 autoCheckUpdates 置为 false（并清掉忽略版本）')
  } else {
    log('❗ 没找到 settings.json，无法验证开关')
    failures.push('设置文件不存在')
  }

  client = await launch(appCopy)
  await sleep(3000)
  const third = await waitForDialog(client, '关闭自动检查后')
  check(
    '关掉「启动时检查更新」后不再弹',
    third === null,
    third ? `仍然弹了：${third.title}` : '25 秒内没弹（正确）',
  )
  client.close()
}

main()
  .catch(error => {
    log('失败:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    cleanup()
    if (failures.length) {
      log(`\n未通过 ${failures.length} 项：${failures.join('；')}`)
      process.exitCode = 1
    } else {
      log('\n全部通过')
    }
  })
