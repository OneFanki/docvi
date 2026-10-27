#!/usr/bin/env node
/**
 * 一次性功能探针：验证「目录结构随磁盘自动更新」。
 *
 * 用户的诉求是「AI 写代码我肯定要实时看到，不可能每次都手动刷新」。所以这里
 * 全程**不点任何刷新按钮**，只从磁盘侧改文件，断言界面自己跟上：
 *
 *   1. 新建 .md → 侧栏出现，且能被全库搜索搜到（索引也重建了）；
 *   2. 新建子目录 + 其中的 .md → 目录行与文档行都出现；
 *   3. 删除 .md → 侧栏消失；
 *   4. 后台标签里打开的文档被外部改写 → 切回去看到新内容；
 *   5. .git 目录抖动不触发整树重扫（不能把 git status 的写入当内容变化）。
 *
 * 用法：node scripts/dev/probe-workspace-live.mjs   （需先 pnpm docvi:build）
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const TAG = `probe${Date.now().toString(36)}`
const PORT = 9900 + Math.floor(Math.random() * 90)
const DATA = mkdtempSync(join(tmpdir(), `docvi-live-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-live-ws-${TAG}-`))

const DOC_A = join(WS, '甲文档.md')
const DOC_B = join(WS, '乙文档.md')
const NEW_DOC = join(WS, '丙新增.md')
const NEW_DIR = join(WS, '新目录')
const NEW_IN_DIR = join(NEW_DIR, '目录内文档.md')

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

/** 当前侧栏树里的全部相对路径 */
const TREE_PATHS = `[...document.querySelectorAll('[data-tree-path]')].map(el => el.dataset.treePath)`

/** 阅读区正文 */
const READ_BODY = `(() => {
  const doc = document.querySelector('.at-doc')
  if (doc) return doc.textContent || ''
  const cm = document.querySelector('.cm-content')
  return cm ? cm.textContent || '' : null
})()`

/** 轮询直到断言成立，返回命中的值；超时返回 null */
async function until(client, expression, check, { attempts = 40, gap = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await sleep(gap)
    const value = await client.evaluate(expression)
    if (check(value)) return value
  }
  return null
}

