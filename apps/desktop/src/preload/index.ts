import { contextBridge, ipcRenderer, webUtils } from 'electron'

import {
  IPC,
  type AppSettings,
  type DocviApi,
  type GitProgressEvent,
  type ServiceState,
  type UpdateProgress,
} from '@docvi/shared'

/**
 * preload：渲染进程能看到的全部宿主能力。
 *
 * 只暴露具名方法，不透传 ipcRenderer——渲染进程拿不到任意通道，也无法
 * 伪造 channel 调用主进程未注册的 handler。
 */
/**
 * 启动设置快照：同步取一次。
 *
 * 为什么允许这一处同步 IPC——主题若等异步返回再应用，首帧会用默认配色渲染
 * 一帧再跳变（实测可见白闪）。只在 preload 加载期发生一次，成本可忽略。
 */
const bootSettings = ipcRenderer.sendSync(IPC.settingsSnapshot) as AppSettings

const api: DocviApi = {
  bootSettings,

  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  appOpenExternal: url => ipcRenderer.invoke(IPC.appOpenExternal, url),
  appRuntimeInfo: () => ipcRenderer.invoke(IPC.appRuntimeInfo),
  appUpdateCheck: () => ipcRenderer.invoke(IPC.appUpdateCheck),
  appUpdateDownload: request => ipcRenderer.invoke(IPC.appUpdateDownload, request),
  appUpdateCancel: () => ipcRenderer.invoke(IPC.appUpdateCancel),
  appUpdateInstall: () => ipcRenderer.invoke(IPC.appUpdateInstall),
  onUpdateProgress: callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      // 形状在这里收口：渲染层永远拿到一个对象，不会因为主进程多传字段就崩
      if (payload && typeof payload === 'object') callback(payload as UpdateProgress)
    }
    ipcRenderer.on(IPC.appUpdateProgress, listener)
    return () => ipcRenderer.removeListener(IPC.appUpdateProgress, listener)
  },
  appPendingPaths: () => ipcRenderer.invoke(IPC.appPendingPaths),

  workspaceList: () => ipcRenderer.invoke(IPC.workspaceList),
  workspaceAdd: () => ipcRenderer.invoke(IPC.workspaceAdd),
  workspacePick: () => ipcRenderer.invoke(IPC.workspacePick),
  workspaceAddAt: root => ipcRenderer.invoke(IPC.workspaceAddAt, root),
  workspaceProbe: root => ipcRenderer.invoke(IPC.workspaceProbe, root),

  gitState: () => ipcRenderer.invoke(IPC.gitState),
  gitClone: input => ipcRenderer.invoke(IPC.gitClone, input),
  gitPull: id => ipcRenderer.invoke(IPC.gitPull, id),
  gitBranches: id => ipcRenderer.invoke(IPC.gitBranches, id),
  gitSwitchBranch: (id, branch) => ipcRenderer.invoke(IPC.gitSwitchBranch, id, branch),
  onGitProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: GitProgressEvent): void =>
      callback(progress)
    ipcRenderer.on(IPC.gitProgress, listener)
    return () => {
      ipcRenderer.removeListener(IPC.gitProgress, listener)
    }
  },
  workspaceRemove: id => ipcRenderer.invoke(IPC.workspaceRemove, id),
  workspaceTouch: id => ipcRenderer.invoke(IPC.workspaceTouch, id),

  treeList: workspaceId => ipcRenderer.invoke(IPC.treeList, workspaceId),
  docRead: (workspaceId, path) => ipcRenderer.invoke(IPC.docRead, workspaceId, path),

  fsCreate: (workspaceId, dirRelPath, name, kind) =>
    ipcRenderer.invoke(IPC.fsCreate, workspaceId, dirRelPath, name, kind),
  fsRename: (workspaceId, relPath, nextName) =>
    ipcRenderer.invoke(IPC.fsRename, workspaceId, relPath, nextName),
  fsMove: (workspaceId, relPath, targetDir) =>
    ipcRenderer.invoke(IPC.fsMove, workspaceId, relPath, targetDir),
  fsCopy: (workspaceId, relPath, targetDir) =>
    ipcRenderer.invoke(IPC.fsCopy, workspaceId, relPath, targetDir),
  fsTrash: (workspaceId, relPath) => ipcRenderer.invoke(IPC.fsTrash, workspaceId, relPath),

  imageImport: request => ipcRenderer.invoke(IPC.imageImport, request),
  imagePick: request => ipcRenderer.invoke(IPC.imagePick, request),

  filePick: () => ipcRenderer.invoke(IPC.filePick),
  fileRead: absolutePath => ipcRenderer.invoke(IPC.fileRead, absolutePath),

  /**
   * 本地预览是容器读者面的能力（浏览器 File API 读文件进内存）。
   * 桌面端有真实磁盘与工作区，这个入口不该出现；给 null 而不是报错，
   * 是为了契约两端形状一致。
   */
  localPreview: async () => ({ ok: true, data: null }),

  searchCorpus: workspaceId => ipcRenderer.invoke(IPC.searchCorpus, workspaceId),

  recentList: () => ipcRenderer.invoke(IPC.recentList),
  recentTouch: entry => ipcRenderer.invoke(IPC.recentTouch, entry),
  recentClear: () => ipcRenderer.invoke(IPC.recentClear),

  /**
   * 订阅外部打开请求。
   *
   * 回调只接受路径字符串——主进程发来的 payload 也要在边界上做形状校验，
   * 防止将来通道被误用时把任意对象塞进渲染层。
   */
  onOpenPath: callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (typeof payload === 'string' && payload) callback(payload)
    }
    ipcRenderer.on(IPC.appOpenPath, listener)
    return () => ipcRenderer.removeListener(IPC.appOpenPath, listener)
  },

  /**
   * 拖放文件取磁盘路径。
   *
   * 沙箱渲染进程拿不到 `File.path`（Electron 32 起已移除），唯一合法途径是
   * 在 preload 里调 webUtils.getPathForFile——必须与 File 对象在同一个进程。
   */
  pathsForFiles: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),

  docWrite: request => ipcRenderer.invoke(IPC.docWrite, request),
  docExport: request => ipcRenderer.invoke(IPC.docExport, request),
  draftRead: absolutePath => ipcRenderer.invoke(IPC.draftRead, absolutePath),
  draftWrite: (absolutePath, text) => ipcRenderer.invoke(IPC.draftWrite, absolutePath, text),
  draftClear: absolutePath => ipcRenderer.invoke(IPC.draftClear, absolutePath),

  /** 外部改动订阅：同样只透传字符串，形状在这里收口 */
  onExternalChange: callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (typeof payload === 'string' && payload) callback(payload)
    }
    ipcRenderer.on(IPC.docExternalChange, listener)
    return () => ipcRenderer.removeListener(IPC.docExternalChange, listener)
  },

  docWatch: absolutePath => ipcRenderer.invoke(IPC.docWatch, absolutePath),
  docUnwatch: absolutePath => ipcRenderer.invoke(IPC.docUnwatch, absolutePath),

  /** 目录结构变化订阅：同样只透传形状，渲染层永远拿到对象 */
  onWorkspaceFilesChanged: callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (!payload || typeof payload !== 'object') return
      const change = payload as { workspaceId?: unknown; paths?: unknown }
      if (typeof change.workspaceId !== 'string' || !change.workspaceId) return
      callback({
        workspaceId: change.workspaceId,
        paths: Array.isArray(change.paths) ? change.paths.filter(p => typeof p === 'string') : [],
      })
    }
    ipcRenderer.on(IPC.workspaceFilesChanged, listener)
    return () => ipcRenderer.removeListener(IPC.workspaceFilesChanged, listener)
  },
  workspaceWatch: workspaceId => ipcRenderer.invoke(IPC.workspaceWatch, workspaceId),
  workspaceUnwatch: workspaceId => ipcRenderer.invoke(IPC.workspaceUnwatch, workspaceId),

  pluginList: () => ipcRenderer.invoke(IPC.pluginList),
  pluginMarket: options => ipcRenderer.invoke(IPC.pluginMarket, options),
  pluginInstall: () => ipcRenderer.invoke(IPC.pluginInstall),
  pluginUninstall: id => ipcRenderer.invoke(IPC.pluginUninstall, id),
  pluginSetEnabled: (id, enabled) => ipcRenderer.invoke(IPC.pluginSetEnabled, id, enabled),
  pluginSetComponentEnabled: (id, kind, enabled) =>
    ipcRenderer.invoke(IPC.pluginSetComponentEnabled, id, kind, enabled),

  serviceState: () => ipcRenderer.invoke(IPC.serviceState),
  serviceRestart: () => ipcRenderer.invoke(IPC.serviceRestart),
  serviceSetLan: lan => ipcRenderer.invoke(IPC.serviceSetLan, lan),
  serviceSetPort: port => ipcRenderer.invoke(IPC.serviceSetPort, port),
  serviceOpenLog: () => ipcRenderer.invoke(IPC.serviceOpenLog),

  desktopPrefs: () => ipcRenderer.invoke(IPC.desktopPrefs),
  desktopSetAutostart: enabled => ipcRenderer.invoke(IPC.desktopSetAutostart, enabled),
  desktopSetCloseToTray: enabled => ipcRenderer.invoke(IPC.desktopSetCloseToTray, enabled),
  onServiceChanged: callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      // 形状校验在边界收口：只透传带 running 布尔字段的对象
      if (
        payload &&
        typeof payload === 'object' &&
        'running' in payload &&
        typeof (payload as { running: unknown }).running === 'boolean'
      ) {
        callback(payload as ServiceState)
      }
    }
    ipcRenderer.on(IPC.serviceChanged, listener)
    return () => ipcRenderer.removeListener(IPC.serviceChanged, listener)
  },

  shareList: () => ipcRenderer.invoke(IPC.shareList),
  shareCreate: () => ipcRenderer.invoke(IPC.shareCreate),
  shareCreatePath: absolutePath => ipcRenderer.invoke(IPC.shareCreatePath, absolutePath),
  shareRemove: id => ipcRenderer.invoke(IPC.shareRemove, id),
  shareOpen: id => ipcRenderer.invoke(IPC.shareOpen, id),

  settingsRead: () => ipcRenderer.invoke(IPC.settingsRead),
  settingsWrite: patch => ipcRenderer.invoke(IPC.settingsWrite, patch),
  setWindowAppearance: appearance => ipcRenderer.invoke(IPC.windowAppearance, appearance),
  onSettingsChanged: callback => {
    const listener = (_event: unknown, payload: unknown): void => {
      if (payload && typeof payload === 'object' && 'theme' in payload) {
        callback(payload as AppSettings)
      }
    }
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
  },

  sessionRead: () => ipcRenderer.invoke(IPC.sessionRead),
  sessionWrite: session => ipcRenderer.invoke(IPC.sessionWrite, session),
}

contextBridge.exposeInMainWorld('docvi', api)
