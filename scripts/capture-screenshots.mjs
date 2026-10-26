#!/usr/bin/env node
/**
 * README / 介绍页截图生成器。
 *
 * 用法：
 *   pnpm docvi:build && node scripts/capture-screenshots.mjs
 *   node scripts/capture-screenshots.mjs --only editor
 *
 * 三条硬约束（都是被真实问题逼出来的）：
 *
 *  1. **绝不弹窗**。截图要开十几次应用；每次都把窗口弹到最前面，等于把正在用
 *     电脑的人按住。所以传 `DOCVI_HEADLESS=1`——应用会把窗口停到屏幕之外，
 *     不建托盘图标、不抢焦点。截图本身走 CDP，不需要窗口可见。
 *
 *  2. **每张图一个独立环境**。独立的临时数据目录 + 独立的临时工作区，跑完即删。
 *     截图之间互不污染，也绝不碰用户的 `%APPDATA%/docvi` 与真实文档。
 *     配合 `DOCVI_INSTANCE` 换掉应用名，否则单实例锁会让第二张图直接退出。
 *
 *  3. **收尾必须整组杀进程**。Windows 上 Electron 会派生 GPU / utility / renderer
 *     一串子进程，`child.kill()` 只杀主进程，其余变成孤儿继续占内存（这个坑在
 *     本仓踩过：42 个无头实例存活 5 天）。所以用 `taskkill /T /F` 杀整棵树。
 *
 * 数据是虚构的：`scripts/fixtures/demo-workspace/` 里是一个假想的电商订单系统，
 * 覆盖流程、状态机、表关系、接口清单、指标、时间线等组件的真实写法。
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'apps/desktop/node_modules/electron/dist/electron.exe')
const APP_DIR = join(ROOT, 'apps/desktop')
const FIXTURE = join(ROOT, 'scripts/fixtures/demo-workspace')
const OUT = join(ROOT, 'docs/screenshots')

/** 视口：1440×900 @2x。README 里按 900 宽展示，@2x 在高分屏上仍然清晰。 */
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 }

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined

/**
 * 截图清单。
 *
 * 字段：
 *  - `view`  打开哪一屏（library / editor / plugins / settings）
 *  - `doc`   编辑器里打开哪篇文档（相对演示工作区的路径）
 *  - `mode`  阅读 / 实时预览 / 源码 / 分屏
 *  - `theme` 主题 id
 *  - `locale` zh / en
 *  - `clicks` 逐步点击的选择器（按顺序）
 *  - `script` 在页面里执行的额外脚本（返回 true 表示成功）
 *  - `crop`  只截某个元素（选择器）；省略则整窗
 *  - `scrollTo` 先滚到某个元素
 */
