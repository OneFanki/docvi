#!/usr/bin/env node
/**
 * 一次性功能探针：验证目录树的空目录可见性、工具栏、批量选中与拖拽移动。
 *
 * 2026-10-28 目录树改造的验收链路，全部走真实 UI（不是直调 store）：
 *
 *   1. 应用内右键新建**空文件夹** → 立刻出现在树里（此前被扫描器剔除，
 *      「创建成功但看不见」）；再次新建同名 → 出现重名错误；
 *   2. 树头部有三个工具按钮（定位当前文档 / 展开所选 / 全部收起）；
 *   3. 全部收起后当前文档行消失，点「定位」它回到可见；
 *   4. Ctrl+点击批量选中（is-checked），普通点击重置选区；
 *   5. 拖拽文档到目录 → 弹确认框 → 确认后真的移动；取消则原地不动。
 *
 * 用法：node scripts/dev/probe-doc-tree.mjs   （需先 pnpm docvi:build）
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
const DATA = mkdtempSync(join(tmpdir(), `docvi-tree-data-${TAG}-`))
const WS = mkdtempSync(join(tmpdir(), `docvi-tree-ws-${TAG}-`))

const DOC_A = join(WS, '甲文档.md')
const DOC_B = join(WS, '乙文档.md')
const NEW_DIR_NAME = '探针新目录'

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
      return new Promise(done2 => {
        const id = ++nextId
        pending.set(id, message => done2(message.result))
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

const TREE_PATHS = `[...document.querySelectorAll('[data-tree-path]')].map(el => el.dataset.treePath)`

/** 轮询直到断言成立，返回命中的值；超时返回 null */
async function until(client, expression, check, { attempts = 40, gap = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await sleep(gap)
    const value = await client.evaluate(expression)
    if (check(value)) return value
  }
  return null
}

function rowSelector(suffix) {
  return `[...document.querySelectorAll('[data-tree-path]')].find(el => (el.dataset.treePath || '').endsWith(${JSON.stringify(suffix)}))`
}

/** 右键某行并点击菜单项（菜单 teleport 到 body） */
async function contextMenu(client, pathSuffix, label) {
  const fired = await client.evaluate(`(() => {
    const row = ${rowSelector(pathSuffix)}
    if (!row) return { ok: false }
    const rect = row.getBoundingClientRect()
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 5,
    }))
    return { ok: true }
  })()`)
  if (!fired?.ok) throw new Error(`右键目标行不存在：${pathSuffix}`)
  await sleep(500)
  const clicked = await client.evaluate(`(() => {
    const item = [...document.querySelectorAll('.menu__item')]
      .find(el => (el.textContent || '').includes(${JSON.stringify(label)}))
    if (!item) return { ok: false, items: [...document.querySelectorAll('.menu__item')].map(el => el.textContent.trim()) }
    item.click()
    return { ok: true }
  })()`)
  if (!clicked?.ok) throw new Error(`菜单项不存在：${label}（${JSON.stringify(clicked?.items)}）`)
  await sleep(400)
}

/** 在 PromptDialog 里输入名字并确认 */
async function confirmPrompt(client, value) {
  const done = await client.evaluate(`(() => {
    const input = document.querySelector('.dialog__input')
    if (!input) return { ok: false }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, ${JSON.stringify(value)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const confirm = [...document.querySelectorAll('.dialog__actions .btn')]
      .find(el => !(el.className || '').includes('btn--ghost'))
    confirm?.click()
    return { ok: true }
  })()`)
  if (!done?.ok) throw new Error('输入对话框没出现')
  await sleep(1200)
}

/** 合成一条树内拖拽：dragstart(源行) → dragover/drop(目标行)，带真实 DataTransfer */
async function dragRow(client, fromSuffix, toSuffix) {
  const result = await client.evaluate(`(() => {
    const from = ${rowSelector(fromSuffix)}
    const to = ${rowSelector(toSuffix)}
    if (!from || !to) return { ok: false, paths: ${TREE_PATHS} }
    const dt = new DataTransfer()
    const rect = to.getBoundingClientRect()
    const opts = { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 5 }
    from.dispatchEvent(new DragEvent('dragstart', { ...opts, dataTransfer: dt }))
    to.dispatchEvent(new DragEvent('dragover', { ...opts, dataTransfer: dt }))
    to.dispatchEvent(new DragEvent('drop', { ...opts, dataTransfer: dt }))
    from.dispatchEvent(new DragEvent('dragend', { ...opts, dataTransfer: dt }))
    return { ok: true }
  })()`)
  if (!result?.ok)
    throw new Error(
      `拖拽目标不存在：${fromSuffix} → ${toSuffix}（${JSON.stringify(result?.paths)}）`,
    )
  await sleep(600)
}

