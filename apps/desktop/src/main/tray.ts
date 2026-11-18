import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'

/**
 * 托盘。
 *
 * 存在意义：**关掉窗口不等于关掉服务**。MCP 端点与分享链接在窗口关掉后仍要
 * 可用，否则「AI 随时能查文档」这件事就不成立。托盘是用户在无窗口时唯一的
 * 可见入口与退出入口。
 *
 * 三个必须处理的细节：
 *  1. 图标路径在 dev 与打包后不同（dev 在应用目录，打包在 resources）；
 *  2. 托盘对象必须被模块级变量持有——局部变量会被 GC，图标随即消失；
 *  3. 「拦下关闭」的判断只允许有一处（见 shouldHideOnClose），散在事件里迟早
 *     出现「有托盘却退不掉」或「没托盘但服务还在跑」。
 */

let tray: Tray | null = null
/** true = 正在真正退出；before-quit 置位，close 处理器据此放行 */
let quitting = false

export function isQuitting(): boolean {
  return quitting
}

export function markQuitting(): void {
  quitting = true
}

function iconPath(): string {
  /*
   * macOS 菜单栏图标必须是 template image：只取 alpha 通道，由系统按菜单栏
   * 明暗自动上色。彩色 tray.png 在深色菜单栏里会变成一块看不清的色斑；
   * 32px 的尺寸也不是菜单栏的 16pt 槽位。
   */
  if (process.platform === 'darwin') {
    return app.isPackaged
      ? join(process.resourcesPath, 'trayTemplate.png')
      : join(app.getAppPath(), 'build/trayTemplate.png')
  }
  // 打包后 build/tray.png 经 electron-builder 落到 resources 根
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(app.getAppPath(), 'build/tray.png')
}

export interface TrayOptions {
  /** 内部 ID label 行（显示运行状态） */
  statusLabel: () => string
  /** 打开主窗口 */
  show: () => void
  /** 退出应用 */
  quit: () => void
}

export interface TrayHandle {
  /** 服务状态变化后刷新菜单里的状态行 */
  refresh: () => void
  destroy: () => void
}

export function createTray(options: TrayOptions): TrayHandle {
  // 图标直接就用预生成的 32px 简化版，**不要再 resize 到 16**。
  //
  // Windows 托盘按 DPI 缩放给出实际槽位（100%→16px、150%→24px、200%→32px）。
  // 以前从 1024 缩到 16 再交给系统放大到 24，是两次重采样：先丢掉一半信息，
  // 再让系统用双线性插值猜回来——100% 缩放时看着还行，150% 屏幕上就明显发糊。
  // 给 32px 让系统单次降采样，任何 DPI 档都只经历一次滤波。
  // （32px 也是简化版：托盘最小档 16px 下正文短线只剩 0.75 像素，会糊成灰纹。）
  const image = nativeImage.createFromPath(iconPath())
  // 必须在交给 Tray 之前标记：macOS 只在该标记存在时按菜单栏明暗重绘
  if (process.platform === 'darwin') image.setTemplateImage(true)
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image)
  /*
   * 用 `app.getName()` 而不是字面量 'docvi'：开发版叫 `docvi dev`，
   * 与安装版并排显示时用户能一眼看出哪个是哪个（两者数据目录已隔离）。
   */
  const appLabel = app.getName()
  tray.setToolTip(appLabel)

  const build = (): Menu =>
    Menu.buildFromTemplate([
      { label: appLabel, enabled: false },
      { label: options.statusLabel(), enabled: false },
      { type: 'separator' },
      { label: '打开主窗口', click: options.show },
      { type: 'separator' },
      { label: '退出', click: options.quit },
    ])

  const apply = (): void => {
    tray?.setContextMenu(build())
  }
  apply()

  /*
   * Windows：左键唤起窗口，右键由系统弹菜单。
   * macOS：设置 contextMenu 后左键本来就弹菜单；再绑 click 会导致「菜单和窗口
   * 同时出现」。mac 用户点图标就是要看菜单，双击再唤起窗口。
   */
  if (process.platform === 'darwin') tray.on('double-click', options.show)
  else tray.on('click', options.show)

  return {
    refresh: apply,
    destroy() {
      tray?.destroy()
      tray = null
    },
  }
}

/**
 * 关闭窗口时的统一决策。
 *
 * true = 拦下关闭（隐藏到托盘）；false = 允许真正关闭。
 */
export function shouldHideOnClose(closeToTray: boolean, hasTray: boolean): boolean {
  return closeToTray && hasTray && !quitting
}

/** 从托盘唤起窗口：最小化要还原、隐藏要显示，然后聚焦 */
export function focusWindow(window: BrowserWindow | null): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}
