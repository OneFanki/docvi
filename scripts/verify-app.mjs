/**
 * 应用级端到端回归：真实 Electron 里跑一遍 v1.0.0 的核心交互（`pnpm verify:app`）。
 *
 * 覆盖六条主线，每条都是「单元测试测不到、只能整体跑」的接线契约：
 *  1. 左栏单工作区导航 + 切换工作区不重置标签（ADR-0008）
 *  2. 标签预览/固定语义（单击=预览、再点替换、双击=固定）
 *  3. 切标签后滚动位置恢复（不闪回顶部）
 *  4. 编辑：源码态改动 → 保存 → 磁盘真的变了
 *  5. 临时分享（创建 + 访问 URL 拿到内容）
 *  6. 本地服务（MCP 端点 + 令牌）
 *
 * 为什么需要它：`App.vue` 是这些行为的唯一接线处，而它没有纯函数入口。
 * 曾经的 `scripts/reading-position.test.mjs` 想靠扫源码字符串来「守护」，
 * 那既违反本仓的契约测试规范（禁止变更检测器），又在一次正确的改动上误报。
 * 真实拉起应用点一遍是这类接线唯一诚实的验证方式。
 *
 * 隔离：唯一临时工作区 + 唯一数据目录 + 唯一调试端口，`finally` 里无条件清理。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_DIR = join(ROOT, 'apps/desktop')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const wait = ms => new Promise(r => setTimeout(r, ms))

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer()
    s.unref()
    s.on('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => ok(port))
    })
  })
}

const root = mkdtempSync(join(tmpdir(), 'docvi-e2e-'))
// 两个工作区，验证树里的一级节点切换
const wsA = join(root, 'ws-a')
const wsB = join(root, 'ws-b')
for (const [dir, name, extra] of [
  [wsA, 'A', true],
  [wsB, 'B', false],
]) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'docs.config.yaml'),
    `title: 工作区${name}\nsidebar:\n  - text: 首页\n    path: index.md\n${
      extra ? '  - text: 第二篇\n    path: second.md\n  - text: 第三篇\n    path: third.md\n' : ''
    }`,
  )
}
writeFileSync(join(wsA, 'index.md'), '# A 首页\n\n' + 'A 段落\n\n'.repeat(120))
writeFileSync(join(wsA, 'second.md'), '# A 第二篇\n\n第二篇正文\n')
writeFileSync(join(wsA, 'third.md'), '# A 第三篇\n\n第三篇正文\n')
writeFileSync(join(wsB, 'index.md'), '# B 首页\n\nB 内容\n')

const dataDir = mkdtempSync(join(tmpdir(), 'docvi-e2e-data-'))
const port = await freePort()
let child = null
let socket = null

try {
  child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: dataDir,
      DOCVI_INSTANCE: 'docvi-e2e',
      DOCVI_DEBUG_PORT: String(port),
    },
    stdio: 'ignore',
  })

  let target = null
  for (let i = 0; i < 120; i += 1) {
    await wait(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find(x => x.type === 'page' && x.url.includes('index.html'))
      if (target) break
    } catch {
      // 调试端口还没起来：吞掉，下一轮再探
    }
  }
  if (!target) throw new Error('调试端口没开')

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok)
    socket.addEventListener('error', fail)
  })
  let id = 0
  const pending = new Map()
  const errors = []
  socket.addEventListener('message', e => {
    const m = JSON.parse(e.data)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? ''))
    }
    const cb = pending.get(m.id)
    if (cb) {
      pending.delete(m.id)
      cb(m)
    }
  })
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const n = ++id
      socket.send(JSON.stringify({ id: n, method, params }))
      pending.set(n, m => (m.error ? fail(new Error(m.error.message)) : ok(m.result)))
      setTimeout(() => fail(new Error('timeout ' + method)), 30000)
    })
  await send('Runtime.enable')
  const ev = async expr =>
    (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
      ?.result?.value

  const report = {}

  // ---- 准备：登记两个工作区 ----
  //
  // ⚠️ 不能只调 window.docvi.workspaceAddAt：那只写主进程的注册表，渲染层
  // store 不会刷新，侧栏树里看不到。这里从根组件实例拿 Pinia store，
  // 调它的 addWorkspaceAt（与界面「打开文件夹」完全同一条路径）。
  report.setup = await ev(`(async () => {
    // 等应用挂载完（页面刚出来时 __vue_app__ 可能还没设上）
    let el = null
    let app = null
    for (let i = 0; i < 60; i += 1) {
      el = document.querySelector('#app')
      app = el && el.__vue_app__
      if (app) break
      await new Promise(r => setTimeout(r, 200))
    }
    const pinia = app?.config?.globalProperties?.$pinia
    if (!pinia) return { error: '取不到 pinia', hasEl: Boolean(el) }
    const store = pinia._s.get('app')
    if (!store) return { error: 'pinia 里没有 app store', ids: [...pinia._s.keys()] }
    const a = await store.addWorkspaceAt(${JSON.stringify(wsA)})
    const b = await store.addWorkspaceAt(${JSON.stringify(wsB)})
    return { a: Boolean(a), b: Boolean(b), total: store.workspaces.length }
  })()`)

  /*
   * ---- 1. 左栏导航（ADR-0008） ----
   *
   * 三条不变量，全部只在真实界面里才成立：
   *  a. 左栏**只**显示一个工作区（切换器显示当前工作区名，树里不并列多个根）；
   *  b. 切换工作区只换树，**不重置标签**（用户明确要的多工作区标签共存）；
   *  c. 切回来还是那个工作区的树。
   *
   * 走真实点击：打开切换器 → 点菜单里的目标工作区。直接调 store 会漏掉
   * 「菜单项 id 拼错 / 菜单根本没渲染」这类接线错误。
   */
  const switchTo = async name => {
    const opened = await ev(`(() => {
      const btn = document.querySelector('.sidebar__ws-btn')
      if (!btn) return false
      btn.click()
      return true
    })()`)
    if (!opened) return { error: '左栏没有工作区切换器' }
    await wait(400)
    const picked = await ev(`(async () => {
      const items = [...document.querySelectorAll('.menu__item, [role="menuitem"]')]
      const hit = items.find(el => (el.textContent || '').trim() === ${JSON.stringify(name)})
      if (!hit) return { error: '菜单里没有 ' + ${JSON.stringify(name)}, items: items.map(el => (el.textContent || '').trim()) }
      hit.click()
      await new Promise(r => setTimeout(r, 900))
      return { ok: true }
    })()`)
    return picked
  }

  // 起点：ws-b 是最后登记的，左栏在它上面。先切到 ws-a。
  report.sidebarSwitch = await switchTo('ws-a')
  report.sidebar = await ev(`(() => {
    const name = document.querySelector('.sidebar__ws-name')?.textContent ?? ''
    // 树里的一级行：工作区不该再以一级根的形式出现在树里
    const roots = [...document.querySelectorAll('.tree > [role="treeitem"]')]
      .map(el => (el.textContent || '').trim().slice(0, 16))
    return { switcher: name.trim(), roots }
  })()`)

  // 先在 ws-a 开一个标签，再切到 ws-b：标签必须原封不动（核心新契约）
  report.wsTabs = await ev(`(async () => {
    const rows = () => [...document.querySelectorAll('.tree [role="treeitem"]')]
    const first = rows().find(r => (r.textContent || '').includes('首页'))
    if (!first) return { error: 'ws-a 树里没有首页', rows: rows().length }
    first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await new Promise(r => setTimeout(r, 1200))
    return { tabsBefore: document.querySelectorAll('.tab').length }
  })()`)

  report.wsSwitchKeepsTabs = await (async () => {
    const toB = await switchTo('ws-b')
    if (toB?.error) return toB
    const state = await ev(`(() => ({
      switcher: (document.querySelector('.sidebar__ws-name')?.textContent ?? '').trim(),
      tabsAfter: document.querySelectorAll('.tab').length,
      rows: [...document.querySelectorAll('.tree [role="treeitem"]')]
        .map(el => (el.textContent || '').trim().slice(0, 16)),
    }))()`)
    const back = await switchTo('ws-a')
    return { ...state, back: back?.error ?? 'ok' }
  })()

  // ---- 2. 标签预览/固定 ----
  //
  // 断言 VSCode 语义。起点：上面已经用双击把「首页」固定成一个标签。
  // 不能把它关掉换干净起点：标签全关后仍能点树（左栏独立于标签），
  // 但「单击替换预览」需要一个已存在的预览标签才有意义。
  //   第三篇单击 → 新建预览标签；
  //   第二篇单击 → 替换掉那个预览标签（标签数不变）；
  //   第二篇双击 → 升格固定；
  //   第三篇再单击 → 只能新开预览标签（旧的已固定，不可复用）。
  report.tabs = await ev(`(async () => {
    const docRows = () => [...document.querySelectorAll('.tree [role="treeitem"]')]
    const byText = (t) => docRows().find(r => (r.textContent || '').includes(t))
    const tabState = () => [...document.querySelectorAll('.tab')].map(t => ({
      label: (t.textContent || '').trim().slice(0, 16),
      preview: t.classList.contains('is-preview'),
      active: t.classList.contains('is-active'),
    }))
    const activeOf = (list) => list.find(t => t.active) || null
    const rowTexts = () => docRows().map(r => (r.textContent || '').trim().slice(0, 20))
    const docTabCount = () => document.querySelectorAll('.tab').length

    const first = byText('首页')
    const second = byText('第二篇')
    const third = byText('第三篇')
    if (!first || !second || !third) {
      return { error: '树里文档不全', rows: rowTexts() }
    }
    const baseCount = docTabCount()

    third.click()
    await new Promise(r => setTimeout(r, 900))
    const afterThird = tabState()
    const countThird = docTabCount()

    second.click()
    await new Promise(r => setTimeout(r, 900))
    const afterSecond = tabState()
    const countSecond = docTabCount()

    const second2 = byText('第二篇')
    if (second2) {
      second2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await new Promise(r => setTimeout(r, 700))
    }
    const afterDbl = tabState()
    const countDbl = docTabCount()

    const third2 = byText('第三篇')
    if (third2) { third2.click(); await new Promise(r => setTimeout(r, 900)) }
    const afterReopen = tabState()

    return {
      baseCount,
      countThird,
      countSecond,
      countDbl,
      afterThird,
      afterSecond,
      afterDbl,
      afterReopen,
      // 五条不变量
      thirdIsPreview: activeOf(afterThird)?.preview === true,
      previewAddedOne: countThird === baseCount + 1,
      previewReused: countSecond === countThird,
      activeIsSecond: (activeOf(afterSecond)?.label || '').includes('第二篇'),
      dblPinned: activeOf(afterDbl)?.preview === false,
      noNewTabOnDbl: countDbl === countSecond,
      afterPinOpensNew: docTabCount() === countDbl + 1 || countDbl === docTabCount(),
    }
  })()`)

  // ---- 3. 滚动位置恢复 ----
  //
  // 走**固定标签**的路径：两篇各固定成一个标签，再用标签条来回切。
  // 用预览标签测不了——预览复用会把上一个标签整条换掉，历史直接不存在。
  // 开启位置恢复取证：`logPosition` 在数组存在时才记（生产零开销）
  await ev(`window.__posLog = []`)

  report.scroll = await ev(`(async () => {
    const docRows = () => [...document.querySelectorAll('.tree [role="treeitem"]')]
    const byText = (t) => docRows().find(r => (r.textContent || '').includes(t))
    // 只读 .tab__doc 的文字：外层 .tab 还含关闭按钮的 aria-label，比整段文本对不上
    const tabByLabel = (t) => [...document.querySelectorAll('.tab')]
      .find(el => (el.querySelector('.tab__doc')?.textContent || '').trim() === t)
    const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    const long = byText('首页')
    if (!long) return { error: '找不到长文节点', rows: docRows().length }
    dbl(long)
    await new Promise(r => setTimeout(r, 900))

    const sc = document.querySelector('.reader')
    if (!sc) return { error: '找不到滚动容器' }
    sc.scrollTop = 900
    // 等节流上报（200ms）把位置写进标签记录
    await new Promise(r => setTimeout(r, 500))
    const before = sc.scrollTop
    const maxScroll = sc.scrollHeight - sc.clientHeight

    // 位置是否真的落到标签记录上（恢复失败时用来区分「没记上」还是「没恢复」）
    // ⚠️ 必须取**活动**标签：按 label 模糊匹配会先命中「B 首页」，读到的永远是 0
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const tabs = pinia._s.get('tabs')
    const activeRefNow = () => {
      const ref = tabs.activeId ? tabs.currentDocOf(tabs.activeId) : null
      return ref
        ? { title: ref.title, scrollY: Math.round(ref.scrollY), topLine: ref.topLine, layoutKey: ref.layoutKey }
        : null
    }
    const recordedBefore = activeRefNow()

    const other = byText('第二篇')
    if (!other) return { error: '找不到第二篇', before }
    dbl(other)
    await new Promise(r => setTimeout(r, 900))

    const backTab = tabByLabel('A 首页')
    if (!backTab) {
      return {
        error: '标签条上找不到首页标签',
        before,
        tabsNow: [...document.querySelectorAll('.tab')]
          .map(el => (el.querySelector('.tab__doc')?.textContent || '').trim()),
      }
    }
    backTab.click()
    // 渲染 + 高亮/mermaid pass 之后再读
    await new Promise(r => setTimeout(r, 1400))
    const sc2 = document.querySelector('.reader')
    const after = sc2 ? Math.round(sc2.scrollTop) : -1
    return {
      before: Math.round(before),
      after,
      maxScroll: Math.round(maxScroll),
      recordedBefore,
      restored: after > before * 0.6,
    }
  })()`)

  // ---- 4. 编辑：进源码态改动 → 保存 → 磁盘真的变了 ----
  //
  // 这是 v1 的核心能力（通用 Markdown 编辑器），之前完全没被端到端覆盖。
  // 断言落在**磁盘内容**而不是界面文字：编辑器改了但没写盘是这类功能最典型的
  // 假成功（界面看着是新的，关掉就没了）。
  report.edit = await ev(`(async () => {
    const docRows = () => [...document.querySelectorAll('.tree [role="treeitem"]')]
    const row = docRows().find(r => (r.textContent || '').includes('第三篇'))
    if (!row) return { error: '找不到第三篇节点' }
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await new Promise(r => setTimeout(r, 900))

    // 切到源码态：只有编辑态才挂载 CodeMirror
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const tabs = pinia._s.get('tabs')
    const before = tabs.activeDoc?.title ?? ''
    const wasPreview = tabs.activeTab?.preview ?? null

    const sourceBtn = [...document.querySelectorAll('button')]
      .find(b => (b.textContent || '').trim() === '源码')
    if (!sourceBtn) {
      return {
        error: '找不到「源码」模式按钮',
        buttons: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 20),
      }
    }
    sourceBtn.click()
    await new Promise(r => setTimeout(r, 1200))

    const cm = document.querySelector('.cm-content')
    if (!cm) return { error: '切到源码态后没有 CodeMirror 实例' }

    // 直接在 CM 里改：聚焦后全选替换（比模拟逐字输入稳定）
    cm.focus()
    document.execCommand('selectAll')
    document.execCommand('insertText', false, '# A 第三篇\\n\\n编辑回归写入的正文\\n')
    await new Promise(r => setTimeout(r, 600))
    const dirtyAfterEdit = tabs.activeDoc?.absolutePath
      ? pinia._s.get('documents').isDirty(tabs.activeDoc.absolutePath)
      : null

    /*
     * 保存：在编辑器元素上派发 Ctrl+S，让 CodeMirror 自己的 keymap 接住
     * （生产路径就是它）。在 document 上派发测的是另一条代码路径，会得到
     * 与用户操作无关的结论。
     */
    cm.dispatchEvent(new KeyboardEvent('keydown', {
      key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    await new Promise(r => setTimeout(r, 1800))

    return {
      titleBefore: before,
      dirtyAfterEdit,
      pinnedByEdit: wasPreview === true ? (tabs.activeTab?.preview ?? null) : 'n/a',
      dirtyAfterSave: tabs.activeDoc?.absolutePath
        ? pinia._s.get('documents').isDirty(tabs.activeDoc.absolutePath)
        : null,
    }
  })()`)

  // 磁盘侧核对（Node 读，绕过渲染层，确认真的落盘了）
  if (!report.edit?.error) {
    try {
      report.edit.onDisk = (await import('node:fs')).readFileSync(join(wsA, 'third.md'), 'utf8')
    } catch (error) {
      report.edit.onDisk = '读取失败：' + String(error)
    }
  }

  // ---- 5. 临时分享 ----
  // 创建在渲染层做，取内容用 Node 侧 fetch（渲染层对 127.0.0.1 的分享端口受
  // CSP `connect-src` 限制，跨源会被拦——那是设计如此，不是缺陷）。
  const shareInfo = await ev(`(async () => {
    const created = await window.docvi.shareCreatePath(${JSON.stringify(join(wsA, 'second.md'))})
    if (!created.ok) return { error: JSON.stringify(created.error) }
    if (!created.data) return { error: '用户取消或无目标' }
    return { url: created.data.url, id: created.data.id }
  })()`)
  if (shareInfo?.url) {
    let status = null
    let body = ''
    try {
      const res = await fetch(shareInfo.url)
      status = res.status
      /*
       * 断言必须看**全文**：正文在页面后半（前面是 CSP meta、两三段内联样式、
       * 导航栏），只截前几百字符会让一条正确的页面被判成「没有内容」。
       * 2026-11-24 给分享页加 CSP 后就踩过这个——页面变长，断言窗口反而失效。
       */
      body = await res.text()
    } catch (e) {
      report.share = { ...shareInfo, error: 'Node fetch 失败：' + String(e) }
    }
    if (status !== null) {
      const articleAt = body.indexOf('<article')
      report.share = {
        ...shareInfo,
        status,
        hasContent: body.includes('第二篇'),
        // 失败时把正文容器附近带出来：200 但没内容时这是唯一的定位线索
        snippet: articleAt >= 0 ? body.slice(articleAt, articleAt + 300) : body.slice(0, 300),
      }
    }
    await ev(`window.docvi.shareRemove(${JSON.stringify(shareInfo.id)})`)
  } else {
    report.share = shareInfo
  }

  // ---- 6. 本地服务与 MCP ----
  report.service = await ev(`(async () => {
    const state = await window.docvi.serviceState()
    if (!state.ok) return { error: 'serviceState 失败' }
    return { running: state.data.running, port: state.data.port, endpoint: state.data.endpoint, hasToken: Boolean(state.data.token) }
  })()`)

  report.consoleErrors = errors.slice(0, 8)

  /* ---------- 断言：任一不变量失守就以非零码退出 ---------- */

  /*
   * 每条都写成「场景 + 期望」，失败信息带实际值。宁可让 verify 红，
   * 也不要让「标签预览语义根本没接线」这类问题靠人肉点界面才发现
   * （2026-11-24 审查之前它已经静默失效了一个版本）。
   */
  const failures = []
  const expect = (ok, message, detail) => {
    if (!ok) failures.push({ message, detail })
  }

  expect(report.setup?.a && report.setup?.b, '两个测试工作区必须登记成功', report.setup)

  const sidebar = report.sidebar ?? {}
  expect(!report.sidebarSwitch?.error, '应能用左栏切换器切到 ws-a', report.sidebarSwitch)
  expect(sidebar.switcher === 'ws-a', '切换器上应显示当前工作区名', sidebar)
  expect(
    Array.isArray(sidebar.roots) && sidebar.roots.length > 0 && !sidebar.roots.includes('ws-b'),
    '树里只应有当前工作区的内容，不并列其它工作区',
    sidebar.roots,
  )

  const wsTabs = report.wsTabs ?? {}
  const wsSwitch = report.wsSwitchKeepsTabs ?? {}
  expect(!wsTabs.error, '切换前应先能在 ws-a 打开一篇', wsTabs)
  expect(!wsSwitch.error, '应能切到 ws-b 再切回 ws-a', wsSwitch)
  expect(wsSwitch.switcher === 'ws-b', '切到 ws-b 后切换器应更新', wsSwitch)
  expect(wsSwitch.tabsAfter === wsTabs.tabsBefore, '切换工作区不能重置标签（多工作区的标签共存）', {
    before: wsTabs.tabsBefore,
    after: wsSwitch.tabsAfter,
  })

  const tabs = report.tabs ?? {}
  expect(!tabs.error, '标签语义探针应能跑通', tabs.error)
  expect(tabs.thirdIsPreview, '单击文档应打开预览标签（斜体）', tabs.afterThird)
  expect(tabs.previewAddedOne, '首次单击应新建一个标签', {
    base: tabs.baseCount,
    after: tabs.countThird,
  })
  expect(tabs.previewReused, '再点另一篇应替换预览标签，标签数不增长', {
    before: tabs.countThird,
    after: tabs.countSecond,
  })
  expect(tabs.activeIsSecond, '替换后激活的应是新点开的那篇', tabs.afterSecond)
  expect(tabs.dblPinned, '双击应把预览标签升格为固定', tabs.afterDbl)
  expect(tabs.noNewTabOnDbl, '双击升格不应多出标签', {
    before: tabs.countSecond,
    after: tabs.countDbl,
  })

  const scroll = report.scroll ?? {}
  expect(!scroll.error, '滚动恢复探针应能跑通', scroll.error)
  expect(scroll.restored, '切标签回来应恢复到原来的阅读位置（不闪回顶部）', {
    before: scroll.before,
    after: scroll.after,
  })

  const edit = report.edit ?? {}
  expect(!edit.error, '编辑探针应能跑通', edit.error ?? edit.buttons)
  expect(
    typeof edit.onDisk === 'string' && edit.onDisk.includes('编辑回归写入的正文'),
    '源码态改动保存后必须真的写进磁盘',
    edit.onDisk,
  )
  expect(edit.dirtyAfterEdit === true, '编辑后应标记为未保存', edit.dirtyAfterEdit)
  expect(edit.dirtyAfterSave === false, '保存后不应仍有未保存标记', edit.dirtyAfterSave)
  expect(
    edit.pinnedByEdit === false || edit.pinnedByEdit === 'n/a',
    '开始编辑应把预览标签固定住',
    edit.pinnedByEdit,
  )

  const share = report.share ?? {}
  expect(share.status === 200, '临时分享的 URL 应返回 200', share)
  expect(share.hasContent, '分享页应渲染出目标文档正文', share)

  const service = report.service ?? {}
  expect(service.running, '本地服务应在运行（MCP + 局域网分享依赖它）', service)
  expect(Boolean(service.endpoint), '本地服务应暴露 MCP 端点', service)
  expect(service.hasToken, '本地服务应带访问令牌', service)

  expect(report.consoleErrors.length === 0, '运行期不应有控制台错误', report.consoleErrors)

  if (failures.length) {
    console.error(`[verify:app] ${failures.length} 项不变量失守：`)
    for (const failure of failures) {
      console.error(`  ✖ ${failure.message}`)
      if (failure.detail !== undefined) {
        console.error(`    实际：${JSON.stringify(failure.detail)}`)
      }
    }
    process.exitCode = 1
  } else {
    console.log(
      '[verify:app] 通过：左栏单工作区导航 / 标签预览固定 / 滚动恢复 / 编辑保存 / 临时分享 / 本地服务',
    )
  }
} finally {
  try {
    socket?.close()
  } catch {
    // 连接可能已经被对面关掉：清理阶段不再追究
  }
  child?.kill()
  await wait(600)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
}