async function main() {
  mkdirSync(WS, { recursive: true })
  writeFileSync(DOC_A, '# 甲文档\n\n甲的内容。\n', 'utf8')
  writeFileSync(DOC_B, '# 乙文档\n\n乙的内容。\n', 'utf8')

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
    if (!hit) return { ok: false }
    hit.click()
    return { ok: true }
  })()`)
  if (!opened?.ok) throw new Error('找不到工作区卡片')
  await sleep(3000)

  /* ---------- 场景一：应用内右键新建空文件夹 → 立刻可见且展开 ---------- */

  await contextMenu(client, '甲文档.md', '新建目录')
  await confirmPrompt(client, NEW_DIR_NAME)
  const dirRow = await until(
    client,
    `(() => { const el = ${rowSelector(NEW_DIR_NAME)}; return el ? el.className : null })()`,
    name => Boolean(name),
  )
  if (!dirRow) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`新建的空目录没有出现在树里：${JSON.stringify(now)}`)
  }
  log('场景一通过：空目录创建后立刻可见，类名 =', JSON.stringify(dirRow))

  // 空目录行也要有可点的折叠箭头（isDir 才有 chevron）
  const hasChevron = await client.evaluate(
    `(() => { const el = ${rowSelector(NEW_DIR_NAME)}; return el ? Boolean(el.querySelector('.chevron')) : null })()`,
  )
  if (!hasChevron) throw new Error('空目录没有折叠箭头')
  log('场景一补充：空目录有折叠箭头')

  // 同名再建一次：store 把 E_EXISTS 转成错误 toast（对话框本身无输入校验重名）
  await contextMenu(client, '甲文档.md', '新建目录')
  await confirmPrompt(client, NEW_DIR_NAME)
  const dupError = await until(
    client,
    `document.querySelector('.toast__text')?.textContent?.trim() ?? null`,
    text => Boolean(text && (text.includes('占用') || text.includes('同名'))),
    { attempts: 12, gap: 250 },
  )
  if (!dupError) {
    const now = await client.evaluate(`document.querySelector('.toast__text')?.textContent ?? null`)
    throw new Error(`重名创建没有报错提示：${JSON.stringify(now)}`)
  }
  log('场景一补充：重名提示 =', JSON.stringify(dupError))
  // 关掉对话框
  await client.evaluate(`(() => {
    const cancel = [...document.querySelectorAll('.dialog__actions .btn')]
      .find(el => (el.className || '').includes('btn--ghost'))
    cancel?.click()
    document.querySelector('.scrim')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })()`)
  await sleep(600)

  /* ---------- 场景二：树头部三个工具按钮存在 ---------- */

  const tools = await client.evaluate(
    `['定位当前文档', '展开所选', '全部收起'].map(label => {
      const btn = document.querySelector('.tree__tools button[aria-label="' + label + '"]')
      return { label, present: Boolean(btn), disabled: btn?.disabled ?? null }
    })`,
  )
  if (tools.some(item => !item.present)) {
    throw new Error(`工具按钮缺失：${JSON.stringify(tools)}`)
  }
  log('场景二通过：', JSON.stringify(tools))

  /* ---------- 场景三：全部收起 → 定位找回当前文档 ---------- */

  // 打开甲文档（当前文档行高亮的来源），展开层级的祖先链已在打开时自动展开
  await client.evaluate(`(() => { ${rowSelector('甲文档.md')}?.click() })()`)
  await sleep(2200)

  // 全部收起：顶层 3 行（甲/乙/新目录），不再有任何带斜杠的深层行
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="全部收起"]')?.click()
  })()`)
  const afterCollapse = await until(
    client,
    TREE_PATHS,
    paths => (paths ?? []).length === 3 && !(paths ?? []).some(p => p.includes('/')),
  )
  if (!afterCollapse) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`全部收起失败：${JSON.stringify(now)}`)
  }
  log('场景三(a) 通过：全部收起后只剩顶层三行')

  // 定位当前文档：甲文档行回到可见
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="定位当前文档"]')?.click()
  })()`)
  const revealed = await until(
    client,
    TREE_PATHS,
    paths => (paths ?? []).some(p => p.endsWith('甲文档.md')) && paths.length > 2,
  )
  // 甲在顶层本来就在；这里验证的是按钮调用不抛错且树完好
  if (!revealed) throw new Error('定位后树状态异常')
  const selectedRow = await client.evaluate(
    `(() => { const el = ${rowSelector('甲文档.md')}; return el ? el.className : null })()`,
  )
  if (!String(selectedRow).includes('is-selected')) {
    throw new Error(`当前文档行没有选中高亮：${JSON.stringify(selectedRow)}`)
  }
  log('场景三通过：定位可用，当前文档行保持高亮')

  /* ---------- 场景四：Ctrl+点击批量选中 ---------- */

  await client.evaluate(`(() => {
    const row = ${rowSelector('乙文档.md')}
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  })()`)
  await sleep(400)
  const checked = await client.evaluate(
    `[...document.querySelectorAll('[data-tree-path]')]
      .filter(el => el.className.includes('is-checked'))
      .map(el => el.dataset.treePath)`,
  )
  if (!(checked ?? []).some(p => p.endsWith('乙文档.md'))) {
    throw new Error(`Ctrl+点击没有产生批量选中：${JSON.stringify(checked)}`)
  }
  log('场景四(a) 通过：Ctrl+点击选中 =', JSON.stringify(checked))

  // 普通点击重置选区
  await client.evaluate(`(() => { ${rowSelector('甲文档.md')}?.click() })()`)
  await sleep(2200)
  const checkedAfter = await client.evaluate(
    `[...document.querySelectorAll('[data-tree-path]')]
      .filter(el => el.className.includes('is-checked'))
      .map(el => el.dataset.treePath)`,
  )
  if (
    (checkedAfter ?? []).length !== 1 ||
    !(checkedAfter ?? []).some(p => p.endsWith('甲文档.md'))
  ) {
    throw new Error(`普通点击没有重置选区：${JSON.stringify(checkedAfter)}`)
  }
  log('场景四通过：普通点击重置为单选')

  /* ---------- 场景五：拖拽 → 确认 → 移动；取消不动 ---------- */

  // 把乙文档拖进新目录
  await dragRow(client, '乙文档.md', NEW_DIR_NAME)
  const confirmShown = await until(
    client,
    `document.querySelector('.dialog__message')?.textContent?.trim() ?? null`,
    text => Boolean(text && text.includes('移动')),
  )
  if (!confirmShown) throw new Error('拖拽后没有弹出确认框')
  // 询问类确认框必须带显式「取消」按钮（2026-10-28 用户反馈：只有 Esc 太隐蔽）
  const hasCancel = await client.evaluate(
    `[...document.querySelectorAll('.dialog__actions .btn')]
      .some(el => (el.textContent || '').trim() === '取消')`,
  )
  if (!hasCancel) throw new Error('确认框缺少取消按钮')
  log('场景五(a) 通过：确认框 =', JSON.stringify(confirmShown), '，含取消按钮')

  // 点显式取消按钮：文件原地不动
  await client.evaluate(`(() => {
    const cancel = [...document.querySelectorAll('.dialog__actions .btn')]
      .find(el => (el.textContent || '').trim() === '取消')
    cancel?.click()
  })()`)
  await sleep(800)
  const afterCancel = await client.evaluate(TREE_PATHS)
  if ((afterCancel ?? []).some(p => p === `${NEW_DIR_NAME}/乙文档.md`)) {
    throw new Error('取消后文件仍然被移动了')
  }
  log('场景五(b) 通过：取消后原地不动')

  // 再拖一次并确认（移动是主按钮 btn--primary）
  await dragRow(client, '乙文档.md', NEW_DIR_NAME)
  await sleep(600)
  await client.evaluate(`(() => {
    document.querySelector('.dialog__actions .btn--primary')?.click()
  })()`)
  const moved = await until(
    client,
    TREE_PATHS,
    paths => (paths ?? []).some(p => p === `${NEW_DIR_NAME}/乙文档.md`),
    { attempts: 24, gap: 250 },
  )
  if (!moved) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`确认移动后文件没到位：${JSON.stringify(now)}`)
  }
  log('场景五通过：确认后移动到', `${NEW_DIR_NAME}/乙文档.md`)

  /* ---------- 场景六：展开所选 → 选中目录的整棵子树铺开 ---------- */

  // 全部收起后，Ctrl 点选新目录（顶层行），点「展开所选」→ 里面的乙文档出现
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="全部收起"]')?.click()
  })()`)
  await sleep(600)
  await client.evaluate(`(() => {
    const row = ${rowSelector(NEW_DIR_NAME)}
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  })()`)
  await sleep(400)
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="展开所选"]')?.click()
  })()`)
  const expandedBack = await until(client, TREE_PATHS, paths =>
    (paths ?? []).some(p => p === `${NEW_DIR_NAME}/乙文档.md`),
  )
  if (!expandedBack) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`展开所选没有铺开子树：${JSON.stringify(now)}`)
  }
  log('场景六通过：展开所选铺开了选中目录的子树')

  /* ---------- 场景七：选区跟随当前文档（陈旧选区不再 hijack「展开所选」） ---------- */

  /*
   * 2026-10-28 用户实测的 bug 序列：收起全部 → 定位 → 展开所选，展开的却是
   * 另一个文件夹。根因是选区停在上次树内点击的节点上，而当前文档早已被
   * 搜索等非树途径换掉。这里构造同样的陈旧选区，验证选区跟随当前文档：
   */
  // Ctrl 点甲（顶层文档）→ 选区 = [甲文档.md]
  await client.evaluate(`(() => {
    const row = ${rowSelector('甲文档.md')}
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  })()`)
  await sleep(400)
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="全部收起"]')?.click()
  })()`)
  await sleep(600)

  // 不经树点击：搜索面板打开乙（旧实现里选区仍是 [甲文档.md]，与当前文档脱节）
  await client.evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  })()`)
  await sleep(600)
  const typed = await client.evaluate(`(() => {
    const input = document.querySelector('.palette__input')
    if (!input) return { ok: false, palette: Boolean(document.querySelector('.palette')) }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '乙文档')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, value: input.value }
  })()`)
  log('搜索输入：', JSON.stringify(typed))
  const searchHit = await until(
    client,
    `[...document.querySelectorAll('.palette__item--doc .palette__doc-title')].map(el => el.textContent.trim())`,
    titles => (titles ?? []).some(title => title.includes('乙文档')),
    { attempts: 20, gap: 300 },
  )
  if (!searchHit) {
    const diag = await client.evaluate(`(() => ({
      paletteOpen: Boolean(document.querySelector('.palette')),
      input: document.querySelector('.palette__input')?.value ?? null,
      items: [...document.querySelectorAll('.palette__item')].map(el => (el.textContent || '').trim().slice(0, 40)),
      empty: document.querySelector('.palette__empty')?.textContent?.trim() ?? null,
    }))()`)
    throw new Error(`搜索没有命中乙文档：${JSON.stringify(diag)}`)
  }
  await client.evaluate(`(() => {
    document.querySelector('.palette__item--doc')?.click()
  })()`)
  await sleep(2200)

  // 全部收起（乙重新藏进新目录），再展开所选：选区应已是乙，铺开它所在分支
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="全部收起"]')?.click()
  })()`)
  await sleep(600)
  await client.evaluate(`(() => {
    document.querySelector('.tree__tools button[aria-label="展开所选"]')?.click()
  })()`)
  const revealedAgain = await until(client, TREE_PATHS, paths =>
    (paths ?? []).some(p => p === `${NEW_DIR_NAME}/乙文档.md`),
  )
  if (!revealedAgain) {
    const now = await client.evaluate(TREE_PATHS)
    throw new Error(`选区没有跟随当前文档：展开所选后乙不可见（树=${JSON.stringify(now)}）`)
  }
  log('场景七通过：搜索打开文档后选区跟随，展开所选铺开当前文档所在分支')

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