const SHOTS = [
  // —— 首图：实时预览 + 组件渲染，一张图说清「这是什么」 ——
  /*
   * 首图的空隙比其它屏更大：它上面紧接着一句引言，留白不够会把那句话切掉半行，
   * 顶部就挂着一行断句。留够一整段，读者看到的是「标题下的一段话 + 图」。
   */
  {
    name: 'hero',
    doc: '开始/系统概览.md',
    mode: 'live',
    theme: 'slate',
    scrollTo: '.at-flow',
    scrollAlign: 'start',
    scrollGap: 208,
  },
  /*
   * 编辑体验：实时预览不显示 Markdown 语法。
   *
   * 刻意用纯散文文档（无任何图表组件）：这一屏要展示的是「标记被隐藏后正文长什么
   * 样」——标题、加粗术语、行内代码、引用、代码块。用带图的文档会让读者以为这张图
   * 在介绍那个图，后面每张图又都是同一张图，整套截图看起来就只剩一个组件。
   */
  {
    name: 'editor-live',
    doc: '设计与实现/对账口径.md',
    mode: 'live',
    theme: 'slate',
    hoverText: '对账口径',
  },
  /*
   * 分屏：左源码右渲染，同一份缓冲区。
   *
   * 这里刻意选**竖排**内容（时间线 + 清单），不选宽图表：右栏只有半个窗口宽，
   * 表关系图那类横向布局在窄栏里触发「保字不保图」的缩放下限会被裁切——那不是
   * 缺陷，但作为产品介绍图会让人以为图显示不全。
   */
  {
    name: 'editor-split',
    doc: '交付/交付计划.md',
    mode: 'split',
    theme: 'slate',
  },
  // —— 选区气泡工具栏（选中行内代码/加粗所在段落） ——
  {
    name: 'selection-toolbar',
    doc: '交付/周会纪要.md',
    mode: 'live',
    theme: 'slate',
    script: `(() => {
      const view = document.querySelector('.cm-content')?.cmTile?.root?.view
      if (!view) return false
      const text = view.state.doc.toString()
      const from = text.indexOf('库存事务化')
      const to = text.indexOf('180ms') + 5
      if (from < 0 || to < 5) return false
      view.dispatch({ selection: { anchor: from, head: to } })
      view.focus()
      return true
    })()`,
  },
  // —— 状态机（与 hero 的流程图不同，单独露面） ——
  {
    name: 'state-flow',
    doc: '设计与实现/订单状态机.md',
    mode: 'live',
    theme: 'slate',
    scrollTo: '.at-stateflow',
    scrollAlign: 'start',
  },
  // —— 阅读态：不带编辑工具条，右侧本页目录 ——
  /*
   * 阅读态：不带编辑工具条，右侧本页目录。
   *
   * 选表字段明细（table-tabs）——它是这套截图里唯一还没单独露面的表格组件，
   * 而首图已经是一张流程图，阅读态再放同一张就只是「同一屏换个模式」。
   * 这一屏要证三件事：没有选区工具条、没有行首徽标、右侧有可选的本页目录。
   */
  {
    name: 'reading',
    doc: '设计与实现/表结构设计.md',
    mode: 'read',
    theme: 'slate',
    scrollTo: '.at-tabletabs',
    scrollAlign: 'start',
  },
  /*
   * 评审记录：决策卡 + 风险清单 + 改动清单。
   * 这三类是「判断」而不是「数据」——Markdown 里它们只能写成散文，读者读完
   * 记不住结论；做成卡片后每条都有固定的位置（决定 / 原因 / 证据）。
   */
  {
    name: 'review-cards',
    doc: '设计与实现/评审记录.md',
    mode: 'live',
    theme: 'slate',
    scrollTo: '.at-decision',
    scrollAlign: 'start',
  },
  /*
   * 多标签：同时开五篇文档。
   * 标签是「内容源 + 路径 + 滚动位置」，不持有 DOM——切回去滚动位置还在。
   *
   * 正文用纯散文文档（对账口径）铺满视口：主体是标签栏，正文只是背景。
   * 用带图或短文档的首页会露出一大片空白或切半张卡片，注意力全跑到背景上。
   */
  {
    name: 'tabs',
    doc: '设计与实现/对账口径.md',
    mode: 'live',
    theme: 'slate',
    extraDocs: [
      '设计与实现/评审记录.md',
      '设计与实现/订单状态机.md',
      '设计与实现/表结构设计.md',
      '设计与实现/接口清单.md',
    ],
  },
  // —— 表关系图：悬停高亮整条链路 ——
  {
    name: 'table-graph',
    doc: '设计与实现/表结构设计.md',
    mode: 'live',
    theme: 'slate',
    scrollTo: '.at-tablegraph',
  },
  // —— 接口清单：折叠 + 展开契约详情 ——
  {
    name: 'endpoints',
    doc: '设计与实现/接口清单.md',
    mode: 'live',
    theme: 'slate',
    script: `(() => {
      const row = document.querySelector('.at-endpoints__row')
      if (row) row.click()
      return true
    })()`,
  },
  // —— 文档库首页 ——
  { name: 'library', view: 'library', theme: 'slate' },
  // —— 浅色主题：证明两套主题都成立，不是简单反色 ——
  /*
   * 落点是指标卡：它是这套截图里唯一还没单独露面的组件，靠数值/单位/涨跌色
   * 区分状态，最能看出「另一套配色」而不是简单反色。
   * 上方留白要够到小节标题，否则顶部会挂半行被切断的正文。
   */
  {
    name: 'theme-paper',
    doc: '开始/系统概览.md',
    mode: 'live',
    theme: 'paper',
    scrollTo: '.at-metricrow',
    scrollAlign: 'start',
    scrollGap: 200,
  },
  // —— 插件面板：已安装页签 ——
  { name: 'plugins', view: 'plugins', theme: 'slate' },
  // —— 设置页 ——
  { name: 'settings', view: 'settings', theme: 'slate' },
]

