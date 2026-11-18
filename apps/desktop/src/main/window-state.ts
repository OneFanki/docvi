import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { BrowserWindow } from 'electron'

/**
 * 主窗口尺寸 / 位置记忆。
 *
 * macOS 用户对「关掉再开又回到固定 1280×840」非常敏感：窗口状态属于会话现场，
 * 不是每次启动都该重置的默认值。这里单独存 `window-state.json`，不塞进
 * settings.json——那份文件是「可解释、可导出、可手改」的偏好，窗口坐标不是。
 *
 * 三条纪律：
 *  1. 坏文件 / 缺字段一律回默认值，不影响启动；
 *  2. 位置必须在某块屏幕的 workArea 里仍可见，否则丢弃坐标（显示器拔掉后窗口
 *     不能落在屏幕外）；
 *  3. 最大化状态恢复的是「最大化 + 之前的普通尺寸」，不是把最大化尺寸当普通尺寸。
 */

/** 屏幕工作区（只取用到的字段，避免测试依赖 Electron） */
export interface WindowArea {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/** 与 BrowserWindow 的 minWidth / minHeight 保持一致 */
export const MIN_WINDOW_WIDTH = 880
export const MIN_WINDOW_HEIGHT = 560
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 840 }

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 把磁盘上的任意 JSON 归一成可用窗口状态。
 *
 * 纯函数：显示器判断由调用方传 workArea 进来，单测里不需要 Electron 的 screen。
 */
export function normalizeWindowState(raw: unknown, areas: readonly WindowArea[]): WindowState {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const width = clamp(integer(record.width) ?? DEFAULT_WINDOW_SIZE.width, MIN_WINDOW_WIDTH, 12_000)
  const height = clamp(
    integer(record.height) ?? DEFAULT_WINDOW_SIZE.height,
    MIN_WINDOW_HEIGHT,
    12_000,
  )
  const maximized = record.maximized === true
  const x = integer(record.x)
  const y = integer(record.y)
  if (x === null || y === null) return { width, height, maximized }

  const visible = areas.some(
    area =>
      x < area.x + area.width &&
      x + width > area.x &&
      y < area.y + area.height &&
      y + height > area.y,
  )
  return visible ? { x, y, width, height, maximized } : { width, height, maximized }
}

export function readWindowState(file: string, areas: readonly WindowArea[]): WindowState {
  if (!existsSync(file)) return normalizeWindowState(null, areas)
  try {
    return normalizeWindowState(JSON.parse(readFileSync(file, 'utf8')) as unknown, areas)
  } catch {
    return normalizeWindowState(null, areas)
  }
}

export function writeWindowState(file: string, state: WindowState): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 监听窗口变化并落盘；返回解绑函数。
 *
 * resize / move 会高频触发，合并成 400ms 一次；close 时立刻存一次，避免最后
 * 一次拖动还没来得及落盘。
 */
export function trackWindowState(
  win: BrowserWindow,
  file: string,
  areas: () => readonly WindowArea[],
): () => void {
  let timer: NodeJS.Timeout | null = null

  const save = (): void => {
    if (win.isDestroyed()) return
    const bounds = win.getNormalBounds()
    writeWindowState(
      file,
      normalizeWindowState({ ...bounds, maximized: win.isMaximized() }, areas()),
    )
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      save()
    }, 400)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', save)

  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    win.removeListener('resize', schedule)
    win.removeListener('move', schedule)
    win.removeListener('maximize', schedule)
    win.removeListener('unmaximize', schedule)
    win.removeListener('close', save)
  }
}
