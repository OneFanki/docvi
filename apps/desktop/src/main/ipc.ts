import { ipcMain, dialog, BrowserWindow, app, net, shell } from 'electron'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import {
  IPC,
  isErrorCode,
  type DesktopPrefsState,
  type ErrorCode,
  type GitProgressEvent,
  type GitState,
  type MarketCatalog,
  type PluginRecordView,
  type RecentEntry,
  type RuntimeInfo,
  type UpdateCheckResult,
  type Result,
  type ServiceState,
  type WorkspaceEntry,
  type WorkspaceProbeResult,
} from '@docvi/shared'

import {
  collectSearchCorpus,
  probeWorkspace,
  readDoc,
  readStandaloneDoc,
  scanTree,
} from './content.ts'
import { createGitService } from './git.mjs'
import { exportDocument } from './export-doc.ts'
import { clearDraft, readDraft, writeDoc, writeDraft } from './fs-write.ts'
import { copyEntry, createEntry, moveEntry, renameEntry, resolveForTrash } from './fs-ops.ts'
import type { FileWatcher } from './fs-watch.ts'
import { toView, type PluginStore } from './plugin-store.ts'
import { loadMarket } from './plugin-market.ts'
import { checkForUpdate, runtimeInfo } from './update.ts'
import type { SettingsStore } from './settings-store.ts'
import type { ServiceBridge } from './service-bridge.ts'
import {
  createRecentStore,
  createWorkspaceStore,
  type RecentStore,
  type WorkspaceStore,
} from './store.ts'
import { recentFile, workspacesFile } from './paths.ts'

/**
 * IPC 注册表：主进程唯一入口。
 *
 * 三条纪律：
 * 1. 每个 handler 都返回 Result 信封——异常在这里收敛成错误码，不跨进程抛；
 * 2. 渲染进程传来的 id 一律先在 store 里查，查不到即 E_NOT_FOUND，绝不拼接路径；
 * 3. 文件操作只经 content.ts 的路径校验，handler 自己不碰 fs。
 */

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } }
}

function toFailure(error: unknown): Result<never> {
  const code =
    error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : null
  if (isErrorCode(code)) {
    return fail(code, error instanceof Error ? error.message : String(error))
  }
  return fail('E_INTERNAL', error instanceof Error ? error.message : '未知错误')
}

