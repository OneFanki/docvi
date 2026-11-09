/**
 * 开发版与安装版数据目录隔离的决策契约。
 *
 * 不变量（每一条都对应一个真实故障，见 dev-data.ts 的注释）：
 *  - 开发版（未打包）永远落到 `<appData>/docvi-dev`，不碰安装版的 `docvi`；
 *  - 打包版永不干预，保持 Electron 自己算出来的目录；
 *  - 调用方给了 `DOCVI_DATA_DIR` 或 `--user-data-dir` 时**不再叠加隔离**——
 *    测试夹具自己指定了临时目录，再叠一层会把测试写进开发者真实数据目录
 *    （AGENTS 明令禁止触碰真实用户数据目录）。
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEV_APP_NAME,
  DEV_DATA_DIR_NAME,
  devDataDir,
  userDataDirArg,
} from '../../apps/desktop/src/main/dev-data.ts'

const APP_DATA = 'C:/Users/someone/AppData/Roaming'
/** 期望值必须用 join 构造：Windows 上 join 会把正斜杠归一成反斜杠 */
const DEV_DIR = join(APP_DATA, DEV_DATA_DIR_NAME)

test('开发版用独立目录，与安装版分开', () => {
  const dir = devDataDir({
    packaged: false,
    appDataDir: APP_DATA,
    argv: ['electron.exe', '.'],
  })
  assert.equal(dir, DEV_DIR)
  assert.notEqual(dir, join(APP_DATA, 'docvi'), '绝不能与安装版共用同一个目录')
})

test('打包版不干预：返回 undefined 表示沿用 Electron 默认', () => {
  for (const argv of [[], ['docvi.exe'], ['docvi.exe', '--user-data-dir=X']]) {
    assert.equal(
      devDataDir({ packaged: true, appDataDir: APP_DATA, argv }),
      undefined,
      `打包版不该被改目录（argv=${JSON.stringify(argv)}）`,
    )
  }
})

test('DOCVI_DATA_DIR 优先于开发版隔离', () => {
  assert.equal(
    devDataDir({
      packaged: false,
      appDataDir: APP_DATA,
      argv: [],
      envOverride: 'C:/temp/docvi-test',
    }),
    undefined,
    '测试夹具指定了目录，这里不能覆盖它',
  )
})

test('--user-data-dir 优先于开发版隔离', () => {
  assert.equal(
    devDataDir({
      packaged: false,
      appDataDir: APP_DATA,
      argv: ['electron.exe', '--user-data-dir=C:/temp/docvi-e2e'],
    }),
    undefined,
  )
})

test('空白覆盖值按「没给」处理', () => {
  assert.equal(
    devDataDir({ packaged: false, appDataDir: APP_DATA, argv: [], envOverride: '   ' }),
    DEV_DIR,
  )
})

test('解析 --user-data-dir 的两种写法', () => {
  assert.equal(userDataDirArg(['--user-data-dir=C:/a/b']), 'C:/a/b')
  assert.equal(userDataDirArg(['--user-data-dir', 'C:/a/b']), 'C:/a/b')
  assert.equal(userDataDirArg(['--user-data-dir=C:\\a b\\c']), 'C:\\a b\\c')
})

test('--user-data-dir 后面跟着另一个开关时视为没给', () => {
  // `--user-data-dir --remote-debugging-port=0` 是漏了目录，不是目录名叫那个开关
  assert.equal(userDataDirArg(['--user-data-dir', '--remote-debugging-port=0']), undefined)
  assert.equal(userDataDirArg(['--user-data-dir=']), undefined)
  assert.equal(userDataDirArg(['--user-data-dir', '   ']), undefined)
})

test('开发版有独立应用名，避免单实例锁互顶', () => {
  // 单实例锁建在 userData 里；名字不同是第二道保险，让任务栏也能区分
  assert.notEqual(DEV_APP_NAME, 'docvi')
  assert.match(DEV_APP_NAME, /dev/i)
})
