import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { AppSettings } from '@docvi/shared'

import { createWorkspaceEntry, type WorkspaceStore } from './store.ts'

/**
 * 内建默认工作区：给 AI 一个「不指定位置也能落笔」的地方。
 *
 * 为什么需要它：MCP 原本只能在用户手动添加过的工作区里读写，没有工作区时
 * `read_doc` 直接回「当前没有可读取的文档范围」。于是「帮我写篇文档」这件事
 * 在首次安装后根本做不到——用户得先搞明白「工作区」是什么。
 *
 * 三条纪律：
 *  1. **只播种一次**。settings 里记 `defaultWorkspaceSeeded`；用户删掉这个工作区
 *     就是不想要它，重启时再建出来是骚扰。
 *  2. **失败不阻塞启动**。磁盘没权限、Documents 被重定向到不可写位置……都只记日志。
 *     为了一个便利功能让整个应用起不来是本末倒置。
 *  3. **目录可注入**。测试一律传临时目录（AGENTS：禁止触碰真实用户数据目录）。
 */

/** 默认工作区目录名（放在系统「文档」目录下） */
export const DEFAULT_WORKSPACE_DIR_NAME = 'docvi'

/** 路径解析：`<documents>/docvi` */
export function defaultWorkspaceRoot(documentsDir: string): string {
  return join(documentsDir, DEFAULT_WORKSPACE_DIR_NAME)
}

export interface EnsureDefaultWorkspaceOptions {
  /** 工作区表 */
  store: WorkspaceStore
  /** 系统「文档」目录（主进程传 `app.getPath('documents')`；测试传临时目录） */
  documentsDir: string
  /** 读当前是否已播种过 */
  isSeeded: () => boolean
  /** 标记已播种（落盘由调用方负责） */
  markSeeded: () => void
  /** 记日志（缺省不输出） */
  log?: (message: string) => void
}

export interface EnsureDefaultWorkspaceResult {
  /** 本次是否新建了目录与工作区记录 */
  created: boolean
  /** 默认工作区根（无论是否本次创建，只要可用就返回） */
  root: string | null
  /** 跳过 / 失败原因（便于日志与排查） */
  reason?: 'seeded' | 'failed'
}

/**
 * 确保默认工作区存在。幂等：已播种过、或目录已在工作区表里，都直接返回。
 *
 * 「是否已播种」与「目录是否已登记」分开判断：用户可能把同一目录手动添加过，
 * 那时不该再多出一条重复记录（`store.add` 本身按 root 去重，这里只是省一次判断）。
 */
export function ensureDefaultWorkspace(
  options: EnsureDefaultWorkspaceOptions,
): EnsureDefaultWorkspaceResult {
  const log = options.log ?? (() => {})
  const root = defaultWorkspaceRoot(options.documentsDir)

  if (options.isSeeded()) {
    return { created: false, root, reason: 'seeded' }
  }

  try {
    mkdirSync(root, { recursive: true })
    if (!statSync(root).isDirectory()) {
      throw new Error(`默认工作区路径不是目录：${root}`)
    }
  } catch (error) {
    log(`默认工作区创建失败（不影响启动）：${(error as Error).message}`)
    return { created: false, root: null, reason: 'failed' }
  }

  // 已存在同名目录记录时不再新增：store.add 会按 root 复用原记录
  const existing = options.store.list().find(entry => entry.root === root)
  if (existing) {
    // 用户可能早已手动加过这个目录：补上排序偏好即可，不覆盖其它字段
    if (existing.treeSort !== 'mtime') options.store.setTreeSort(existing.id, 'mtime')
  } else {
    /*
     * 默认排序用 mtime：这个库是 AI 随手写文档的地方，文档名往往没有规律，
     * 「最近改的那篇」比「按名字找」实用得多。用户仍可在树工具栏切回 manual。
     */
    options.store.add({ ...createWorkspaceEntry(root), treeSort: 'mtime' })
  }

  try {
    options.markSeeded()
  } catch (error) {
    // 标记失败只影响「下次是否再检查一遍」，目录与记录已经建好，不值得中断
    log(`默认工作区标记写入失败：${(error as Error).message}`)
  }

  log(`已创建默认工作区：${root}`)
  return { created: !existing, root }
}

/** 判断一个工作区根是否就是默认工作区（服务端据此打「默认落笔处」标记） */
export function isDefaultWorkspaceRoot(root: string, documentsDir: string): boolean {
  return root === defaultWorkspaceRoot(documentsDir)
}

/** 需要写入的 settings 补丁（供主进程一处落地） */
export function seededSettingsPatch(): Pick<AppSettings, 'defaultWorkspaceSeeded'> {
  return { defaultWorkspaceSeeded: true }
}

/**
 * 这个工作区能不能被移除？
 *
 * 抽成纯函数而不是写在 ipc 的 handler 里：这是「默认工作区不可删」的**唯一**
 * 判定点，界面（隐藏按钮）、命令面板、将来的脚本都该问它，而不是各自理解
 * 「什么叫默认工作区」。
 *
 * 注意它判的是**根路径**而不是 `entry.default` 标记：标记是派生字段，
 * 可能来自旧快照或未标记的调用方；路径是事实。
 */
export function isRemovableWorkspace(
  entry: { root: string },
  defaultRoot: string | null | undefined,
): boolean {
  return !(defaultRoot && entry.root === defaultRoot)
}
