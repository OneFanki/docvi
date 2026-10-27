import { app, BrowserWindow, ipcMain, protocol, net, shell } from 'electron'
import { realpathSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { IPC } from '@docvi/shared'

import { registerIpc, createStore, createRecent, type DesktopHostOptions } from './ipc.ts'
import type { WorkspaceStore } from './store.ts'
import { createLocalAssetRegistry, type LocalAssetRegistry } from './local-assets.ts'
import { pruneUpdateCache } from './update.ts'
import { readAutostart, writeAutostart } from './autostart.ts'
import { createFileWatcher } from './fs-watch.ts'
import { isContentRelPath } from './content.ts'
import { createPluginStore, resolvePluginAsset, type PluginStore } from './plugin-store.ts'
import { createServiceManager, serviceEntryPath } from './service.ts'
import { createServiceBridge } from './service-bridge.ts'
import { createSettingsStore, sessionFilePath, settingsFilePath } from './settings-store.ts'
import { createTray, focusWindow, markQuitting, shouldHideOnClose } from './tray.ts'
import { dataDir } from './paths.ts'

/**
 * docvi 主进程入口。
 *
 * 启动顺序有硬约束：自定义协议必须在 app.ready 之前声明为 privileged，
 * 否则注册时已错过 Chromium 的 scheme 决策窗口，模块脚本会被当成不透明资源。
 */

/**
 * dev / prod 的判定不能只看 isPackaged：直接 `electron .` 跑构建产物时
 * isPackaged 也是 false，会误加载 Vite dev server（端口没开就白屏）。
 * 因此以「显式设置 DOCVI_RENDERER_URL」作为 dev 的唯一开关。
 */
const DEV_URL = process.env.DOCVI_RENDERER_URL
const RENDERER_DIST = join(__dirname, '../renderer')

/**
 * 身份必须在任何 getPath('userData') / 单实例锁之前确定。
 *
 * 不设的话 Electron 会用 package.json 的 name（`@docvi/desktop`）拼数据目录，
 * 得到 `%APPDATA%/@docvi/desktop` 这种带斜杠的路径——既难看又会与后续版本
 * 迁移规则对不上。
 *
 * `DOCVI_INSTANCE` 覆盖：单实例锁按应用名全局生效，自动化验收要与用户实例
 * 并存就必须换名字（配合 `DOCVI_DATA_DIR` 隔离数据）。
 */
app.setName(process.env.DOCVI_INSTANCE?.trim() || 'docvi')

/**
 * 覆盖式滚动条。
 *
 * 不开这个特性时，Windows 上即使写 `scrollbar-width: thin` 也还是经典滚动条，
 * 会实打实占掉 10px 布局宽度——标签条被压矮、正文被挤窄都源于此；而且它只有
 * 系统样式，压不住。开启后滚动条浮在内容之上、随滚动自动淡出，`scrollbar-color`
 * 也能生效（Chromium 152 实测：占位 0px）。
 */
app.commandLine.appendSwitch('enable-features', 'OverlayScrollbar')

/**
 * 远程调试端口：只在**显式设置环境变量**时开启。
 *
 * 验收脚本要用 CDP 驱动真实窗口（工具栏 tooltip、标签拖拽这类只能在真窗口里
 * 验的行为）。默认关闭，避免打包产物永远开着一个调试入口。
 */
if (process.env.DOCVI_DEBUG_PORT) {
  const port = Number(process.env.DOCVI_DEBUG_PORT)
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    app.commandLine.appendSwitch('remote-debugging-port', String(port))
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'docvi',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

/**
 * 从启动参数里挑出要打开的 Markdown 文件。
 *
 * `electron .` 会把应用目录作为 argv[1]；打包后第二个实例由系统带文件路径
 * （文件关联双击）。因此只认「存在且以 .md 结尾」的参数，其余一律忽略——
 * 不去猜 Chromium 的开关参数，避免把 `--user-data-dir=...` 当成文档打开。
 */
function markdownArgs(argv: string[]): string[] {
  return argv.filter(arg => !arg.startsWith('-') && /\.md$/i.test(arg))
}

/**
 * 无头运行：自动化截图与验收专用。
 *
 * 为什么是环境变量而不是设置项：这是**测试夹具的关注点**，不是用户会去切的
 * 开关。一次截图要开十几次应用，每次都弹一个窗口到最前面，等于把正在用电脑的
 * 人按住；而截图走的 CDP 完全不需要窗口可见。
 *
 * 开启后不建托盘图标、窗口停到屏幕之外、不抢焦点。与 `DOCVI_DATA_DIR` /
 * `DOCVI_INSTANCE` 配合使用，保证不碰真实数据。
 */
const HEADLESS = process.env.DOCVI_HEADLESS === '1'

/**
 * 把窗口停到所有显示器之外。
 *
 * 只改原点不改尺寸：CDP 截图与 `getBoundingClientRect` 都依赖真实布局尺寸。
 * 而完全 `show: false` 的窗口在部分 Windows 驱动下拿不到合成帧（截图全黑），
 * 所以这里真的把窗口显示出来，只是放在任何显示器都够不到的位置，且用
 * `showInactive` 不抢焦点。
 */
function parkWindowOffscreen(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const bounds = win.getBounds()
  win.setBounds({ ...bounds, x: -32_000, y: -32_000 })
  win.setSkipTaskbar(true)
  win.webContents.setBackgroundThrottling(false)
  win.showInactive()
}

// 单实例：第二次启动只唤起已有窗口，不新开进程
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
/** 窗口未就绪前收到的打开请求先排队，渲染进程就绪后统一投递 */
let pendingPaths: string[] = []
/** 渲染进程是否已挂载监听（以它拉取队列为信号，避免 send 丢消息） */
let rendererReady = false

/** 关闭窗口是否留在托盘。由设置驱动，close 处理器读它（所以必须是模块级） */
let closeToTrayEnabled = false
let trayHandle: ReturnType<typeof createTray> | null = null

/**
 * 窗口按钮（最小化/最大化/关闭）的当前配色。
 *
 * Windows 的 titleBarOverlay 是**原生**绘制，不读页面的 CSS 变量：主题切到浅色后
 * 页面变白了，窗口按钮仍是深色底 + 浅色符号，右上角永远是一块黑。必须由主进程
 * 显式 setTitleBarOverlay 换色——这里与 `--dv-ui-bg` / `--dv-ui-text` 保持同值。
 */
type WindowAppearance = 'light' | 'dark'
/**
 * 当前明暗。主进程只认明暗，不认主题 id——插件主题是运行期才注册的，
 * 主进程按 id 猜不到深浅；渲染层切换主题时通过 IPC 推解析后的结果。
 */
let windowAppearance: WindowAppearance = 'dark'

function windowChromeColors(appearance: WindowAppearance): {
  color: string
  symbolColor: string
} {
  /*
   * 与 theme.css 的 `--dv-ui-bg` / `--dv-ui-text` 同值（默认主题 slate / mist）。
   * 内置主题从暖色改中性后这里必须同步，否则窗口按钮底色与页面顶栏差一档色。
   */
  return appearance === 'light'
    ? { color: '#f7f8fa', symbolColor: '#1a1d22' }
    : { color: '#14161a', symbolColor: '#c3c7ce' }
}

/** 应用窗口 chrome 配色（Windows 才有 overlay；其余平台是系统自绘） */
function applyWindowAppearance(appearance: WindowAppearance): void {
  windowAppearance = appearance
  if (process.platform !== 'win32' || !mainWindow) return
  try {
    mainWindow.setTitleBarOverlay({ ...windowChromeColors(appearance), height: 44 })
  } catch {
    // 窗口已销毁：下一次创建时按 windowAppearance 重来
  }
}

function createWindow(): void {
  const chrome = windowChromeColors(windowAppearance)
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'docvi',
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',
    ...(process.platform === 'win32' ? { titleBarOverlay: { ...chrome, height: 44 } } : {}),
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 14 } } : {}),
    webPreferences: {
      // CJS：sandbox 渲染进程只认 CommonJS preload（ESM 会被静默忽略）
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return
    if (HEADLESS) parkWindowOffscreen(mainWindow)
    else mainWindow.show()
  })

  /*
   * 关闭窗口的决策只在这里做：
   * 「关闭留托盘」开启时，关窗口只是隐藏——服务进程继续跑，MCP 与分享不断。
   * 用户从托盘菜单点「退出」时 markQuitting() 已置位，这里放行真正关闭。
   */
  mainWindow.on('close', event => {
    if (!shouldHideOnClose(closeToTrayEnabled, trayHandle !== null)) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  // 外链一律交给系统浏览器，且只放行 http(s)——防止文档里的自定义协议被利用
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * 兜住「整窗导航」：SPA 里任何漏拦的链接都会把当前页换成目标地址——
   * 应用界面、标签状态、路由历史一起消失，用户看到的就是「点一下界面空了」。
   * 渲染层已经逐个接管正文链接，这里是最后一道防线：
   * 只允许应用自己的入口（dev server / docvi://app），外链交系统浏览器。
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('docvi://app/')
    if (allowed) return
    event.preventDefault()
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })

  if (DEV_URL) {
    void mainWindow.loadURL(DEV_URL)
  } else {
    void mainWindow.loadURL('docvi://app/index.html')
  }
}

