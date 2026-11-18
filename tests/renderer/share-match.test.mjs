/**
 * 「这篇文档是否已分享」的判定（纯函数单测）。
 *
 * 判错的表现全是静默的：按钮该亮不亮、取消分享点不到，或者更糟——把文档误判
 * 成「已分享」而让人点删除时删掉了别的分享。所以这里把三类边界都钉住：
 * 路径写法差异、目录前缀的段边界、以及「文件分享优先于目录分享」的选法。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { findShareForDoc } from '../../apps/desktop/src/renderer/src/lib/share-match.ts'

const file = (id, path) => ({ id, path, kind: 'file' })
const dir = (id, path) => ({ id, path, kind: 'dir' })

test('文件分享命中文档本身', () => {
  const shares = [file('s1', 'C:\\Docs\\guide\\intro.md')]
  const hit = findShareForDoc(shares, 'C:/Docs/guide/intro.md')
  assert.equal(hit?.share.id, 's1')
  assert.equal(hit?.via, 'file')
})

test('分隔符与大小写差异不影响命中', () => {
  const shares = [file('s1', 'C:/Docs/Guide/Intro.MD')]
  assert.equal(findShareForDoc(shares, 'C:\\docs\\guide\\intro.md')?.share.id, 's1')
})

test('未被分享的文档返回 null', () => {
  const shares = [file('s1', 'C:/Docs/a.md'), dir('s2', 'C:/Other')]
  assert.equal(findShareForDoc(shares, 'C:/Docs/b.md'), null)
})

test('祖先目录分享算「已分享」，并标记来源为目录', () => {
  const shares = [dir('s2', 'C:/Docs')]
  const hit = findShareForDoc(shares, 'C:/Docs/guide/intro.md')
  assert.equal(hit?.share.id, 's2')
  assert.equal(hit?.via, 'dir', '界面要靠这个区分「取消的是整个目录」')
})

test('目录分享的段边界：/guide-2 不属于 /guide', () => {
  /*
   * 少一个分隔符就是跨目录误判：用户打开 /guide-2/x.md 会被告知「已分享」，
   * 而实际上它不在 /guide 的分享范围内。
   */
  const shares = [dir('s1', 'C:/Docs/guide')]
  assert.equal(findShareForDoc(shares, 'C:/Docs/guide-2/x.md'), null)
  assert.equal(findShareForDoc(shares, 'C:/Docs/guide/x.md')?.share.id, 's1')
})

test('目录自身被当作文档打开时也算命中', () => {
  const shares = [dir('s1', 'C:/Docs/guide')]
  assert.equal(findShareForDoc(shares, 'C:/Docs/guide')?.share.id, 's1')
})

test('同时有文件分享与祖先目录分享时，优先返回文件分享', () => {
  /*
   * 优先文件分享：那是用户针对这篇文档点「分享」的那次动作，取消它最直接
   * 对应「我不想分享这一篇」。目录分享仍然存在，界面据此显示为目录分享。
   */
  const shares = [dir('s-dir', 'C:/Docs'), file('s-file', 'C:/Docs/a.md')]
  const hit = findShareForDoc(shares, 'C:/Docs/a.md')
  assert.equal(hit?.share.id, 's-file')
  assert.equal(hit?.via, 'file')
})

test('路径大小写不同但指向同一文件仍命中', () => {
  const shares = [file('s1', 'C:/USERS/FANKI/doc.md')]
  assert.equal(findShareForDoc(shares, 'c:/users/fanki/DOC.md')?.share.id, 's1')
})

test('尾斜杠不影响目录匹配', () => {
  const shares = [dir('s1', 'C:/Docs/guide/')]
  assert.equal(findShareForDoc(shares, 'C:/Docs/guide/a.md')?.share.id, 's1')
})

test('空路径与空分享表都给 null，不抛异常', () => {
  assert.equal(findShareForDoc([], 'C:/Docs/a.md'), null)
  assert.equal(findShareForDoc([file('s1', 'C:/Docs/a.md')], ''), null)
})
