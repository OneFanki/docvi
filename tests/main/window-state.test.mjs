/**
 * 窗口状态恢复的契约测试。
 *
 * 关键不变量：
 *  - 坏文件 / 缺字段回默认尺寸，不阻塞启动；
 *  - 显示器布局变化后，落在屏幕外的坐标必须丢弃（否则窗口「打开了但看不见」）；
 *  - 普通尺寸与最大化状态分开保存，最大化恢复的仍是之前的普通尺寸。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  normalizeWindowState,
  readWindowState,
  writeWindowState,
} from '../../apps/desktop/src/main/window-state.ts'

const AREA = { x: 0, y: 0, width: 1440, height: 900 }

test('缺字段：回默认尺寸且不带坐标', () => {
  assert.deepEqual(normalizeWindowState(null, [AREA]), {
    width: DEFAULT_WINDOW_SIZE.width,
    height: DEFAULT_WINDOW_SIZE.height,
    maximized: false,
  })
})

test('过小尺寸被抬到窗口最小尺寸', () => {
  const state = normalizeWindowState({ width: 100, height: 100 }, [AREA])
  assert.equal(state.width, MIN_WINDOW_WIDTH)
  assert.equal(state.height, MIN_WINDOW_HEIGHT)
})

test('可见坐标保留，最大化标记保留', () => {
  assert.deepEqual(normalizeWindowState({ x: 120, y: 80, width: 1000, height: 700 }, [AREA]), {
    x: 120,
    y: 80,
    width: 1000,
    height: 700,
    maximized: false,
  })
  const maximized = normalizeWindowState(
    { x: 120, y: 80, width: 1000, height: 700, maximized: true },
    [AREA],
  )
  assert.equal(maximized.maximized, true)
  assert.equal(maximized.width, 1000)
})

test('屏幕外坐标被丢弃，尺寸保留', () => {
  const state = normalizeWindowState({ x: 5000, y: 5000, width: 1000, height: 700 }, [AREA])
  assert.equal(state.x, undefined)
  assert.equal(state.y, undefined)
  assert.equal(state.width, 1000)
  assert.equal(state.height, 700)
})

test('坏 JSON 回默认值，读写往返保持状态', () => {
  const root = mkdtempSync(join(tmpdir(), 'docvi-window-state-'))
  const file = join(root, 'window-state.json')
  try {
    writeFileSync(file, '{not json', 'utf8')
    assert.deepEqual(readWindowState(file, [AREA]), {
      width: DEFAULT_WINDOW_SIZE.width,
      height: DEFAULT_WINDOW_SIZE.height,
      maximized: false,
    })

    const expected = { x: 10, y: 20, width: 1024, height: 768, maximized: true }
    writeWindowState(file, expected)
    assert.deepEqual(readWindowState(file, [AREA]), expected)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