/**
 * 把待打开路径投递给渲染进程。
 *
 * 渲染进程尚未挂载监听时 send 会丢消息，因此只认它自己拉取队列那一刻
 * （`appPendingPaths`）作为「已就绪」——这是命令行带文件启动能否生效的时序关键。
 */
function flushPendingPaths(): void {
  if (!mainWindow || !rendererReady || !pendingPaths.length) return
  const paths = pendingPaths
  pendingPaths = []
  for (const path of paths) mainWindow.webContents.send(IPC.appOpenPath, path)
}

function openPath(path: string): void {
  pendingPaths.push(path)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    flushPendingPaths()
  }
}

/** 渲染进程启动时拉取队列：同时把它标记为已就绪 */
function takePendingPaths(): string[] {
  rendererReady = true
  const paths = pendingPaths
  pendingPaths = []
  return paths
}

/**
 * 插件资源协议。
 *
 * `docvi://plugin/<pluginId>/<包内相对路径>` → 插件目录内的文件。
 * 三道防线：
 *  1. 插件 id 必须能在 store 里查到（不用 URL 里的路径拼目录）；
 *  2. 相对路径经 resolvePluginAsset 规范化后必须仍在插件目录内；
 *  3. 只服务存在的普通文件。
 */
function handlePluginRequest(url: URL, plugins: PluginStore): Promise<Response> | Response {
  const segments = url.pathname.split('/').filter(Boolean)
  const pluginId = segments.shift()
  if (!pluginId) return new Response('Not Found', { status: 404 })
  const record = plugins.find(decodeURIComponent(pluginId))
  if (!record) return new Response('Not Found', { status: 404 })
  const rel = segments.map(segment => decodeURIComponent(segment)).join('/')
  const target = resolvePluginAsset(record.dir, rel)
  if (!target) return new Response('Forbidden', { status: 403 })
  return net.fetch(pathToFileURL(target).toString())
}