/* ---------------------------------------------------------------- 运行环境 */

function wait(ms) {
  return new Promise(done => setTimeout(done, ms))
}

/** 整组杀进程：Windows 上 Electron 会派生一串子进程，只杀主进程会留孤儿 */
function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(-pid, 'SIGKILL')
  }
}

/**
 * 演示工作区落地位置。
 *
 * 不放在 `%TEMP%`：临时目录的绝对路径会出现在状态栏左下角，而 Windows 的
 * `%TEMP%` 长这样——`C:\Users\<用户名>\AppData\Local\Temp\...`。截图要进公开
 * README，那里不该出现任何个人机器路径。
 *
 * 改用 `C:\Users\Public`（所有用户可写），目录名保持中性：状态栏显示的是
 * `C:\Users\Public\订单中台`，既真实又不泄露任何个人信息。非 Windows 退回
 * 系统临时目录。
 */
function demoRoot() {
  const base = process.platform === 'win32' ? (process.env.PUBLIC ?? 'C:/Users/Public') : tmpdir()
  return base
}

/**
 * 演示工作区：**固定路径**，不用随机后缀。
 *
 * 状态栏左下角会显示工作区的绝对路径，而截图要进公开 README——`docvi-shot-a3f9x`
 * 这种随机名一眼就是测试残留。固定成 `docvi-demo/订单中台`，看起来就是个正常的
 * 本地文档目录。每张截图开始前重建，互不影响。
 */
function seedWorkspace(name) {
  const root = join(demoRoot(), 'docvi-demo')
  const workspace = join(root, name)
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  cpSync(FIXTURE, workspace, { recursive: true })
  return { workspace, cleanupRoot: root }
}

