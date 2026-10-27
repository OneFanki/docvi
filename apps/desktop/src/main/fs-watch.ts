import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, sep } from 'node:path'

/**
 * 磁盘变化监视（两种粒度）。
 *
 * ## 为什么监视目录而不是文件
 *
 * 写文件普遍走「临时文件 + rename」，rename 之后原文件描述符失效，直接 watch
 * 文件在第一次保存后就不再触发。监视目录并按文件名过滤可以跨 rename 存活。
 *
 * ## 为什么还要监视整棵内容根
 *
 * 只盯当前文档时，AI 新建 / 删除 / 改名文件在侧栏里**看不见**——用户得手动
 * 刷新。编辑器的常识是「AI 写代码我实时看到」，所以目录结构也要跟着磁盘走。
 *
 * 两种粒度的分工：
 *  - `watch(path)`：**工作区外的单文件**。它没有内容根，只能按文件盯。
 *  - `watchTree(id, root)`：**整个工作区**。一次递归监视覆盖其中所有文档与目录，
 *    单个文档不必再各挂一个句柄。
 */

export interface FileWatcher {
  /** 开始监视单个文件（单文件文档用）；重复调用不会重复建 watcher */
  watch(absolutePath: string): void
  unwatch(absolutePath: string): void
  /** 开始递归监视一个内容根；重复调用幂等 */
  watchTree(workspaceId: string, root: string): void
  unwatchTree(workspaceId: string): void
  closeAll(): void
}

/** 文件事件防抖：编辑器保存会连续触发 change + rename 两个事件 */
const FILE_DEBOUNCE_MS = 260
/**
 * 目录树事件的防抖更长。
 *
 * 一次 `git checkout` 或 AI 批量写文件会瞬间产生成百上千个事件；每个都触发一次
 * 整树重扫会让界面卡住。400ms 足够把「一次操作产生的一串事件」收拢成一次刷新，
 * 又不会让用户感到延迟。
 */
const TREE_DEBOUNCE_MS = 400

export interface TreeChange {
  workspaceId: string
  /** 本批次里变化过的相对路径（用于日志与判断「有没有文档受影响」） */
  paths: string[]
}

export interface FileWatcherOptions {
  /**
   * 目录树事件过滤：返回 false 的路径不算内容变化。
   *
   * 由调用方注入扫描口径（见 `content.ts` 的 `isContentRelPath`）：监视器自己
   * 不认识「哪些目录不进内容树」，规则两边各写一份必然漂移。
   */
  isRelevant?: (relativePath: string) => boolean
}

export function createFileWatcher(
  onChange: (absolutePath: string) => void,
  onTreeChange: (change: TreeChange) => void = () => undefined,
  options: FileWatcherOptions = {},
): FileWatcher {
  /** key = 小写绝对路径（Windows 大小写不敏感）；value = 目录 watcher */
  const files = new Map<string, { watcher: FSWatcher; dir: string; name: string }>()
  const fileTimers = new Map<string, NodeJS.Timeout>()

  /** 每个工作区一棵递归 watcher */
  const trees = new Map<string, { watcher: FSWatcher; root: string }>()
  const treePending = new Map<string, { paths: Set<string>; timer: NodeJS.Timeout }>()

  const emitFile = (key: string): void => {
    const existing = fileTimers.get(key)
    if (existing) clearTimeout(existing)
    fileTimers.set(
      key,
      setTimeout(() => {
        fileTimers.delete(key)
        onChange(key)
      }, FILE_DEBOUNCE_MS),
    )
  }

  /** 收集一批路径后统一上报一次 */
  const emitTree = (workspaceId: string, relative: string): void => {
    // 被扫描口径排除的路径（.git / node_modules / 素材目录）不是内容变化
    if (options.isRelevant && !options.isRelevant(relative)) return
    const existing = treePending.get(workspaceId)
    if (existing) {
      existing.paths.add(relative)
      // 重置计时器：批次边界以「最后一次事件」为准（git checkout 会持续几百毫秒）
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => {
        treePending.delete(workspaceId)
        onTreeChange({ workspaceId, paths: [...existing.paths] })
      }, TREE_DEBOUNCE_MS)
      return
    }
    const paths = new Set<string>([relative])
    const timer = setTimeout(() => {
      treePending.delete(workspaceId)
      onTreeChange({ workspaceId, paths: [...paths] })
    }, TREE_DEBOUNCE_MS)
    treePending.set(workspaceId, { paths, timer })
  }

  const closeTree = (workspaceId: string): void => {
    const pending = treePending.get(workspaceId)
    if (pending) {
      clearTimeout(pending.timer)
      treePending.delete(workspaceId)
    }
    const entry = trees.get(workspaceId)
    if (!entry) return
    entry.watcher.close()
    trees.delete(workspaceId)
  }

  return {
    watch(absolutePath) {
      const key = absolutePath.toLowerCase()
      if (files.has(key)) return
      const dir = dirname(absolutePath)
      const name = basename(absolutePath).toLowerCase()
      try {
        const watcher = watch(dir, (_event, filename) => {
          // filename 在部分平台上可能为 null（目录被替换等情况），此时保守上报
          if (filename && filename.toLowerCase() !== name) return
          emitFile(key)
        })
        watcher.on('error', () => {
          watcher.close()
          files.delete(key)
        })
        files.set(key, { watcher, dir, name })
      } catch {
        // 目录不可监视（权限/已删除）：静默降级，不阻塞编辑
      }
    },
    unwatch(absolutePath) {
      const key = absolutePath.toLowerCase()
      const entry = files.get(key)
      if (!entry) return
      entry.watcher.close()
      files.delete(key)
      const timer = fileTimers.get(key)
      if (timer) {
        clearTimeout(timer)
        fileTimers.delete(key)
      }
    },
    watchTree(workspaceId, root) {
      if (trees.has(workspaceId)) return
      try {
        /*
         * `recursive: true` 在 Windows / macOS / Linux（Node ≥20）都可用。
         * 大仓库可能因 inotify 句柄上限抛 ENOSPC——静默降级为「不自动刷新目录树」，
         * 手动刷新仍然可用；绝不能因为监视失败而让工作区打不开。
         */
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          // filename 为 null 时（平台不提供）只能上报一个通配标记
          const relative = filename ? String(filename) : ''
          emitTree(workspaceId, relative.split(sep).join('/'))
        })
        watcher.on('error', () => {
          watcher.close()
          trees.delete(workspaceId)
        })
        trees.set(workspaceId, { watcher, root })
      } catch {
        // 监视不可用：静默降级（见上）
      }
    },
    unwatchTree(workspaceId) {
      closeTree(workspaceId)
    },
    closeAll() {
      for (const entry of files.values()) entry.watcher.close()
      files.clear()
      for (const timer of fileTimers.values()) clearTimeout(timer)
      fileTimers.clear()
      for (const workspaceId of [...trees.keys()]) closeTree(workspaceId)
    },
  }
}