/**
 * 正文资产协议：`docvi://asset/<工作区 id>/<内容根内路径>`。
 *
 * 文档里的 `![](img/a.png)` 被渲染管线归一成**根相对**路径（`/img/a.png`），
 * 这是「从内容根伺服资产」的约定。容器版内容根就是 URL 前缀，浏览器直接取；
 * 桌面版没有这样的 URL 空间，若不对接，图片会落到 `docvi://app/img/a.png`
 * ——那是渲染产物目录，必然 404（用户看到的是一张破图）。
 *
 * 只按**登记过的工作区 id** 取根，绝不接受绝对路径：URL 里没有磁盘路径可注入。
 * 解析后再做一次 containment，挡住 `..` 与符号链接逃逸。
 */
async function handleAssetRequest(url: URL, workspaces: WorkspaceStore): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean)
  const workspaceId = segments.shift()
  if (!workspaceId) return new Response('Not Found', { status: 404 })
  const entry = workspaces.find(decodeURIComponent(workspaceId))
  if (!entry) return new Response('Not Found', { status: 404 })

  const rel = segments.map(segment => decodeURIComponent(segment)).join('/')
  if (!rel) return new Response('Not Found', { status: 404 })
  const root = resolve(entry.root)
  const target = resolve(root, rel)
  if (target !== root && !target.startsWith(root + sep)) {
    return new Response('Forbidden', { status: 403 })
  }
  return net.fetch(pathToFileURL(target).toString())
}

/**
 * 单文件文档的资产请求：`docvi://local/<id>/<文件名>`。
 *
 * id 由主进程在 `fileRead` 时登记（见 local-assets.ts），协议侧只做反查 +
 * containment。渲染层无法凭空构造一个可访问的根：id 是路径摘要，猜不出来，
 * 且只登记用户真正打开过的文档。
 */
