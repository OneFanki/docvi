import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

import type { RecentEntry, WorkspaceEntry } from '@docvi/shared'

/**
 * 极简 JSON 持久化：读写整份文件，写入走临时文件 + rename 保证原子性。
 *
 * 不引入数据库：workspace 列表是几十条量级，读一次全量即可；引入 SQLite
 * 会让「另一个进程/备份工具读一眼」变复杂，收益为零。
 */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    const text = readFileSync(file, 'utf8')
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 读数组型持久化文件。
 *
 * 不能只 `JSON.parse` 后直接断言：文件是外部可编辑的（用户手改、旧版本格式、
 * 备份工具写坏），形状不对时 `entries.find()` 会在启动路径上抛未捕获异常，
 * 结果是整个窗口白屏。形状不对就退回空列表，等价于「没有工作区」。
 */
export function readJsonArray<T>(file: string): T[] {
  const raw = readJsonFile<unknown>(file, [])
  return Array.isArray(raw) ? (raw as T[]) : []
}

export interface WorkspaceStore {
  list(): WorkspaceEntry[]
  add(entry: WorkspaceEntry): WorkspaceEntry
  remove(id: string): void
  touch(id: string): void
  find(id: string): WorkspaceEntry | undefined
}

export function createWorkspaceStore(file: string): WorkspaceStore {
  let entries = readJsonArray<WorkspaceEntry>(file)

  const persist = () => writeJsonFile(file, entries)

  return {
    list: () => [...entries].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    add(entry) {
      // 同路径视为同一工作区：重复添加只更新时间，不产生第二条记录
      const existing = entries.find(e => e.root === entry.root)
      if (existing) {
        existing.lastOpenedAt = Date.now()
        persist()
        return existing
      }
      entries = [...entries, entry]
      persist()
      return entry
    },
    remove(id) {
      entries = entries.filter(e => e.id !== id)
      persist()
    },
    touch(id) {
      const target = entries.find(e => e.id === id)
      if (!target) return
      target.lastOpenedAt = Date.now()
      persist()
    },
    find: id => entries.find(e => e.id === id),
  }
}

/**
 * 最近打开上限。
 *
 * 12 条 ≈ 一屏能看完的量。再多也不会被翻到——「最近」的价值在靠前几条，
 * 后面只会把这一节拉成一整页，把工作区卡片挤上去。
 */
const MAX_RECENT = 12

export interface RecentStore {
  list(): RecentEntry[]
  /** 按绝对路径覆盖写入（同一文件只留一条），返回覆盖后的列表 */
  touch(entry: Omit<RecentEntry, 'openedAt'>): RecentEntry[]
  clear(): RecentEntry[]
}

export function createRecentStore(file: string): RecentStore {
  // 上限收紧后老会话文件里仍可能有更多条目：装载时就截断，
  // 否则要等下一次打开文档才缩回来，界面会先显示一整页旧记录。
  let entries = readJsonArray<RecentEntry>(file).slice(0, MAX_RECENT)

  const persist = () => writeJsonFile(file, entries)
  const sorted = () => [...entries].sort((a, b) => b.openedAt - a.openedAt)

  return {
    list: sorted,
    touch(entry) {
      // Windows 路径大小写不敏感：去重前统一小写比较，否则同一文件会攒出多条
      const key = entry.path.toLowerCase()
      entries = [
        { ...entry, openedAt: Date.now() },
        ...entries.filter(item => item.path.toLowerCase() !== key),
      ].slice(0, MAX_RECENT)
      persist()
      return sorted()
    },
    clear() {
      entries = []
      persist()
      return []
    },
  }
}
