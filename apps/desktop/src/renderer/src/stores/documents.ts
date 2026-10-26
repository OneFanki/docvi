import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import type { DocPayload } from '@docvi/shared'

/**
 * 文档模型：同一文件在所有视图里共享一份缓冲区（单一真相源）。
 *
 * 为什么必须有这一层：标签可以多次打开同一个文件（右键新开 / 分屏将来会出现），
 * 如果每个视图各自持有一份正文，就会出现「两边看到不同内容」「草稿互相覆盖」。
 * 把正文按**规范化绝对路径**收口在这里之后：
 *  - 阅读视图渲染的是缓冲区（不是磁盘内容），未保存的改动切标签也不会消失；
 *  - 编辑视图把每次输入写进缓冲区，其它引用同一文件的视图天然看到同一份内容；
 *  - 保存、冲突、草稿都以路径为单位，不存在两份草稿打架。
 *
 * 与 VS Code 的 TextDocument 同构，只是把「编辑器实例」换成了「缓冲区 + mtime」。
 */

export interface DocumentRecord {
  /** 展示名：文件名 */
  name: string
  /** 磁盘绝对路径（统一正斜杠） */
  absolutePath: string
  /** 工作区 id（单文件为 null） */
  workspaceId: string | null
  /** 工作区内相对路径（单文件为空串） */
  relPath: string
  /** 当前缓冲区正文（阅读与编辑都读它） */
  text: string
  /** 上次从磁盘读到 / 保存成功的正文，用于判断 dirty */
  savedText: string
  /** 磁盘内容 */
  diskText: string
  mtime: number
  size: number
  /** 磁盘在编辑期间被外部改动 */
  conflict: boolean
  /** 是否加载中 */
  loading: boolean
}

function keyOf(absolutePath: string): string {
  // Windows 路径大小写不敏感：key 统一小写
  return absolutePath.replaceAll('\\', '/').toLowerCase()
}

export const useDocumentStore = defineStore('documents', () => {
  const records = ref<Map<string, DocumentRecord>>(new Map())

  const dirtyPaths = computed(() =>
    [...records.value.values()]
      .filter(item => item.text !== item.savedText)
      .map(item => item.absolutePath),
  )

  function get(absolutePath: string): DocumentRecord | null {
    return records.value.get(keyOf(absolutePath)) ?? null
  }

  function isDirty(absolutePath: string): boolean {
    const record = get(absolutePath)
    return record ? record.text !== record.savedText : false
  }

  /** 从一次读取结果建立/更新记录（切标签、打开文件都走这里） */
  function load(payload: DocPayload): DocumentRecord {
    const key = keyOf(payload.absolutePath)
    const existing = records.value.get(key)
    if (existing) {
      // 已存在：只在磁盘版本确实变化时更新基线；
      // 缓冲区若干净则同步采用磁盘内容，脏则保留用户输入并标记可能冲突
      const diskChanged =
        Math.abs(existing.mtime - payload.mtime) > 1 || existing.diskText !== payload.text
      if (diskChanged) {
        existing.diskText = payload.text
        existing.mtime = payload.mtime
        existing.size = payload.size
        if (existing.text === existing.savedText) {
          existing.text = payload.text
          existing.savedText = payload.text
          existing.conflict = false
        } else {
          existing.conflict = true
        }
      }
      existing.name = payload.title || existing.name
      existing.relPath = payload.path || existing.relPath
      existing.workspaceId = payload.path === payload.absolutePath ? null : existing.workspaceId
      return existing
    }
    const record: DocumentRecord = {
      name: payload.title || (payload.absolutePath.split(/[/\\]/).pop() ?? payload.absolutePath),
      absolutePath: payload.absolutePath.replaceAll('\\', '/'),
      workspaceId: payload.path === payload.absolutePath ? null : null,
      relPath: payload.path,
      text: payload.text,
      savedText: payload.text,
      diskText: payload.text,
      mtime: payload.mtime,
      size: payload.size,
      conflict: false,
      loading: false,
    }
    records.value.set(key, record)
    return record
  }

  /** 编辑输入：写进共享缓冲区 */
  function setText(absolutePath: string, text: string): void {
    const record = get(absolutePath)
    if (record) record.text = text
  }

  /** 保存成功：缓冲区与基线合一 */
  function markSaved(
    absolutePath: string,
    payload: { mtime: number; size: number; text: string },
  ): void {
    const record = get(absolutePath)
    if (!record) return
    record.text = payload.text
    record.savedText = payload.text
    record.diskText = payload.text
    record.mtime = payload.mtime
    record.size = payload.size
    record.conflict = false
  }

  /**
   * 磁盘外部变更。
   *
   * 返回 'adopted'（缓冲区干净，已静默采用磁盘内容）或 'conflict'（有未保存改动，
   * 需要用户决定）。调用方决定是否弹框。
   */
  function applyExternal(
    absolutePath: string,
    payload: { text: string; mtime: number; size: number },
  ): 'adopted' | 'conflict' | 'ignored' {
    const record = get(absolutePath)
    if (!record) return 'ignored'
    // mtime 与基线一致 = 自己刚保存触发的 watcher 事件
    if (Math.abs(payload.mtime - record.mtime) <= 1 && payload.text === record.diskText) {
      return 'ignored'
    }
    record.diskText = payload.text
    if (record.text === record.savedText) {
      record.text = payload.text
      record.savedText = payload.text
      record.mtime = payload.mtime
      record.size = payload.size
      record.conflict = false
      return 'adopted'
    }
    record.conflict = true
    return 'conflict'
  }

  /** 用户选择「丢弃缓冲区，采用磁盘版本」 */
  function reloadFromDisk(absolutePath: string): void {
    const record = get(absolutePath)
    if (!record) return
    record.text = record.diskText
    record.savedText = record.diskText
    record.conflict = false
  }

  /** 关闭标签后：没有别的标签引用且不脏时可以释放 */
  function release(absolutePath: string): void {
    const key = keyOf(absolutePath)
    const record = records.value.get(key)
    if (!record) return
    if (record.text !== record.savedText) return
    records.value.delete(key)
  }

  return {
    records,
    dirtyPaths,
    get,
    isDirty,
    load,
    setText,
    markSaved,
    applyExternal,
    reloadFromDisk,
    release,
  }
})