async function handleLocalAssetRequest(
  url: URL,
  localAssets: LocalAssetRegistry,
): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean)
  const id = segments.shift()
  if (!id) return new Response('Not Found', { status: 404 })
  const root = localAssets.rootOf(decodeURIComponent(id))
  if (!root) return new Response('Not Found', { status: 404 })

  const rel = segments.map(segment => decodeURIComponent(segment)).join('/')
  if (!rel) return new Response('Not Found', { status: 404 })
  const target = resolve(root, rel)
  if (target !== root && !target.startsWith(root + sep)) {
    return new Response('Forbidden', { status: 403 })
  }
  // 解析真实路径再判一次：拦住「符号链接指到资产根外」这类逃逸
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return new Response('Not Found', { status: 404 })
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    return new Response('Forbidden', { status: 403 })
  }
  return net.fetch(pathToFileURL(real).toString())
}

function registerProtocol(
  plugins: PluginStore,
  workspaces: WorkspaceStore,
  localAssets: LocalAssetRegistry,
): void {
  protocol.handle('docvi', request => {
    const url = new URL(request.url)
    if (url.host === 'plugin') return handlePluginRequest(url, plugins)
    if (url.host === 'asset') return handleAssetRequest(url, workspaces)
    if (url.host === 'local') return handleLocalAssetRequest(url, localAssets)
    if (url.host !== 'app') return new Response('Not Found', { status: 404 })

    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    // 路径穿越防线：规范化后仍包含 .. 段一律拒绝
    if (rel.split(/[/\\]/).some(seg => seg === '..')) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(join(RENDERER_DIST, rel)).toString())
  })
}

app.on('second-instance', (_event, argv) => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
  for (const path of markdownArgs(argv)) openPath(path)
})

// macOS：双击关联文件 / 拖到 Dock 图标
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (/\.md$/i.test(path)) openPath(path)
})

