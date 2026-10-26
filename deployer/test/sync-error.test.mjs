/**
 * 同步错误的读者面摘要。
 *
 * 原始报错是 git 的 stderr，含服务器绝对路径（凭证临时文件、工作树），
 * 直接显示在读者面仓库卡片上既泄露部署内部结构、又对读者无信息量
 * （用户实测看到 `credential.helper=store --file=/data/creds...`）。
 *
 * 完整报错保留在运维面 `/api/repos`，那里才是排查现场。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { readerFacingSyncError } = await import('../src/store.mjs')

test('认证失败：给出可行动提示，且不泄露任何路径', () => {
  const raw =
    "fatal: could not read Username for 'https://git.example.com': terminal prompts disabled credential.helper=store --file=/data/creds/team.git-credentials"
  const text = readerFacingSyncError(raw)
  assert.match(text, /认证失败/)
  assert.ok(!text.includes('/data/'), `不应包含服务器路径：${text}`)
  assert.ok(!text.includes('credential.helper'), `不应包含 git 内部细节：${text}`)
})

test('网络不可达：归到连接类提示', () => {
  const text = readerFacingSyncError(
    'fatal: unable to access: Could not resolve host: git.example.com',
  )
  assert.match(text, /无法连接/)
  assert.ok(!text.includes('git.example.com'), '不应回显远端地址')
})

test('仓库或分支不存在', () => {
  assert.match(readerFacingSyncError('remote: Repository not found'), /不存在/)
})

test('未知错误：给通用摘要 + 指向运维面', () => {
  const text = readerFacingSyncError('something exploded at /var/lib/x/y')
  assert.match(text, /同步失败/)
  assert.match(text, /运维面/)
  assert.ok(!text.includes('/var/lib'), '未知错误同样不能带路径')
})

test('空消息（异常未被捕获到细节）也给一条可读文案', () => {
  assert.equal(readerFacingSyncError(''), '同步失败')
  assert.equal(readerFacingSyncError(null), '同步失败')
})
