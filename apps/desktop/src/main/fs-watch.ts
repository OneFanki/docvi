import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/**
 * 被编辑文件的磁盘变化监视。
 *
 * 为什么监视父目录而不是文件本身：保存走「临时文件 + rename」，rename 之后
 * 原文件描述符失效，直接 watch 文件的句柄在第一次保存后就不再触发。监视目录
 * 并按文件名过滤可以跨 rename 存活。
 *
 * 只监视「正在编辑」的文件：阅读态不需要外部变更提示，白占句柄。
 */

export interface FileWatcher {
  /** 开始监视；同一文件重复调用不会重复建 watcher */
  watch(absolutePath: string): void
  unwatch(absolutePath: string): void
  closeAll(): void
}

export function createFileWatcher(onChange: (absolutePath: string) => void): FileWatcher {
  /** key = 小写绝对路径（Windows 大小写不敏感）；value = 目录 watcher */
  const watchers = new Map<string, { watcher: FSWatcher; dir: string; name: string }>()
  /** 事件防抖：编辑器保存会连续触发 change + rename 两个事件 */
  const timers = new Map<string, NodeJS.Timeout>()

  const emit = (key: string): void => {
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        onChange(key)
      }, 260),
    )
  }

  return {
    watch(absolutePath) {
      const key = absolutePath.toLowerCase()
      if (watchers.has(key)) return
      const dir = dirname(absolutePath)
      const name = basename(absolutePath).toLowerCase()
      try {
        const watcher = watch(dir, (_event, filename) => {
          // filename 在部分平台上可能为 null（目录被替换等情况），此时保守上报
          if (filename && filename.toLowerCase() !== name) return
          emit(key)
        })
        watcher.on('error', () => {
          watcher.close()
          watchers.delete(key)
        })
        watchers.set(key, { watcher, dir, name })
      } catch {
        // 目录不可监视（权限/已删除）：静默降级，不阻塞编辑
      }
    },
    unwatch(absolutePath) {
      const key = absolutePath.toLowerCase()
      const entry = watchers.get(key)
      if (!entry) return
      entry.watcher.close()
      watchers.delete(key)
      const timer = timers.get(key)
      if (timer) {
        clearTimeout(timer)
        timers.delete(key)
      }
    },
    closeAll() {
      for (const entry of watchers.values()) entry.watcher.close()
      watchers.clear()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