app.whenReady().then(() => {
  /*
   * 清理上一次更新留下的半成品（`.part` / 安装脚本）。
   * 必须早于任何窗口创建：这些文件只是临时产物，留着占空间还容易被误点。
   */
  pruneUpdateCache()

  const plugins = createPluginStore({
    // dev：仓库 plugins/；打包后：resources/plugins
    builtinDir: app.isPackaged
      ? join(process.resourcesPath, 'plugins')
      : join(__dirname, '../../../../plugins'),
    userDir: join(dataDir(), 'plugins'),
    stateFile: join(dataDir(), 'plugins-state.json'),
  })

  // 工作区表要在协议注册前建好：`docvi://asset/<id>/…` 靠它把 id 换成根目录
  const workspaces = createStore()
  // 单文件文档的资产根：同样必须在协议注册前存在
  const localAssets = createLocalAssetRegistry()

  registerProtocol(plugins, workspaces, localAssets)

  const watcher = createFileWatcher(
    path => {
      // 只推给窗口：由渲染层判断「缓冲区是否有改动」，主进程不持有编辑状态
      mainWindow?.webContents.send(IPC.docExternalChange, path)
    },
    change => {
      /*
       * 目录结构变化：推给所有窗口。
       *
       * 用 getAllWindows 而不是 mainWindow：ipc.ts 里 settings 的同类推送也这么做，
       * 主进程不该假设「哪个窗口是主窗口」。多窗口时每个都要重扫自己的树。
       */
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC.workspaceFilesChanged, change)
      }
    },
    // 排除规则必须与目录扫描共用一份：否则 .git 里的写入会触发整树重扫
    { isRelevant: isContentRelPath },
  )

  const settings = createSettingsStore({
    settingsFile: settingsFilePath(dataDir()),
    sessionFile: sessionFilePath(dataDir()),
  })
  const service = createServiceBridge(
    createServiceManager(serviceEntryPath(__dirname)),
    workspaces,
    plugins,
    dataDir(),
  )
  // 服务状态变化 → 渲染层（启动失败、端口顺延、崩溃重启都要能被看见）
  service.onState(state => mainWindow?.webContents.send(IPC.serviceChanged, state))

  /*
   * 外壳行为（自启动 / 关闭留托盘）。
   *
   * 托盘只在「关闭留托盘」开启时创建：没开却常驻一个托盘图标，用户会觉得
   * 关不干净。自启动读注册表实际值——设置文件只是愿望，注册表才是事实
   * （用户可能手动删掉了 Run 键，这时 UI 必须显示为「关闭」）。
   */
  closeToTrayEnabled = settings.get().desktop.closeToTray
  // 建窗之前先定好配色：否则浅色主题启动会闪一帧深色窗口按钮
  windowAppearance = settings.get().theme === 'paper' ? 'light' : 'dark'

  const showWindow = (): void => {
    if (!mainWindow) {
      createWindow()
      return
    }
    focusWindow(mainWindow)
  }

  const ensureTray = (): void => {
    // 无头运行时托盘图标本身就是桌面上的可见残留，而它也没有东西可点
    if (HEADLESS) return
    if (closeToTrayEnabled && !trayHandle) {
      trayHandle = createTray({
        statusLabel: () => {
          const state = service.state()
          return state.running ? `MCP :${state.port}` : '服务未运行'
        },
        show: showWindow,
        quit: () => {
          markQuitting()
          app.quit()
        },
      })
    }
  }
  ensureTray()

  // 启动时按设置文件里的愿望对齐注册表：两边不一致时以愿望为准修一次
  void (async () => {
    const desired = settings.get().desktop.autostart
    const actual = await readAutostart()
    if (actual.error) return
    if (desired !== actual.enabled) await writeAutostart(desired)
  })()

  const desktopHost: DesktopHostOptions = {
    async desktopPrefs() {
      const autostart = await readAutostart()
      return {
        // 优先报告注册表实际值：设置文件与磁盘不一致时，用户该看到磁盘的真相
        autostart: autostart.enabled,
        autostartCommand: autostart.command,
        closeToTray: settings.get().desktop.closeToTray,
        error: autostart.error,
      }
    },
    async setAutostart(enabled) {
      const next = await writeAutostart(enabled)
      if (!next.error) settings.update({ desktop: { autostart: enabled } })
      const current = await readAutostart()
      return {
        autostart: current.enabled,
        autostartCommand: current.command,
        closeToTray: settings.get().desktop.closeToTray,
        error: next.error ?? current.error,
      }
    },
    async setCloseToTray(enabled) {
      settings.update({ desktop: { closeToTray: enabled } })
      closeToTrayEnabled = enabled
      if (enabled) {
        ensureTray()
      } else {
        // 关掉这个开关就不该再有托盘图标：先销毁，否则用户找不到入口关它
        trayHandle?.destroy()
        trayHandle = null
        // 窗口若此刻是隐藏状态（之前被「留托盘」藏起来），必须重新显示，
        // 否则应用会变成「没有窗口也没有托盘」的幽灵进程
        if (mainWindow && !mainWindow.isVisible()) mainWindow.show()
      }
      return {
        autostart: (await readAutostart()).enabled,
        autostartCommand: (await readAutostart()).command,
        closeToTray: enabled,
        error: null,
      }
    },
    pushGitProgress(event) {
      // 广播给所有窗口：克隆可能从任一窗口发起，进度不该只回给发起者
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.gitProgress, event)
      }
    },
    setWindowTheme(appearance) {
      applyWindowAppearance(appearance === 'light' ? 'light' : 'dark')
    },
  }

  registerIpc(
    workspaces,
    createRecent(),
    watcher,
    plugins,
    service,
    settings,
    desktopHost,
    localAssets,
  )

  // preload 在窗口创建前同步取一次设置：避免首帧用默认主题再切回来（闪一下）。
  // 这是唯一一个同步 IPC：只发生在进程启动阶段，且返回值极小。
  ipcMain.on(IPC.settingsSnapshot, event => {
    event.returnValue = settings.get()
  })

  // 窗口关闭时释放所有文件监视句柄
  app.on('before-quit', () => {
    // 先置位：close 处理器据此放行真正的关闭（否则托盘会把退出拦下来）
    markQuitting()
    watcher.closeAll()
    trayHandle?.destroy()
    trayHandle = null
    // 服务是独立进程：不显式停掉的话会留一个后台进程占端口
    service.stop()
  })

  // 「待打开队列」只在主进程有状态，直接在这里挂 handler，避免 ipc.ts 反向依赖入口
  ipcMain.handle(IPC.appPendingPaths, () => ({ ok: true, data: takePendingPaths() }))

  const initialPaths = markdownArgs(process.argv)
  if (initialPaths.length) pendingPaths.push(...initialPaths)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // 开了「关闭留托盘」时窗口只是隐藏，不会走到这里；真的没有窗口了才退出
  if (process.platform !== 'darwin' && !closeToTrayEnabled) app.quit()
})
