/**
 * 文档写入语义的契约测试。
 *
 * 这里断言的是**不变量**，不是实现细节：
 *  - create 绝不覆盖已有文件（静默覆盖用户手写文档是本功能最坏的失败形态）
 *  - overwrite 必须带 baseMtime，且 mtime 变化就拒绝（与编辑器保存同一套冲突判定）
 *  - append 只追加、文件不存在就拒绝
 *  - 路径与扩展名规则与扫描口径一致（写得进去就必须看得见）
 *  - 超限拒绝，不留半截文件
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { DOC_WRITE_MAX_BYTES, writeDocText } = await import('../src/doc-write.mjs')
const { validateDocRelativePath } = await import('../src/doc-paths.mjs')

/** 临时工作区根：测试一律不碰真实用户数据目录 */
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'docvi-doc-write-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function codeOf(fn) {
  try {
    fn()
  } catch (error) {
    return error.code
  }
  return 'NO_THROW'
}

/* ---------- create ---------- */

test('create：新建文档，父目录自动创建', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const out = writeDocText({ root: dir, relPath: '指南/入门.md', text: '# 入门\n' })
    assert.equal(out.status, 'created')
    assert.equal(out.relPath, '指南/入门.md')
    assert.equal(readFileSync(join(dir, '指南', '入门.md'), 'utf8'), '# 入门\n')
    assert.ok(out.mtime > 0)
    assert.equal(out.bytes, Buffer.byteLength('# 入门\n'))
  } finally {
    cleanup()
  }
})

test('create：目标已存在时拒绝，且原内容一字不动', () => {
  const { dir, cleanup } = tempRoot()
  try {
    writeFileSync(join(dir, 'a.md'), '原有内容\n', 'utf8')
    const code = codeOf(() => writeDocText({ root: dir, relPath: 'a.md', text: '新内容' }))
    assert.equal(code, 'E_EXISTS')
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), '原有内容\n', '绝不能静默覆盖')
  } finally {
    cleanup()
  }
})

test('create：空文档合法（只建壳、稍后追加）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const out = writeDocText({ root: dir, relPath: 'blank.md', text: '' })
    assert.equal(out.status, 'created')
    assert.equal(readFileSync(join(dir, 'blank.md'), 'utf8'), '')
  } finally {
    cleanup()
  }
})

/* ---------- overwrite ---------- */

test('overwrite：baseMtime 匹配时整篇替换', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const created = writeDocText({ root: dir, relPath: 'a.md', text: '旧\n' })
    const out = writeDocText({
      root: dir,
      relPath: 'a.md',
      text: '新\n',
      mode: 'overwrite',
      baseMtime: created.mtime,
    })
    assert.equal(out.status, 'updated')
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), '新\n')
  } finally {
    cleanup()
  }
})

test('overwrite：缺 baseMtime 直接拒绝（防盲覆盖）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    writeDocText({ root: dir, relPath: 'a.md', text: '旧\n' })
    const code = codeOf(() =>
      writeDocText({ root: dir, relPath: 'a.md', text: '新\n', mode: 'overwrite' }),
    )
    assert.equal(code, 'E_INVALID')
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), '旧\n')
  } finally {
    cleanup()
  }
})

test('overwrite：别人改过（mtime 变了）就报冲突，不覆盖', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const created = writeDocText({ root: dir, relPath: 'a.md', text: '旧\n' })
    /*
     * 模拟另一处写入：内容变、mtime 也要变。
     *
     * mtime 用 utimesSync 显式拉开，不依赖「两次写入落在不同时间戳」——CI 上
     * 文件系统时间粒度可能是秒级，连续两次写入会得到同一个 mtime，这条断言
     * 就会偶发地变成「冲突没检出」（实测 GitHub runner 上遇过）。
     */
    writeFileSync(join(dir, 'a.md'), '别人改的\n', 'utf8')
    const bumped = created.mtime + 5000
    utimesSync(join(dir, 'a.md'), bumped / 1000, bumped / 1000)
    const fresh = statSync(join(dir, 'a.md')).mtimeMs
    assert.notEqual(Math.round(fresh), Math.round(created.mtime), '前置条件：mtime 确实变了')

    // 用旧 mtime 写入必须被拒
    assert.equal(
      codeOf(() =>
        writeDocText({
          root: dir,
          relPath: 'a.md',
          text: '覆盖\n',
          mode: 'overwrite',
          baseMtime: created.mtime,
        }),
      ),
      'E_CONFLICT',
    )
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), '别人改的\n', '冲突时原文件不动')

    // 用刚读到的 mtime 则成功
    assert.doesNotThrow(() =>
      writeDocText({
        root: dir,
        relPath: 'a.md',
        text: '覆盖\n',
        mode: 'overwrite',
        baseMtime: fresh,
      }),
    )
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), '覆盖\n')
  } finally {
    cleanup()
  }
})

test('overwrite：文件不存在时报 not found（不悄悄新建）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const code = codeOf(() =>
      writeDocText({ root: dir, relPath: 'ghost.md', text: 'x', mode: 'overwrite', baseMtime: 1 }),
    )
    assert.equal(code, 'E_NOT_FOUND')
  } finally {
    cleanup()
  }
})

/* ---------- append ---------- */

