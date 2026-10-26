/**
 * 桌面宿主 git 服务：纯逻辑单测（路径净化、进度解析、错误翻译）。
 *
 * 为什么只测这些：真正会跑网络的 clone/pull 需要可用的 git 与远端，属于
 * 运行时验收范围（临时脚本实测），不适合进 CI。但**名字怎么落成目录**、
 * **git 的英文 stderr 怎么翻成可行动提示**这两类逻辑是纯函数，出错的代价
 * 又很高（目录撞名 / 用户看不懂报错），必须有回归保护。
 *
 * 实现独立于窗口层，用例覆盖命令拼装与错误映射。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  branchDir,
  friendlyError,
  parsePercent,
  phaseMessage,
  sanitizeDirName,
} from '../../apps/desktop/src/main/git.mjs'

test('git 进度解析：百分比与阶段中文', () => {
  assert.equal(parsePercent('Receiving objects: 45% (56/123)'), 45)
  assert.equal(parsePercent('Receiving objects: 100% (123/123), done.'), 100)
  assert.equal(parsePercent('Cloning into bare repository...'), null)
  assert.equal(parsePercent('Receiving objects: 145%'), null, '超 100 不接受')

  assert.equal(phaseMessage('Cloning into bare repository...'), '初始化平台副本…')
  assert.equal(phaseMessage('Receiving objects: 45%'), '接收数据…')
  assert.equal(phaseMessage('remote: Enumerating objects: 12'), '枚举对象（远端）…')
  assert.equal(phaseMessage('Resolving deltas: 10%'), '解算差异…')
})

test('git 错误翻译：可行动的提示优先，认不出回退前两行', () => {
  assert.match(friendlyError('fatal: repository not found'), /仓库不存在/)
  assert.match(friendlyError('terminal prompts disabled'), /需要登录凭证/)
  assert.match(friendlyError('Authentication failed for https://x'), /凭证被拒绝/)
  assert.match(friendlyError('Could not resolve host: git.example.com'), /无法解析仓库域名/)
  const fallback = friendlyError('第一行错误\n第二行细节\n第三行')
  assert.equal(fallback, '第一行错误；第二行细节')
})

test('目录名净化：非法字符替换、保留中文、截断与缺省', () => {
  assert.equal(sanitizeDirName('my:repo?name'), 'my-repo-name')
  assert.equal(sanitizeDirName('  测试仓库  '), '测试仓库')
  assert.equal(sanitizeDirName(''), 'repo')
  assert.equal([...sanitizeDirName('a'.repeat(100))].length, 60)
})

test('分支名 → 目录名：特殊字符压缩为单个下划线', () => {
  assert.equal(branchDir('feature/foo'), 'feature_foo')
  assert.equal(branchDir('a//b'), 'a_b')
  assert.equal(branchDir('v1.0.0'), 'v1.0.0')
  assert.equal(branchDir(''), 'branch')
})
