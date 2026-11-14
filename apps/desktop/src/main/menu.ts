import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

import type { MenuAction } from '@docvi/shared'

/**
 * macOS 原生应用菜单。
 *
 * 为什么必须自己装一份，而不是用 Electron 的默认菜单：
 *  1. 默认菜单把 ⌘W 绑成「关闭窗口」，会抢走渲染层的「关闭当前标签」；
 *  2. 默认菜单在生产包里仍暴露 Reload / Toggle DevTools；
 *  3. 默认菜单是英文的，也没有 ⌘, 打开设置。
 *
 * 只装 macOS：Windows / Linux 的窗口是无边框 + 自绘标题栏，原生菜单条会多占
 * 一行把布局顶歪；那两个平台的快捷键仍由渲染层自己处理。
 *
 * 加速键由菜单接管后页面收不到同一个按键，因此「打开文件 / 关闭标签 / 设置 /
 * 快捷键」都通过 IPC 回到渲染层执行，不在主进程各写一套打开逻辑。
 */

export interface ApplicationMenuOptions {
  /** 开发态才暴露重新加载与开发者工具 */
  isDev: boolean
  /** 把菜单动作发回渲染层 */
  send: (action: MenuAction) => void
  /** 无窗口时从 Dock 菜单唤起主窗口 */
  showWindow: () => void
}

export function installApplicationMenu(options: ApplicationMenuOptions): void {
  if (process.platform !== 'darwin') return

  app.setAboutPanelOptions({
    applicationName: 'docvi',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © docvi contributors',
  })

  const { send } = options
  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: 'about', label: '关于 docvi' },
      { type: 'separator' },
      {
        label: '设置…',
        accelerator: 'Command+,',
        click: () => send('settings'),
      },
      { type: 'separator' },
      { role: 'services', label: '服务', submenu: [] },
      { type: 'separator' },
      { role: 'hide', label: '隐藏 docvi' },
      { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '全部显示' },
      { type: 'separator' },
      { role: 'quit', label: '退出 docvi' },
    ],
  }

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件…',
          accelerator: 'Command+O',
          click: () => send('openFile'),
        },
        {
          label: '打开最近使用',
          role: 'recentDocuments',
          submenu: [{ label: '清除最近使用', role: 'clearRecentDocuments' }],
        },
        { type: 'separator' },
        {
          label: '关闭标签',
          // 关键：⌘W 属于标签，不属于窗口。默认菜单会把这一键抢走。
          accelerator: 'Command+W',
          click: () => send('closeTab'),
        },
        {
          label: '关闭窗口',
          accelerator: 'Command+Shift+W',
          click: () => BrowserWindow.getFocusedWindow()?.close(),
        },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        ...(options.isDev
          ? ([
              { role: 'reload', label: '重新加载' },
              { role: 'forceReload', label: '强制重新加载' },
              { role: 'toggleDevTools', label: '开发者工具' },
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])
          : []),
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于顶层' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '键盘快捷键',
          accelerator: 'Command+/',
          click: () => send('shortcuts'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // Dock 右键菜单：macOS 上用户最常用的「无窗口唤回」入口
  app.dock?.setMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: options.showWindow },
      { label: '设置…', click: () => send('settings') },
    ]),
  )
}
