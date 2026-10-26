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
  // 打包后 build/icon.png 经 electron-builder 落到 resources 根
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build/icon.png')
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
  const image = nativeImage.createFromPath(iconPath())
  // 空图标也能创建 Tray，但会显示成透明方块；宁可缩一个默认尺寸的占位
  tray = new Tray(
    image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 }),
  )
  tray.setToolTip('docvi')

  const build = (): Menu =>
    Menu.buildFromTemplate([
      { label: 'docvi', enabled: false },
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

  // 左键单击唤起窗口；右键由系统弹菜单，与 Windows 托盘惯例一致
  tray.on('click', options.show)

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