async function openTreeDoc(client, name) {
  const clicked = await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith(${JSON.stringify(name)}))
    if (!row) return { ok: false, paths: ${TREE_PATHS} }
    row.click()
    return { ok: true }
  })()`)
  if (!clicked?.ok) throw new Error(`找不到文档 ${name}：${JSON.stringify(clicked?.paths ?? [])}`)
  await sleep(2200)
}

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC_A, '# 甲文档\n\n甲的第一版内容。\n', 'utf8')
  writeFileSync(DOC_B, '# 乙文档\n\n乙的第一版内容。\n', 'utf8')

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

  const initial = await client.evaluate(TREE_PATHS)
  log('初始树：', JSON.stringify(initial))
  if (!initial?.some(p => p.endsWith('甲文档.md'))) throw new Error('初始树里没有甲文档')

  /* ---------- 场景一：AI 新建文档 → 侧栏自己出现 ---------- */

  writeFileSync(NEW_DOC, '# 丙新增\n\n这是外部新建的文档，含独特关键词 zeta-new-doc。\n', 'utf8')
  log('已从外部新建 丙新增.md，等待侧栏出现…')
  const appeared = await until(client, TREE_PATHS, paths =>
    (paths ?? []).some(p => p.endsWith('丙新增.md')),
  )
  if (!appeared) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`新建文件没有自动出现在侧栏：${JSON.stringify(now)}`)
  }
  log('场景一通过：新建文档自动出现在侧栏')

  /* ---------- 场景二：全库搜索能搜到新文档（索引已重建） ---------- */

  await client.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  })()`)
  await sleep(600)
  // 搜索框是面板里的输入框，用原生 setter 触发 v-model
  await client.evaluate(`(() => {
    const input = document.querySelector('.palette__input') || document.querySelector('.palette input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'zeta-new-doc')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  const hitTitles = await until(
    client,
    `[...document.querySelectorAll('.palette__doc-title, .palette__doc-path')].map(el => el.textContent.trim())`,
    titles => (titles ?? []).some(title => title.includes('丙新增')),
    { attempts: 40, gap: 250 },
  )
  log('搜索命中：', JSON.stringify(hitTitles))
  if (!hitTitles) {
    const diag = await client.evaluate(`(() => {
      const panel = document.querySelector('.palette')
      return {
        open: Boolean(panel),
        empty: document.querySelector('.palette__empty')?.textContent?.trim() ?? null,
        foot: document.querySelector('.palette__foot')?.textContent?.trim() ?? null,
        input: document.querySelector('.palette__input')?.value ?? null,
        rows: [...document.querySelectorAll('.palette__doc-title')].map(el => el.textContent.trim()),
      }
    })()`)
    log('诊断：', JSON.stringify(diag))
    throw new Error('新文档没有被搜索索引收录（作废后没有重建）')
  }
  log('场景二通过：索引随目录变化重建')

  // 关掉面板
  await client.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })()`)
  await sleep(500)

  /* ---------- 场景三：新建子目录 + 文档 → 两级都出现 ---------- */

  mkdirSync(NEW_DIR, { recursive: true })
  await sleep(700)
  writeFileSync(NEW_IN_DIR, '# 目录内文档\n\n子目录里的内容。\n', 'utf8')
  log('已新建子目录与其文档，等待侧栏出现…')
  const dirAppeared = await until(client, TREE_PATHS, paths =>
    (paths ?? []).some(p => p.endsWith('新目录')),
  )
  if (!dirAppeared) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`新建目录没有出现在侧栏：${JSON.stringify(now)}`)
  }
  // 目录默认不展开：展开它再看文档行
  await client.evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-tree-path]')]
      .find(el => (el.dataset.treePath || '').endsWith('新目录'))
    row?.click()
  })()`)
  await sleep(800)
  const childRow = await until(client, TREE_PATHS, paths =>
    (paths ?? []).some(p => p.endsWith('目录内文档.md')),
  )
  if (!childRow) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`子目录里的文档没有出现在侧栏：${JSON.stringify(now)}`)
  }
  log('场景三通过：新建目录与其中的文档都出现了')

  /* ---------- 场景四：删除文档 → 侧栏消失 ---------- */

  unlinkSync(NEW_DOC)
  log('已删除 丙新增.md，等待侧栏移除…')
  const removed = await until(
    client,
    TREE_PATHS,
    paths => !(paths ?? []).some(p => p.endsWith('丙新增.md')),
  )
  if (!removed) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`删除后侧栏仍留着该文档：${JSON.stringify(now)}`)
  }
  log('场景四通过：删除的文档从侧栏移除')

  /* ---------- 场景五：后台标签里的文档也要跟上 ---------- */

  // 当前标签打开甲
  await openTreeDoc(client, '甲文档.md')
  const bodyA = await client.evaluate(READ_BODY)
  if (!bodyA?.includes('甲的第一版内容')) throw new Error('甲文档没有打开成功')

  // 再开一个标签（同一个工作区）打开乙 → 甲成为后台标签。工作区卡片在文档库视图里，
  // 得先切回文档库标签
  await client.evaluate(`(() => {
    document.querySelector('.tab--library')?.click()
  })()`)
  await sleep(1200)
  await client.evaluate(`(() => {
    const cards = [...document.querySelectorAll('.card')]
    const hit = cards.find(el => (el.textContent || '').includes(${JSON.stringify(WS)}))
    hit?.click()
  })()`)
  await sleep(2500)
  await openTreeDoc(client, '乙文档.md')
  const bodyB = await client.evaluate(READ_BODY)
  if (!bodyB?.includes('乙的第一版内容')) throw new Error('乙文档没有打开成功')

  // 改写后台标签里的甲
  writeFileSync(DOC_A, '# 甲文档\n\n甲被外部改成了第二版。\n', 'utf8')
  log('已从外部改写后台标签里的甲文档，等待缓冲区跟上…')
  await sleep(2600)

  // 切回第一个标签（标签条最左边的非文档库标签）
  const switched = await client.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.tab')]
    const target = tabs.find(el => (el.textContent || '').includes('甲文档'))
    if (!target) return { ok: false, labels: tabs.map(t => (t.textContent || '').trim()) }
    target.click()
    return { ok: true }
  })()`)
  if (!switched?.ok) throw new Error(`找不到甲文档标签：${JSON.stringify(switched?.labels ?? [])}`)
  const refreshed = await until(
    client,
    READ_BODY,
    body => Boolean(body && body.includes('甲被外部改成了第二版')),
    { attempts: 20, gap: 250 },
  )
  if (!refreshed) {
    const now = await client.evaluate(READ_BODY)
    throw new Error(`后台标签没有跟上磁盘内容：${JSON.stringify(now)}`)
  }
  log('场景五通过：后台标签的缓冲区也跟上了磁盘')

  /* ---------- 场景六：.git 里的写入不该触发整树重扫 ---------- */

  /*
   * 判定方式不是「看有没有重扫」而是**副作用可见性**：往 .git 里连写文件，
   * 若监视器没过滤，界面上不会有任何差别——所以改用「树引用是否被替换」的
   * 可观测证据：记下当前 --depth 的内联样式对象？Vue 复用 DOM，不可靠。
   *
   * 换个可靠口径：让树处于「展开了一个只能存在于磁盘的路径」的状态是做不到的，
   * 于是改为断言协议层：主进程的 isContentRelPath 已在单测里钉住（见
   * scripts/workspace-change.test.mjs）。这里只确认 .git 写入**不破坏**界面。
   */
  mkdirSync(join(WS, '.git'), { recursive: true })
  for (let i = 0; i < 20; i += 1) {
    writeFileSync(join(WS, '.git', `obj-${i}`), String(i), 'utf8')
  }
  await sleep(1500)
  const stillOk = await client.evaluate(TREE_PATHS)
  if (!stillOk?.some(p => p.endsWith('甲文档.md'))) {
    throw new Error(`.git 写入后树坏了：${JSON.stringify(stillOk)}`)
  }
  log('场景六通过：.git 写入不影响内容树（过滤规则另由单测钉住）')

  /* ---------- 场景七：已打开的文档被外部删除 → 明确告知，不留假象 ---------- */

  unlinkSync(DOC_A)
  log('已删除正在打开的甲文档，等待提示…')
  const goneToast = await until(
    client,
    `document.querySelector('.toast__text')?.textContent?.trim() ?? null`,
    text => Boolean(text && text.includes('已从磁盘删除')),
    { attempts: 30, gap: 250 },
  )
  if (!goneToast) {
    const now = await client.evaluate(`document.querySelector('.toast__text')?.textContent ?? null`)
    throw new Error(`打开中的文档被删除后没有提示：${JSON.stringify(now)}`)
  }
  log('场景七通过：提示 =', JSON.stringify(goneToast))

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
