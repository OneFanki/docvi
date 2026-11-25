/**
 * 隔离模式下的路径推导契约。
 *
 * 背景（2026-11-25 严重事故）：`DOCVI_DATA_DIR` 只隔离了注册表与设置，内建默认
 * 工作区仍取系统「文档」目录。一次截图跑下来，产品截图里出现了用户私人笔记的
 * 文件名——这不是显示问题，是测试脚本真的读了真实的 `~/Documents/docvi`。
 *
 * 不变量：只要给了 `DOCVI_DATA_DIR`，**所有**从系统环境推导的路径都必须落到它
 * 里面；只有不给（生产运行）才回退系统值。
 */
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { documentsDirFor } from '../../apps/desktop/src/main/paths-isolation.ts'

/** 占位路径：用不可能存在的段名，避免被敏感扫描当成真实本机路径 */
const DATA_DIR = join(tmpdir(), 'docvi-data-fixture')
const SYSTEM_DOCUMENTS = join(tmpdir(), 'docvi-system-documents-fixture')

test('给了数据目录：默认工作区落到数据目录内部，不碰系统文档目录', () => {
  const dir = documentsDirFor(DATA_DIR, SYSTEM_DOCUMENTS)
  assert.equal(dir, join(DATA_DIR, 'documents'))
  assert.ok(
    !dir.startsWith(SYSTEM_DOCUMENTS),
    '隔离模式下绝不能推导到系统文档目录（会读进用户的私人文档）',
  )
})

test('没给数据目录：回退系统文档目录（生产行为不变）', () => {
  assert.equal(documentsDirFor(undefined, SYSTEM_DOCUMENTS), SYSTEM_DOCUMENTS)
  assert.equal(documentsDirFor('', SYSTEM_DOCUMENTS), SYSTEM_DOCUMENTS)
})

test('空白串按「没给」处理，不要拼出空的路径段', () => {
  assert.equal(documentsDirFor('   ', SYSTEM_DOCUMENTS), SYSTEM_DOCUMENTS)
})
