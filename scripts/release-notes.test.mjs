/**
 * 版本说明抽取的回归测试。
 *
 * 这段逻辑决定 GitHub Release 的正文。两类错误代价都很高：
 *  - **抽错**（`0.2.2` 匹配到 `0.2.20`、或没在下一个 `## [` 处停下）→ 发出别人的说明；
 *  - **抽不到却不报错** → 发出一个只有提交标题的版本，用户不知道这次改了什么。
 *
 * 所以这里既断言「能取到」，也断言「取不到时返回 undefined」——CLI 层据此
 * 非零退出，让发版失败而不是带着空说明发出去。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const { extractReleaseNotes } = await import('../scripts/release-notes.mjs')

const SAMPLE = `# 更新日志

## [未发布]

### 中文

待发。

## [0.2.2] - 2026-10-27

### 中文

- 表格可视化编辑
- 切视图不丢状态

### English

- Visual table editing

## [0.2.1] - 2026-10-26

### 中文

- 旧版本内容

## [0.2.20] - 2026-11-01

### 中文

- 未来版本
`

test('按版本号取出对应小节，不含标题、不越界', () => {
  const notes = extractReleaseNotes(SAMPLE, '0.2.2')
  assert.ok(notes, '应取到 0.2.2')
  assert.match(notes, /表格可视化编辑/)
  assert.match(notes, /Visual table editing/)
  assert.doesNotMatch(notes, /旧版本内容/, '不能把下一个版本的内容带进来')
  assert.doesNotMatch(notes, /未来版本/, '不能把更后面的版本内容带进来')
  assert.doesNotMatch(notes, /^## \[/, '正文不应包含小节标题')
})

test('版本号精确匹配：0.2.2 不得命中 0.2.20', () => {
  const notes = extractReleaseNotes(SAMPLE, '0.2.20')
  assert.ok(notes)
  assert.match(notes, /未来版本/)
  assert.doesNotMatch(notes, /表格可视化编辑/)

  // 反向：取 0.2.20 时不能因为没有它而回落到 0.2.2
  assert.equal(extractReleaseNotes(SAMPLE, '0.2.200'), undefined)
})

test('不同版本各取各的', () => {
  assert.match(extractReleaseNotes(SAMPLE, '0.2.1') ?? '', /旧版本内容/)
})

test('缺小节时返回 undefined（调用方据此让发版失败）', () => {
  assert.equal(extractReleaseNotes(SAMPLE, '9.9.9'), undefined)
  assert.equal(extractReleaseNotes(SAMPLE, ''), undefined)
  assert.equal(extractReleaseNotes(SAMPLE, undefined), undefined)
})

test('小节存在但正文为空：同样视为没写说明', () => {
  const empty = '## [0.3.0] - 2026-12-01\n\n## [0.2.9] - 2026-11-01\n\n- 有内容\n'
  assert.equal(extractReleaseNotes(empty, '0.3.0'), undefined)
})

test('标题不带日期也能识别（发版前用未发布占位时的形态）', () => {
  const markdown = '## [0.4.0]\n\n- 只有摘要\n'
  assert.equal(extractReleaseNotes(markdown, '0.4.0'), '- 只有摘要')
})

test('仓库真实的 CHANGELOG.md 能抽出当前版本', async () => {
  const { readFileSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const markdown = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

  const notes = extractReleaseNotes(markdown, version)
  assert.ok(notes, `CHANGELOG.md 缺少 ${version} 的小节——发版会失败`)
  assert.match(notes, /### 中文/, '应有中文说明')
  assert.match(notes, /### English/, '应有英文说明')

  // CLI 入口本身也要能跑通（工作流调的就是它）
  const stdout = execFileSync(
    process.execPath,
    [join(root, 'scripts', 'release-notes.mjs'), version, '-'],
    { encoding: 'utf8' },
  )
  assert.match(stdout, /### 中文/)
})