export interface DesktopHostOptions {
  /** 读外壳行为的实际状态（自启动要读注册表，不能只信设置文件） */
  desktopPrefs: () => Promise<DesktopPrefsState>
  setAutostart: (enabled: boolean) => Promise<DesktopPrefsState>
  setCloseToTray: (enabled: boolean) => Promise<DesktopPrefsState>
  /** 推送克隆进度到所有窗口（克隆可能要几十秒，没有进度就是假死） */
  pushGitProgress: (event: GitProgressEvent) => void
  /** 主题切换时同步窗口按钮配色（Windows 原生 overlay 不读页面 CSS） */
  setWindowTheme: (theme: string) => void
}
export function registerIpc(
  store: WorkspaceStore,
  recent: RecentStore,
  watcher: FileWatcher,
  plugins: PluginStore,
  service: ServiceBridge,
  settings: SettingsStore,
  desktop: DesktopHostOptions,
): void {
  // 各 handler 内部用这些短名，避免长链式调用刷屏
  const desktopPrefs = desktop.desktopPrefs
  const setAutostart = desktop.setAutostart
  const setCloseToTray = desktop.setCloseToTray
  /** git 服务：副本与工作树全部落在数据目录内，绝不触碰用户目录 */
  const git = createGitService(app.getPath('userData'))

  ipcMain.handle(IPC.appInfo, () =>
    ok({
      name: 'docvi',
      version: app.getVersion(),
      platform: process.platform,
      dataDir: app.getPath('userData'),
    }),
  )

  /**
   * 外链交给系统浏览器。
   *
   * 只放行三种协议：链接来自内容作者，`file:` / 自定义协议都可能被拿来启动
   * 本机程序；放行等于把「点一下链接」变成任意命令执行入口。
   */
  ipcMain.handle(IPC.appOpenExternal, async (_event, url: unknown): Promise<Result<null>> => {
    const target = typeof url === 'string' ? url.trim() : ''
    if (!/^(https?:\/\/|mailto:)/i.test(target)) {
      return fail('E_INVALID', '只允许打开 http/https/mailto 链接')
    }
    await shell.openExternal(target)
    return ok(null)
  })

  ipcMain.handle(IPC.appRuntimeInfo, (): Result<RuntimeInfo> => ok(runtimeInfo()))

  /**
   * 检查更新：只比对版本并把下载页交给系统浏览器。
   *
   * 不在这里下载安装包——详见 main/update.ts 顶部对三件前提的说明。
   */
  ipcMain.handle(IPC.appUpdateCheck, async (): Promise<Result<UpdateCheckResult>> => {
    try {
      return ok(await checkForUpdate())
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.workspaceList, () => ok(store.list()))

  ipcMain.handle(IPC.workspacePick, async (event): Promise<Result<string | null>> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '添加文档目录',
      properties: ['openDirectory'],
    }
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return ok(picked.canceled ? null : (picked.filePaths[0] ?? null))
  })

  /** 路径 → 工作区记录并落库（两个添加入口共用，保证 id 派生规则只有一处） */
  function addWorkspaceRoot(root: string): WorkspaceEntry {
    const entry: WorkspaceEntry = {
      // id 由路径派生：同一目录反复添加得到同一 id，列表不会出现两条
      id: createHash('sha1').update(root).digest('hex').slice(0, 12),
      name: basename(root),
      root,
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    }
    const added = store.add(entry)
    // 新工作区立刻可被 MCP 的 search_docs / read_doc 检索到
    service.sync()
    return added
  }

  ipcMain.handle(IPC.workspaceAdd, async (event): Promise<Result<WorkspaceEntry | null>> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '添加文档目录',
      properties: ['openDirectory'],
    }
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)

    const root = picked.canceled ? undefined : picked.filePaths[0]
    if (!root) return ok(null)
    return ok(addWorkspaceRoot(root))
  })

  /**
   * 按已知路径添加（探测后确认候选用）。
   *
   * 路径来自渲染层，必须按工作区根重新校验：只允许绝对路径且真实存在的目录，
   * 否则渲染层一个错误字符串就能把任意路径写进工作区表。
   */
  ipcMain.handle(IPC.workspaceAddAt, (_event, root: unknown): Result<WorkspaceEntry | null> => {
    try {
      if (typeof root !== 'string' || !root.trim()) return fail('E_INVALID', '路径必须是非空字符串')
      if (!isAbsolute(root)) return fail('E_INVALID', '路径必须是绝对路径')
      if (!statSync(root).isDirectory()) return fail('E_INVALID', '路径不是目录')
      return ok(addWorkspaceRoot(root))
    } catch (error) {
      if (isErrorCode(error)) return toFailure(error)
      return fail('E_INVALID', `目录不可读：${root}`)
    }
  })

  ipcMain.handle(IPC.workspaceProbe, (_event, root: unknown): Result<WorkspaceProbeResult> => {
    try {
      if (typeof root !== 'string' || !root.trim()) return fail('E_INVALID', '路径必须是非空字符串')
      if (!isAbsolute(root)) return fail('E_INVALID', '路径必须是绝对路径')
      if (!statSync(root).isDirectory()) return fail('E_INVALID', '路径不是目录')
      return ok(probeWorkspace(root))
    } catch (error) {
      if (isErrorCode(error)) return toFailure(error)
      return fail('E_INVALID', `目录不可读：${root}`)
    }
  })

  ipcMain.handle(IPC.workspaceRemove, (_event, id: unknown): Result<null> => {
    if (typeof id !== 'string') return fail('E_INVALID', 'id 必须是字符串')
    if (!store.find(id)) return fail('E_NOT_FOUND', '工作区不存在')
    store.remove(id)
    service.sync()
    return ok(null)
  })

  /* ---------- git（平台自持副本 + 分支工作树） ---------- */

  /**
   * 取一个 git 托管工作区并校验它是托管形态。
   *
   * 三个 git 操作都只接受 id（不接受渲染层传来的 repo 名/路径）：副本名与工作树
   * 路径全部由主进程从工作区表反查，渲染层无法构造出指向任意目录的调用。
   */
  const gitWorkspace = (id: unknown): WorkspaceEntry => {
    if (typeof id !== 'string' || !id) throw fail('E_INVALID', '工作区 id 必须是非空字符串')
    const entry = store.find(id)
    if (!entry) throw fail('E_NOT_FOUND', '工作区不存在')
    if (!entry.git) throw fail('E_INVALID', '该工作区不是 git 托管的工作区')
    return entry
  }

  ipcMain.handle(IPC.gitState, async (): Promise<Result<GitState>> => {
    try {
      const version = (await git.gitAvailable()).trim()
      return ok({ available: true, version, reason: null })
    } catch (error) {
      return ok({
        available: false,
        version: null,
        reason: error instanceof Error ? error.message : '未检测到 git',
      })
    }
  })

  ipcMain.handle(IPC.gitClone, async (_event, input: unknown): Promise<Result<WorkspaceEntry>> => {
    try {
      if (!input || typeof input !== 'object') return fail('E_INVALID', '参数应为对象')
      const raw = input as { url?: unknown; name?: unknown; branch?: unknown }
      if (typeof raw.url !== 'string' || !raw.url.trim()) return fail('E_INVALID', '仓库地址必填')
      if (typeof raw.name !== 'string' || !raw.name.trim()) return fail('E_INVALID', '名称必填')
      if (raw.branch !== undefined && typeof raw.branch !== 'string') {
        return fail('E_INVALID', 'branch 必须是字符串')
      }
      const name = raw.name.trim()
      const result = await git.clone({
        url: raw.url.trim(),
        name,
        branch: raw.branch ?? null,
        onProgress: progress => desktop.pushGitProgress({ workspaceName: name, ...progress }),
      })
      const entry: WorkspaceEntry = {
        id: createHash('sha1').update(result.path).digest('hex').slice(0, 12),
        name,
        root: result.path,
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        git: { repo: result.repo, url: raw.url.trim(), branch: result.branch },
      }
      const added = store.add(entry)
      service.sync()
      return ok(added)
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.gitPull, async (_event, id: unknown) => {
    try {
      const entry = gitWorkspace(id)
      const result = await git.pull({ repo: entry.git!.repo, branch: entry.git!.branch })
      return ok(result)
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.gitBranches, async (_event, id: unknown) => {
    try {
      const entry = gitWorkspace(id)
      const result = await git.branches({ repo: entry.git!.repo })
      return ok(result.branches)
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.gitSwitchBranch, async (_event, id: unknown, branch: unknown) => {
    try {
      const entry = gitWorkspace(id)
      if (typeof branch !== 'string' || !branch.trim()) return fail('E_INVALID', '分支名必填')
      const result = await git.switchBranch({ repo: entry.git!.repo, branch: branch.trim() })
      /*
       * root 换成新工作树后工作区 id 也要跟着换（id 由路径派生）：否则同一份副本的
       * 两个分支会共用一个 id，标签与会话恢复会互相覆盖。旧条目先移出，再按新路径
       * 重新入表——等于「切分支 = 换一个工作区」，语义最直白。
       */
      store.remove(entry.id)
      const next: WorkspaceEntry = {
        ...entry,
        id: createHash('sha1').update(result.path).digest('hex').slice(0, 12),
        root: result.path,
        lastOpenedAt: Date.now(),
        git: { ...entry.git!, branch: result.branch },
      }
      const added = store.add(next)
      service.sync()
      return ok(added)
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.workspaceTouch, (_event, id: unknown): Result<null> => {
    if (typeof id !== 'string') return fail('E_INVALID', 'id 必须是字符串')
    if (!store.find(id)) return fail('E_NOT_FOUND', '工作区不存在')
    store.touch(id)
    return ok(null)
  })

  ipcMain.handle(IPC.treeList, (_event, workspaceId: unknown) => {
    try {
      if (typeof workspaceId !== 'string') return fail('E_INVALID', 'workspaceId 必须是字符串')
      const entry = store.find(workspaceId)
      if (!entry) return fail('E_NOT_FOUND', '工作区不存在')
      return ok(scanTree(entry.root))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.docRead, (_event, workspaceId: unknown, path: unknown) => {
    try {
      if (typeof workspaceId !== 'string') return fail('E_INVALID', 'workspaceId 必须是字符串')
      if (typeof path !== 'string' || !path) return fail('E_INVALID', 'path 必须是非空字符串')
      const entry = store.find(workspaceId)
      if (!entry) return fail('E_NOT_FOUND', '工作区不存在')
      return ok(readDoc(entry.root, path))
    } catch (error) {
      return toFailure(error)
    }
  })

  /* ---------- 工作区内文件操作 ---------- */

  /**
   * 每个 handler 都先查工作区再动作：渲染进程传进来的 id 不可信，
   * 查不到就直接 E_NOT_FOUND，绝不拿它拼路径。
   *
   * 所有实际路径校验在 fs-ops 里（resolveInside + 名字规则），
   * handler 只做参数形状检查——形状错了早报错，比到 fs 层再失败清楚。
   */
  const withWorkspace = <A extends unknown[]>(
    id: unknown,
    action: (root: string, ...args: A) => string,
    ...args: A
  ): Result<{ relPath: string }> => {
    try {
      if (typeof id !== 'string') return fail('E_INVALID', 'workspaceId 必须是字符串')
      const entry = store.find(id)
      if (!entry) return fail('E_NOT_FOUND', '工作区不存在')
      return ok({ relPath: action(entry.root, ...args) })
    } catch (error) {
      return toFailure(error)
    }
  }

  ipcMain.handle(
    IPC.fsCreate,
    (_event, workspaceId: unknown, dirRelPath: unknown, name: unknown, kind: unknown) => {
      if (typeof dirRelPath !== 'string') return fail('E_INVALID', 'dirRelPath 必须是字符串')
      if (typeof name !== 'string' || !name) return fail('E_INVALID', 'name 必须是非空字符串')
      if (kind !== 'file' && kind !== 'dir') return fail('E_INVALID', 'kind 必须是 file 或 dir')
      return withWorkspace(workspaceId, (root: string) =>
        createEntry({ root }, dirRelPath, name, kind),
      )
    },
  )

  ipcMain.handle(
    IPC.fsRename,
    (_event, workspaceId: unknown, relPath: unknown, nextName: unknown) => {
      if (typeof relPath !== 'string' || !relPath)
        return fail('E_INVALID', 'relPath 必须是非空字符串')
      if (typeof nextName !== 'string' || !nextName)
        return fail('E_INVALID', 'nextName 必须是非空字符串')
      return withWorkspace(workspaceId, (root: string) => renameEntry({ root }, relPath, nextName))
    },
  )

  ipcMain.handle(
    IPC.fsMove,
    (_event, workspaceId: unknown, relPath: unknown, targetDir: unknown) => {
      if (typeof relPath !== 'string' || !relPath)
        return fail('E_INVALID', 'relPath 必须是非空字符串')
      if (typeof targetDir !== 'string') return fail('E_INVALID', 'targetDir 必须是字符串')
      return withWorkspace(workspaceId, (root: string) => moveEntry({ root }, relPath, targetDir))
    },
  )

  ipcMain.handle(
    IPC.fsCopy,
    (_event, workspaceId: unknown, relPath: unknown, targetDir: unknown) => {
      if (typeof relPath !== 'string' || !relPath)
        return fail('E_INVALID', 'relPath 必须是非空字符串')
      if (typeof targetDir !== 'string') return fail('E_INVALID', 'targetDir 必须是字符串')
      return withWorkspace(workspaceId, (root: string) => copyEntry({ root }, relPath, targetDir))
    },
  )

  /**
   * 删除：优先送系统回收站。
   *
   * 回收站在无桌面环境 / 某些文件系统上会失败，此时**不静默永久删除**——
   * 回一个明确错误让用户自己处理，比「以为进了回收站其实没了」安全太多。
   */
  ipcMain.handle(IPC.fsTrash, async (_event, workspaceId: unknown, relPath: unknown) => {
    try {
      if (typeof workspaceId !== 'string') return fail('E_INVALID', 'workspaceId 必须是字符串')
      if (typeof relPath !== 'string' || !relPath) {
        return fail('E_INVALID', 'relPath 必须是非空字符串')
      }
      const entry = store.find(workspaceId)
      if (!entry) return fail('E_NOT_FOUND', '工作区不存在')
      const target = resolveForTrash({ root: entry.root }, relPath)
      await shell.trashItem(target.abs)
      return ok({ relPath: target.relPath })
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.filePick, async (event): Promise<Result<string | null>> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    }
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return ok(picked.canceled ? null : (picked.filePaths[0] ?? null))
  })

  ipcMain.handle(IPC.fileRead, (_event, absolutePath: unknown) => {
    try {
      if (typeof absolutePath !== 'string' || !absolutePath) {
        return fail('E_INVALID', 'absolutePath 必须是非空字符串')
      }
      return ok(readStandaloneDoc(absolutePath))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.searchCorpus, (_event, workspaceId: unknown) => {
    try {
      if (typeof workspaceId !== 'string') return fail('E_INVALID', 'workspaceId 必须是字符串')
      const entry = store.find(workspaceId)
      if (!entry) return fail('E_NOT_FOUND', '工作区不存在')
      return ok(collectSearchCorpus(entry.root))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.recentList, () => ok(recent.list()))

  ipcMain.handle(IPC.recentTouch, (_event, raw: unknown): Result<RecentEntry[]> => {
    // 渲染进程传的是普通对象：逐字段校验后再落盘，不让它决定文件内容形状
    if (!raw || typeof raw !== 'object') return fail('E_INVALID', '最近打开记录必须是对象')
    const item = raw as Record<string, unknown>
    if (typeof item.path !== 'string' || !item.path)
      return fail('E_INVALID', 'path 必须是非空字符串')
    if (item.workspaceId !== null && typeof item.workspaceId !== 'string') {
      return fail('E_INVALID', 'workspaceId 必须是字符串或 null')
    }
    if (typeof item.relPath !== 'string') return fail('E_INVALID', 'relPath 必须是字符串')
    if (typeof item.title !== 'string') return fail('E_INVALID', 'title 必须是字符串')
    return ok(
      recent.touch({
        path: item.path,
        workspaceId: item.workspaceId,
        relPath: item.relPath,
        title: item.title,
      }),
    )
  })

  ipcMain.handle(IPC.recentClear, () => ok(recent.clear()))

  ipcMain.handle(IPC.docWrite, (_event, raw: unknown) => {
    try {
      if (!raw || typeof raw !== 'object') return fail('E_INVALID', '保存请求必须是对象')
      const request = raw as Record<string, unknown>
      if (typeof request.absolutePath !== 'string' || !request.absolutePath) {
        return fail('E_INVALID', 'absolutePath 必须是非空字符串')
      }
      if (typeof request.text !== 'string') return fail('E_INVALID', 'text 必须是字符串')
      if (typeof request.baseMtime !== 'number' || !Number.isFinite(request.baseMtime)) {
        return fail('E_INVALID', 'baseMtime 必须是数字')
      }
      return ok(
        writeDoc({
          absolutePath: request.absolutePath,
          text: request.text,
          baseMtime: request.baseMtime,
          force: request.force === true,
        }),
      )
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.docExport, async (event, raw: unknown) => {
    try {
      if (!raw || typeof raw !== 'object') return fail('E_INVALID', '导出请求必须是对象')
      const request = raw as Record<string, unknown>
      const format = (['markdown', 'html', 'pdf'] as const).find(item => item === request.format)
      if (!format) return fail('E_INVALID', 'format 必须是 markdown / html / pdf')
      if (typeof request.suggestedName !== 'string') {
        return fail('E_INVALID', 'suggestedName 必须是字符串')
      }
      // 两种产物都靠 text 承载：markdown 是原文，html / pdf 是完整 HTML 文档
      if (typeof request.text !== 'string' || !request.text) {
        return fail('E_INVALID', 'text 必须是非空字符串')
      }
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return fail('E_INTERNAL', '找不到发起导出的窗口')
      return ok(
        await exportDocument(window, {
          format,
          suggestedName: request.suggestedName,
          text: request.text,
        }),
      )
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.draftRead, (_event, absolutePath: unknown) => {
    if (typeof absolutePath !== 'string' || !absolutePath) {
      return fail('E_INVALID', 'absolutePath 必须是非空字符串')
    }
    return ok(readDraft(absolutePath))
  })

  ipcMain.handle(IPC.draftWrite, (_event, absolutePath: unknown, text: unknown) => {
    try {
      if (typeof absolutePath !== 'string' || !absolutePath) {
        return fail('E_INVALID', 'absolutePath 必须是非空字符串')
      }
      if (typeof text !== 'string') return fail('E_INVALID', 'text 必须是字符串')
      writeDraft(absolutePath, text)
      return ok(null)
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.draftClear, (_event, absolutePath: unknown) => {
    if (typeof absolutePath !== 'string' || !absolutePath) {
      return fail('E_INVALID', 'absolutePath 必须是非空字符串')
    }
    clearDraft(absolutePath)
    return ok(null)
  })

  ipcMain.handle(IPC.docWatch, (_event, absolutePath: unknown) => {
    if (typeof absolutePath !== 'string' || !absolutePath) {
      return fail('E_INVALID', 'absolutePath 必须是非空字符串')
    }
    watcher.watch(absolutePath)
    return ok(null)
  })

  ipcMain.handle(IPC.docUnwatch, (_event, absolutePath: unknown) => {
    if (typeof absolutePath !== 'string' || !absolutePath) {
      return fail('E_INVALID', 'absolutePath 必须是非空字符串')
    }
    watcher.unwatch(absolutePath)
    return ok(null)
  })

  /* ---------- 设置与会话 ---------- */

  ipcMain.handle(IPC.settingsRead, () => ok(settings.get()))

  ipcMain.handle(IPC.settingsWrite, (_event, patch: unknown) => {
    try {
      return ok(settings.update(patch))
    } catch (error) {
      return toFailure(error)
    }
  })

  // 外部改动（AI / 手改 settings.json）推给所有窗口：渲染层据此重配主题与语言。
  // 用 getAllWindows 而不是注入 mainWindow：ipc.ts 不该知道「哪个窗口是主窗口」。
  settings.onExternalChange(next => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC.settingsChanged, next)
    }
  })

  /*
   * 窗口按钮配色：只接受解析后的明暗。
   *
   * 由渲染层在主题变化时主动推——插件主题的明暗写在插件清单里，主进程既读不到
   * 也不该为它去扫插件目录；而且这条通道与 settingsWrite 解耦后，将来主题切换
   * 不再依赖「用户改了设置」这个前提。
   */
  ipcMain.handle(IPC.windowAppearance, (_event, appearance: unknown) => {
    if (appearance !== 'light' && appearance !== 'dark') {
      return fail('E_INVALID', 'appearance 必须是 light 或 dark')
    }
    desktop.setWindowTheme(appearance)
    return ok(null)
  })

  ipcMain.handle(IPC.sessionRead, () => ok(settings.readSession()))

  ipcMain.handle(IPC.sessionWrite, (_event, value: unknown) => {
    try {
      // 会话体积上限：标签历史全算上也远小于 1MB，超过说明写入了意外结构
      const text = JSON.stringify(value ?? null)
      if (text.length > 1024 * 1024) return fail('E_TOO_LARGE', '会话数据超过 1MB 上限')
      settings.writeSession(value ?? null)
      return ok(null)
    } catch (error) {
      return toFailure(error)
    }
  })

  /* ---------- 插件 ---------- */

  ipcMain.handle(IPC.pluginList, () => ok(plugins.list().map(toView)))

  /*
   * 市场清单：远端配置文件 + 本地缓存。
   *
   * 传 `{ refresh: true }` 时跳过缓存直接拉远端（界面的「刷新」按钮）；
   * 网络失败不报错，返回缓存副本并在 `error` 里说明（见 plugin-market.ts）。
   */
  ipcMain.handle(
    IPC.pluginMarket,
    async (_event, options?: { refresh?: boolean }): Promise<Result<MarketCatalog>> => {
      try {
        const catalog = await loadMarket(
          {
            cacheFile: join(app.getPath('userData'), 'plugin-market.json'),
            // net.fetch 走 Chromium 网络栈：系统代理 / PAC 生效（Node fetch 不读代理）
            fetchImpl: net.fetch as unknown as typeof fetch,
          },
          options?.refresh === true,
        )
        return ok(catalog)
      } catch (error) {
        return toFailure(error)
      }
    },
  )

  /**
   * 从市场安装 → **已移除**。
   *
   * 市场现在是远端目录（列第三方插件与仓库地址），安装需要下载 tarball、解压、
   * 校验、落位。桌面端刻意保持零运行时依赖（安装包里不带 node_modules，没有
   * 解压库），这条链只在容器运维面存在。界面上不再给这个按钮——点了必然失败
   * 的入口比没有入口更糟。
   */

  ipcMain.handle(IPC.pluginInstall, async (event): Promise<Result<PluginRecordView | null>> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择插件目录（含 plugin.json）',
      properties: ['openDirectory'],
    }
    const picked = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const source = picked.canceled ? undefined : picked.filePaths[0]
    if (!source) return ok(null)
    try {
      const installed = plugins.install(source)
      service.sync()
      return ok(toView(installed))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.pluginUninstall, (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !id) return fail('E_INVALID', 'id 必须是非空字符串')
      plugins.uninstall(id)
      service.sync()
      return ok(plugins.list().map(toView))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.pluginSetEnabled, (_event, id: unknown, enabled: unknown) => {
    try {
      if (typeof id !== 'string' || !id) return fail('E_INVALID', 'id 必须是非空字符串')
      if (typeof enabled !== 'boolean') return fail('E_INVALID', 'enabled 必须是布尔值')
      const next = plugins.setEnabled(id, enabled)
      // 插件集变了：服务侧的组件清单跟着变（MCP 的 list_components 直接反映）
      service.sync()
      return ok(next.map(toView))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(
    IPC.pluginSetComponentEnabled,
    (_event, id: unknown, kind: unknown, enabled: unknown) => {
      try {
        if (typeof id !== 'string' || !id) return fail('E_INVALID', 'id 必须是非空字符串')
        if (typeof kind !== 'string' || !kind) return fail('E_INVALID', 'kind 必须是非空字符串')
        if (typeof enabled !== 'boolean') return fail('E_INVALID', 'enabled 必须是布尔值')
        const next = plugins.setComponentEnabled(id, kind, enabled)
        // 活跃组件集变了：MCP 的 list_components 也要立刻反映
        service.sync()
        return ok(next.map(toView))
      } catch (error) {
        return toFailure(error)
      }
    },
  )

  /* ---------- 本地服务 ---------- */

  ipcMain.handle(IPC.serviceState, () => ok(service.state()))

  ipcMain.handle(IPC.serviceRestart, async (): Promise<Result<ServiceState>> => {
    try {
      return ok(await service.restart())
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.serviceSetLan, async (_event, lan: unknown) => {
    if (typeof lan !== 'boolean') return fail('E_INVALID', 'lan 必须是布尔值')
    try {
      return ok(await service.setLan(lan))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.serviceSetPort, async (_event, port: unknown) => {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return fail('E_INVALID', '端口必须是 1024-65535 之间的整数')
    }
    try {
      return ok(await service.setPort(port))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.serviceOpenLog, async () => {
    try {
      // 日志落在数据目录：先确保目录存在，否则 shell.openPath 会静默失败
      const dir = app.getPath('userData')
      await shell.openPath(dir)
      return ok(null)
    } catch (error) {
      return toFailure(error)
    }
  })

  /* ---------- 外壳行为（自启动 / 托盘） ---------- */

  ipcMain.handle(IPC.desktopPrefs, async () => {
    try {
      return ok(await desktopPrefs())
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.desktopSetAutostart, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return fail('E_INVALID', 'enabled 必须是布尔值')
    try {
      return ok(await setAutostart(enabled))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.desktopSetCloseToTray, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return fail('E_INVALID', 'enabled 必须是布尔值')
    try {
      return ok(await setCloseToTray(enabled))
    } catch (error) {
      return toFailure(error)
    }
  })

  /* ---------- 临时分享 ---------- */

  ipcMain.handle(IPC.shareList, async () => {
    try {
      return ok(await service.listShares())
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(
    IPC.shareCreate,
    async (event): Promise<Result<Awaited<ReturnType<ServiceBridge['createShare']>>>> => {
      const window = BrowserWindow.fromWebContents(event.sender)
      // 同一个对话框既选文件也选目录：用户不必先想「我要分享的是哪种」
      const options: Electron.OpenDialogOptions = {
        title: '选择要分享的文件或目录',
        properties: ['openFile', 'openDirectory'],
        filters: [
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: '全部文件', extensions: ['*'] },
        ],
      }
      const picked = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options)
      const target = picked.canceled ? undefined : picked.filePaths[0]
      if (!target) return ok(null)
      try {
        return ok(await service.createShare(target))
      } catch (error) {
        return toFailure(error)
      }
    },
  )

  ipcMain.handle(IPC.shareCreatePath, async (_event, absolutePath: unknown) => {
    if (typeof absolutePath !== 'string' || !absolutePath) {
      return fail('E_INVALID', 'absolutePath 必须是非空字符串')
    }
    try {
      return ok(await service.createShare(absolutePath))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.shareRemove, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('E_INVALID', 'id 必须是非空字符串')
    try {
      return ok(await service.removeShare(id))
    } catch (error) {
      return toFailure(error)
    }
  })

  ipcMain.handle(IPC.shareOpen, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return fail('E_INVALID', 'id 必须是非空字符串')
    try {
      const shares = await service.listShares()
      const share = shares.find(item => item.id === id)
      if (!share) return fail('E_NOT_FOUND', '分享不存在或已失效')
      if (!/^https?:\/\//.test(share.url)) return fail('E_INTERNAL', '服务未运行，无法打开分享链接')
      await shell.openExternal(share.url)
      return ok(null)
    } catch (error) {
      return toFailure(error)
    }
  })
}

export function createStore(): WorkspaceStore {
  return createWorkspaceStore(workspacesFile())
}

export function createRecent(): RecentStore {
  return createRecentStore(recentFile())
}