/** 与渲染层共享的 CDP 客户端 */
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
  const opened = new Promise((done, fail) => {
    socket.addEventListener('open', done, { once: true })
    socket.addEventListener('error', () => fail(new Error('CDP 连接失败')), { once: true })
  })
  return opened.then(() => ({
    /** 只解析 CDP 的 result：调用方拿到的就是方法返回值本身 */
    send(method, params = {}) {
      return new Promise(done => {
        const id = ++nextId
        pending.set(id, message => done(message.result))
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    async evaluate(expression) {
      // send 已解到 CDP result，这里再解一层 Runtime.evaluate 的 returnByValue 包装
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

/* ---------------------------------------------------------------- 单张截图 */

async function capture(shot) {
  const dataDir = mkdtempSync(join(tmpdir(), `docvi-shot-data-${shot.name}-`))
  const { workspace, cleanupRoot } = seedWorkspace('订单中台')
  const port = 9800 + Math.floor(Math.random() * 150)

  const child = spawn(ELECTRON, [APP_DIR, '--no-sandbox'], {
    env: {
      ...process.env,
      DOCVI_HEADLESS: '1',
      DOCVI_DATA_DIR: dataDir,
      // 应用名必须换：单实例锁按应用名全局生效，不换的话第二张图会直接退出
      DOCVI_INSTANCE: `docvi-shot-${shot.name}`,
      DOCVI_DEBUG_PORT: String(port),
    },
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  })

  try {
    // 等应用把调试端口开出来
    let target = null
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await wait(300)
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        target = list.find(item => item.type === 'page' && item.url.includes('index.html'))
        if (target) break
      } catch {
        // 端口还没开
      }
    }
    if (!target) throw new Error('应用窗口没有出现（CDP 不可达）')

    const client = await connect(target.webSocketDebuggerUrl)
    await wait(2500)

    await client.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, mobile: false })
    /*
     * 焦点模拟必须开：无头窗口停在屏幕之外，Chromium 认为它没有焦点，
     * 而选区气泡的显示条件是「选区非空 + 编辑器持有焦点」。不开这一项，
     * 选区高亮画得出来、气泡却永远不出现（实测踩到）。
     */
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    /*
     * 主题与语言都落在 settings.json（主进程），不是 localStorage——渲染层的
     * 启动值读的是主进程设置：写错地方的结果是「截图还是默认主题 / 还是中文」，
     * 而且不报任何错（实测踩到）。
     */
    if (shot.theme || shot.locale) {
      const patch = {}
      if (shot.theme) patch.theme = shot.theme
      if (shot.locale) patch.locale = shot.locale
      await client.evaluate(`window.docvi.settingsWrite(${JSON.stringify(patch)})`)
    }
    await wait(500)

    // 1) 登记演示工作区并打开
    const added = await client.evaluate(`(async () => {
      const result = await window.docvi.workspaceAddAt(${JSON.stringify(workspace)})
      return result
    })()`)
    if (!added?.ok) throw new Error(`登记工作区失败：${JSON.stringify(added)}`)

    // 渲染层的 store 在启动时读过一次工作区列表，重新载入才看得见
    await client.evaluate('location.reload()')
    await wait(3200)

    // 2) 打开工作区（点文档库里的卡片）。
    //    按卡片上显示的 root 路径匹配，不按名字：工作区名（订单中台）在别处也可能出现。
    const opened = await client.evaluate(`(() => {
      const cards = [...document.querySelectorAll('.card')]
      const hit = cards.find(el => (el.textContent || '').includes(${JSON.stringify(workspace)}))
      if (!hit) return { ok: false, count: cards.length, texts: cards.map(c => (c.textContent || '').trim().slice(0, 60)) }
      hit.click()
      return { ok: true }
    })()`)
    if (!opened?.ok) {
      throw new Error(
        `找不到工作区卡片（共 ${opened?.count} 张）：${JSON.stringify(opened?.texts ?? [])}`,
      )
    }
    await wait(3000)

    // 3) 按需切到目标页面
    if (shot.view === 'plugins' || shot.view === 'settings' || shot.view === 'library') {
      /*
       * 回文档库：点标签栏里钉住的「文档库」标签。
       *
       * 它不是 button——是 `role="tab"` 的 div（没有 aria-label），早期按
       * `aria-label === '文档库'` 找按钮会静默找不到，于是 library 那一屏拍出来的
       * 其实是上一个文档页。这里找不到就直接报错，别再默默拍错画面。
       */
      const back = await client.evaluate(`(() => {
        const tab = document.querySelector('.tabbar__pinned .tab--library')
        if (!tab) return false
        tab.click()
        return true
      })()`)
      if (!back) throw new Error('找不到标签栏里的「文档库」标签，无法回首页')
      await wait(1600)
      const label = { plugins: '插件', settings: '设置' }[shot.view]
      if (label) {
        await client.evaluate(`(() => {
          const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') || '').includes(${JSON.stringify(label)}))
          if (btn) btn.click()
          return Boolean(btn)
        })()`)
        await wait(1600)
      }
    } else if (shot.doc) {
      /*
       * 展开所有折叠的目录。
       *
       * 新开标签会重新挂载整棵树，默认只有顶层展开——不先展开，目标文档根本不在
       * DOM 里，点不到。这一步放在所有打开动作之前，后面两段都依赖它。
       */
      const expandAll = async () => {
        for (let round = 0; round < 4; round += 1) {
          const changed = await client.evaluate(`(() => {
            const closed = [...document.querySelectorAll('[data-tree-path][aria-expanded="false"]')]
            for (const row of closed) {
              const chevron = row.querySelector('.chevron')
              if (chevron) chevron.click()
            }
            return closed.length
          })()`)
          if (!changed) return
          await wait(450)
        }
      }
      await expandAll()

      /*
       * 多标签：对「另外几篇」走**右键 → 在新标签页打开**。
       *
       * 直接点树的文档是「同标签内替换」，点几次都只有一个标签；新开标签的入口
       * 在右键菜单里。这里有两点是踩出来的：
       *  - 菜单是 Teleport 到 body 的浮层，要用文字匹配菜单项而不是猜 DOM 结构；
       *  - 右键事件必须带真实坐标，浮层按坐标定位，坐标为 0 会跑到屏幕左上角外。
       */
      for (const path of shot.extraDocs ?? []) {
        const other = await client.evaluate(`(async () => {
          const path = ${JSON.stringify(path)}
          const row = document.querySelector('[data-tree-path="' + path + '"]')
            ?? [...document.querySelectorAll('[data-tree-path]')]
              .find(el => (el.dataset.treePath || '').endsWith(path))
          if (!row) return { ok: false, why: 'no-row' }
          const r = row.getBoundingClientRect()
          row.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 10),
          }))
          await new Promise(done => setTimeout(done, 500))
          const item = [...document.querySelectorAll('.menu__item, [role="menuitem"]')]
            .find(el => (el.textContent || '').includes('在新标签页打开'))
          if (!item) {
            return { ok: false, why: 'no-menu-item', items: [...document.querySelectorAll('.menu__item')].map(el => (el.textContent || '').trim()) }
          }
          item.click()
          return { ok: true }
        })()`)
        if (!other?.ok) {
          throw new Error(`未能为新标签打开 ${path}：${JSON.stringify(other)}`)
        }
        await wait(2200)
        // 新标签是重新挂载的树，目录又收起来了
        await expandAll()
      }

      /*
       * 回到目标文档：先点已开的同名标签，没有再回头点树。
       *
       * 点树是「在当前标签内替换」——额外标签开完后点树会把最后一个标签的内容换掉，
       * 标签数少一个，还会出现两个同名标签。目标文档此时已经在一个标签里，激活它即可。
       */
      const targetLabel = shot.doc.split('/').pop().replace(/\.md$/, '')
      const activated = await client.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('.tabbar__scroll .tab')]
        const hit = tabs.find(el => (el.querySelector('.tab__doc')?.textContent || '').trim() === ${JSON.stringify(targetLabel)})
        if (!hit) return { ok: false }
        hit.click()
        return { ok: true, how: 'tab' }
      })()`)
      if (!activated?.ok) {
        // 目标文档没有已开的标签（普通截图流程），走原来的点树
        const clicked = await client.evaluate(`(() => {
          const path = ${JSON.stringify(shot.doc)}
          const exact = document.querySelector('[data-tree-path="' + path + '"]')
          if (exact) { exact.click(); return { ok: true, how: 'exact' } }
          const rows = [...document.querySelectorAll('[data-tree-path]')]
          const hit = rows.find(el => (el.dataset.treePath || '').endsWith(path))
          if (hit) { hit.click(); return { ok: true, how: 'suffix' } }
          return { ok: false, paths: rows.map(el => el.dataset.treePath) }
        })()`)
        if (!clicked?.ok) {
          throw new Error(`找不到文档 ${shot.doc}，树里有：${JSON.stringify(clicked?.paths ?? [])}`)
        }
      }
      await wait(2600)

      /*
       * 切渲染模式：按**第几个按钮**点，不按可见文字。
       *
       * 模式按钮的可见文字跟着界面语言变（实时预览 / Live preview），用文字
       * 匹配会在英文截图里直接失效；而四个模式按钮的顺序是稳定的——
       * 阅读 / 实时预览 / 源码 / 分屏。
       */
      if (shot.mode && shot.mode !== 'read') {
        const modeIndex = { read: 0, live: 1, source: 2, split: 3 }[shot.mode]
        const switched = await client.evaluate(`(() => {
          const buttons = [...document.querySelectorAll('.status__btn')]
          const btn = buttons[${modeIndex}]
          if (!btn) return { ok: false, count: buttons.length }
          btn.click()
          return { ok: true, label: (btn.textContent || '').trim() }
        })()`)
        if (!switched?.ok) {
          throw new Error(`切不到 ${shot.mode} 模式（只有 ${switched?.count} 个按钮）`)
        }
        await wait(2600)
      }
    }

    // 4) 额外脚本与点击
    for (const selector of shot.clicks ?? []) {
      await client.evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return Boolean(el); })()`,
      )
      await wait(900)
    }
    if (shot.script) {
      const done = await client.evaluate(shot.script)
      if (done === false) throw new Error('截图脚本返回 false（目标元素没找到）')
      await wait(1000)
    }

    // 5) 滚动到目标位置
    if (shot.scrollTo) {
      const align = shot.scrollAlign ?? 'center'
      // start 对齐默认留一段空隙，见下方说明
      const gap = shot.scrollGap ?? (align === 'start' ? 32 : 0)
      const scrolled = await client.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(shot.scrollTo)})
        if (!el) return { ok: false }
        /*
         * 对齐到 start 时再退一段距离：正文滚动容器的顶端就贴在标签栏下沿，
         * 直接 scrollIntoView({block:'start'}) 会让组件边框紧贴标签栏，看起来
         * 像被裁掉了。gap 用「最近的可滚动祖先」换算成 scrollTop，比 scrollBy
         * 稳——scrollBy 在已经滚到底时会静默少滚。
         */
        const gap = ${gap}
        if (gap) {
          let box = el.parentElement
          while (box) {
            const oy = getComputedStyle(box).overflowY
            if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight) break
            box = box.parentElement
          }
          if (box) {
            const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - gap
            box.scrollTop = Math.max(0, top)
            return { ok: true, how: 'gap' }
          }
        }
        el.scrollIntoView({ block: ${JSON.stringify(align)}, behavior: 'instant' })
        return { ok: true, how: 'align' }
      })()`)
      if (!scrolled?.ok) throw new Error(`滚动目标不存在：${shot.scrollTo}`)
      await wait(1200)
    }

    /*
     * 5.5) 悬停到某段文字上。
     *
     * 行首的 H1 徽标只在鼠标真正移动过那一行时才浮出（插件监听 mousemove 并用
     * posAtCoords 反查行号），所以必须走 CDP 的真实鼠标事件，不能用 JS 伪造
     * MouseEvent——伪造事件的坐标不会被 posAtCoords 采信。
     */
    if (shot.hoverText) {
      const box = await client.evaluate(`(() => {
        const root = document.querySelector('.cm-content')
        if (!root) return null
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          const text = node.textContent || ''
          const at = text.indexOf(${JSON.stringify(shot.hoverText)})
          if (at >= 0) {
            const range = document.createRange()
            range.setStart(node, at)
            range.setEnd(node, at + ${JSON.stringify(shot.hoverText)}.length)
            const r = range.getBoundingClientRect()
            return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) }
          }
          node = walker.nextNode()
        }
        return null
      })()`)
      if (!box) throw new Error(`找不到要悬停的文字：${shot.hoverText}`)
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x,
        y: box.y,
        button: 'none',
      })
      await wait(700)
    }

    // 6) 截图
    let clip
    if (shot.crop) {
      const box = await client.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(shot.crop)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale: 1 }
      })()`)
      if (!box) throw new Error(`裁剪目标不存在：${shot.crop}`)
      clip = box
    }
    const shotResult = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    })
    if (!shotResult?.data) throw new Error('截图返回空数据')

    mkdirSync(OUT, { recursive: true })
    const file = join(OUT, `${shot.name}.png`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, Buffer.from(shotResult.data, 'base64'))
    console.log(`  ✓ ${shot.name}.png`)
    client.close()
  } finally {
    killTree(child.pid)
    await wait(600)
    for (const dir of [dataDir, cleanupRoot]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {
        // 目录被占用（杀进程有延迟）：下一轮会覆盖，不阻塞其余截图
      }
    }
  }
}

/* ---------------------------------------------------------------- 入口 */

if (!existsSync(ELECTRON)) {
  console.error('找不到 Electron 可执行文件，先跑 pnpm install')
  process.exit(1)
}
if (!existsSync(join(APP_DIR, 'out/main/index.js'))) {
  console.error('缺少构建产物：先跑 pnpm docvi:build')
  process.exit(1)
}

console.log(`截图输出到 ${OUT}`)
for (const shot of SHOTS) {
  if (only && shot.name !== only) continue
  console.log(`- ${shot.name}`)
  await capture(shot)
}
console.log('完成')