test('append：追加到末尾，保留原有内容', () => {
  const { dir, cleanup } = tempRoot()
  try {
    writeDocText({ root: dir, relPath: 'a.md', text: '# 标题\n' })
    const out = writeDocText({ root: dir, relPath: 'a.md', text: '- 新增一行\n', mode: 'append' })
    assert.equal(out.status, 'appended')
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), '# 标题\n- 新增一行\n')
  } finally {
    cleanup()
  }
})

test('append：文件不存在时报 not found（多半是路径写错了）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const code = codeOf(() =>
      writeDocText({ root: dir, relPath: 'ghost.md', text: 'x', mode: 'append' }),
    )
    assert.equal(code, 'E_NOT_FOUND')
  } finally {
    cleanup()
  }
})

/* ---------- 路径与大小 ---------- */

test('路径规则：拒绝 .. / 绝对路径 / 非 md / 点开头 / 扫描排除目录', () => {
  assert.equal(validateDocRelativePath('指南/入门.md'), '指南/入门.md')
  assert.equal(validateDocRelativePath('.\\指南\\入门.markdown'), '指南/入门.markdown')
  assert.equal(validateDocRelativePath('./a.md'), 'a.md')

  for (const bad of [
    '../逃逸.md',
    '指南/../../逃逸.md',
    '/绝对/路径.md',
    'C:/absolute.md',
    'a.txt',
    'a.png',
    'a',
    '.hidden/a.md',
    'a/.hidden.md',
    'node_modules/a.md',
    'assets/a.md',
    '',
  ]) {
    assert.throws(() => validateDocRelativePath(bad), /./, `应拒绝：${bad}`)
  }
})

test('路径规则：错误码统一是 E_INVALID（调用方据此转文案）', () => {
  assert.equal(
    codeOf(() => validateDocRelativePath('../x.md')),
    'E_INVALID',
  )
  assert.equal(
    codeOf(() => validateDocRelativePath('x.txt')),
    'E_INVALID',
  )
})

test('大小上限：正文超限拒绝，且不留半截文件', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const huge = 'a'.repeat(DOC_WRITE_MAX_BYTES + 1)
    const code = codeOf(() => writeDocText({ root: dir, relPath: 'big.md', text: huge }))
    assert.equal(code, 'E_TOO_LARGE')
    assert.throws(() => statSync(join(dir, 'big.md')), '超限时不应留下文件')
  } finally {
    cleanup()
  }
})

test('append 后的总大小超限也要拒绝（不是只看增量）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    const half = 'a'.repeat(DOC_WRITE_MAX_BYTES - 10)
    writeDocText({ root: dir, relPath: 'a.md', text: half })
    const code = codeOf(() =>
      writeDocText({ root: dir, relPath: 'a.md', text: 'b'.repeat(100), mode: 'append' }),
    )
    assert.equal(code, 'E_TOO_LARGE')
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8').length, half.length, '失败不应改动原文件')
  } finally {
    cleanup()
  }
})

test('未知 mode 报 E_INVALID（不静默当成 create）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    assert.equal(
      codeOf(() => writeDocText({ root: dir, relPath: 'a.md', text: 'x', mode: 'upsert' })),
      'E_INVALID',
    )
  } finally {
    cleanup()
  }
})

/* ---------- 符号链接逃逸 ---------- */

test('符号链接：目录链接指向根外时拒绝写入（字面路径完全合法）', () => {
  const { dir, cleanup } = tempRoot()
  const outside = tempRoot()
  try {
    symlinkSync(outside.dir, join(dir, 'link'), 'junction')
    const code = codeOf(() => writeDocText({ root: dir, relPath: 'link/逃逸.md', text: 'x' }))
    assert.equal(code, 'E_INVALID')
    // 关键断言：根外目录里不能出现任何新文件
    assert.equal(existsSync(join(outside.dir, '逃逸.md')), false)
  } finally {
    cleanup()
    outside.cleanup()
  }
})

test('符号链接：文件链接指向根外时拒绝覆盖与追加（不读也不写根外内容）', () => {
  const { dir, cleanup } = tempRoot()
  const outside = tempRoot()
  try {
    writeFileSync(join(outside.dir, 'secret.md'), '根外内容', 'utf8')
    symlinkSync(join(outside.dir, 'secret.md'), join(dir, 'linked.md'))
    assert.equal(
      codeOf(() => writeDocText({ root: dir, relPath: 'linked.md', text: 'x', mode: 'create' })),
      'E_INVALID',
    )
    assert.equal(
      codeOf(() => writeDocText({ root: dir, relPath: 'linked.md', text: 'x', mode: 'append' })),
      'E_INVALID',
    )
    assert.equal(
      readFileSync(join(outside.dir, 'secret.md'), 'utf8'),
      '根外内容',
      '根外文件不能被改动',
    )
  } finally {
    cleanup()
    outside.cleanup()
  }
})

test('符号链接：根内的链接照常可用（不误伤正常场景）', () => {
  const { dir, cleanup } = tempRoot()
  try {
    mkdirSync(join(dir, 'real'), { recursive: true })
    symlinkSync(join(dir, 'real'), join(dir, 'alias'), 'junction')
    const out = writeDocText({ root: dir, relPath: 'alias/a.md', text: '# 通过别名\n' })
    assert.equal(out.status, 'created')
    // 写入确实落地在根内（别名与真实目录是同一份）
    assert.equal(readFileSync(join(dir, 'real/a.md'), 'utf8'), '# 通过别名\n')
  } finally {
    cleanup()
  }
})
