/**
 * 插件市场「拉产物」链路的回归测试。
 *
 * 用户的要求是「插件仓库自动构建出产物，我们只管拉产物」。这条链路里任何一处
 * 判错都不会报错，只会表现为「点了安装没反应」或更糟——把错误页当成插件代码
 * 写进磁盘、或让一个构造过的路径写到插件目录之外。所以规则必须由测试钉住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const {
  trustedArtifactUrl,
  parseArtifact,
  safePackagePath,
  artifactFiles,
  looksLikeHtml,
  manifestMatchesEntry,
  githubRepoOf,
} = await import('../apps/desktop/src/main/plugin-artifact.ts')
// star 折叠规则放在共享包：主进程与渲染层必须用同一份，否则两处显示会不一致
const { formatStars } = await import('../packages/shared/src/ipc.ts')
// GraphQL 批量结果的解析与查询构造（每日刷新 CI 用）
const { buildBatchQuery, parseBatchResponse } = await import('./market-refresh.mjs')

/* ---------- 产物地址可信域 ---------- */

test('只接受 https 且落在可信域的产物地址', () => {
  assert.ok(trustedArtifactUrl('https://raw.githubusercontent.com/o/r/v1/plugin.json'))
  assert.ok(trustedArtifactUrl('https://github.com/o/r/releases/download/v1/plugin.json'))
  assert.ok(trustedArtifactUrl('https://objects.githubusercontent.com/x/y'))
})

test('同形域名与非 https 一律拒绝', () => {
  assert.equal(trustedArtifactUrl('https://github.com.evil.com/x'), null)
  assert.equal(trustedArtifactUrl('https://githubusercontent.com.evil.com/x'), null)
  assert.equal(trustedArtifactUrl('http://raw.githubusercontent.com/x'), null)
  assert.equal(trustedArtifactUrl('file:///etc/passwd'), null)
  assert.equal(trustedArtifactUrl('javascript:alert(1)'), null)
  assert.equal(trustedArtifactUrl(''), null)
  assert.equal(trustedArtifactUrl(null), null)
})

test('自建市场可追加域名，但不能顺手关掉默认白名单', () => {
  assert.ok(trustedArtifactUrl('https://cdn.example.com/p.json', 'cdn.example.com'))
  // 追加之后 GitHub 仍然可用
  assert.ok(trustedArtifactUrl('https://raw.githubusercontent.com/o/r/x', 'cdn.example.com'))
  // 未追加时仍然拒绝
  assert.equal(trustedArtifactUrl('https://cdn.example.com/p.json', ''), null)
})

test('http 只在显式配置的域名上放行（内网私有市场），默认一律拒绝', () => {
  // 未配置：http 一律拒绝，包括回环地址——自动放宽等于给本地端口开后门
  assert.equal(trustedArtifactUrl('http://127.0.0.1:8080/plugin.json', ''), null)
  assert.equal(trustedArtifactUrl('http://localhost:8080/plugin.json', ''), null)
  // 显式配置后放行（部署在内网、没有证书是常见情况）
  assert.ok(trustedArtifactUrl('http://127.0.0.1:8080/plugin.json', '127.0.0.1'))
  assert.ok(trustedArtifactUrl('http://market.internal/x.json', 'market.internal'))
  // 但没配置的域名仍然拒绝，即使协议是 https
  assert.equal(trustedArtifactUrl('http://other.internal/x.json', 'market.internal'), null)
})

test('artifact 段缺 manifest 或地址不可信都解析失败（坏条目跳过而不是整份拒绝）', () => {
  assert.equal(parseArtifact(null), null)
  assert.equal(parseArtifact({}), null)
  assert.equal(parseArtifact({ manifest: 'http://raw.githubusercontent.com/x' }), null)
  assert.deepEqual(
    parseArtifact({ manifest: 'https://raw.githubusercontent.com/o/r/v1/plugin.json' }),
    {
      manifest: 'https://raw.githubusercontent.com/o/r/v1/plugin.json',
    },
  )
  // sha256 归一成小写，比较时不必关心作者怎么写
  assert.equal(
    parseArtifact({
      manifest: 'https://raw.githubusercontent.com/o/r/v1/plugin.json',
      sha256: 'ABC123',
    })?.sha256,
    'abc123',
  )
})

/* ---------- 包内路径校验 ---------- */

test('合法包内相对路径原样返回', () => {
  assert.equal(safePackagePath('dist/index.js'), 'dist/index.js')
  assert.equal(safePackagePath('style.css'), 'style.css')
  // 反斜杠统一成正斜杠（Windows 风格写法不该被当成合法分隔符绕过检查）
  assert.equal(safePackagePath('dist\\index.js'), 'dist/index.js')
})

test('越级与绝对路径一律拒绝（否则能把文件写到插件目录之外）', () => {
  assert.equal(safePackagePath('../evil.js'), null)
  assert.equal(safePackagePath('dist/../../evil.js'), null)
  assert.equal(safePackagePath('/etc/passwd'), null)
  assert.equal(safePackagePath('C:/Windows/system32/x.dll'), null)
  assert.equal(safePackagePath('dist//index.js'), null)
  assert.equal(safePackagePath('./index.js'), null)
  assert.equal(safePackagePath(''), null)
  assert.equal(safePackagePath(null), null)
  assert.equal(safePackagePath('a\0b'), null)
})

/* ---------- 需要下载的文件清单 ---------- */

test('只下载入口与样式，相对路径按 manifest 地址解析成绝对地址', () => {
  const files = artifactFiles(
    { entry: 'dist/index.js', styles: ['dist/style.css'] },
    'https://raw.githubusercontent.com/o/r/v0.1.0/plugin.json',
  )
  assert.deepEqual(files, [
    {
      path: 'dist/index.js',
      url: 'https://raw.githubusercontent.com/o/r/v0.1.0/dist/index.js',
    },
    {
      path: 'dist/style.css',
      url: 'https://raw.githubusercontent.com/o/r/v0.1.0/dist/style.css',
    },
  ])
})

test('没有样式的插件只下载入口；重复声明不会下载两遍', () => {
  const only = artifactFiles(
    { entry: 'index.js' },
    'https://github.com/o/r/releases/download/v1/plugin.json',
  )
  assert.equal(only.length, 1)
  const dup = artifactFiles(
    { entry: 'dist/index.js', styles: ['dist/index.js', 'dist/a.css', 'dist/a.css'] },
    'https://raw.githubusercontent.com/o/r/v1/plugin.json',
  )
  assert.deepEqual(
    dup.map(item => item.path),
    ['dist/index.js', 'dist/a.css'],
  )
})

test('入口路径非法时跳过而不是带着 .. 去下载', () => {
  const files = artifactFiles(
    { entry: '../../evil.js', styles: ['ok.css'] },
    'https://raw.githubusercontent.com/o/r/v1/plugin.json',
  )
  assert.deepEqual(
    files.map(item => item.path),
    ['ok.css'],
  )
})

/* ---------- 错误页识别 ---------- */

test('404 页 / 登录墙被识别成 HTML，不会当成插件代码写盘', () => {
  assert.equal(looksLikeHtml('<!DOCTYPE html>\n<html><body>404</body></html>'), true)
  assert.equal(looksLikeHtml('  \n<html lang="en">'), true)
  assert.equal(looksLikeHtml('import { x } from "vue"'), false)
  assert.equal(looksLikeHtml('{"a":1}'), false)
  assert.equal(looksLikeHtml(''), false)
})

/* ---------- 清单与远端 manifest 的一致性 ---------- */

test('name 或 version 与清单不一致时拒绝（防装上另一个插件）', () => {
  const entry = { name: 'docs-plugin-a', version: '1.2.0' }
  assert.equal(manifestMatchesEntry({ name: 'docs-plugin-a', version: '1.2.0' }, entry).ok, true)
  assert.equal(manifestMatchesEntry({ name: 'docs-plugin-b', version: '1.2.0' }, entry).ok, false)
  assert.equal(manifestMatchesEntry({ name: 'docs-plugin-a', version: '9.9.9' }, entry).ok, false)
})

/* ---------- GitHub 仓库信息 ---------- */

test('从仓库地址推出 owner/repo（.git 后缀与 www 都能处理）', () => {
  assert.deepEqual(githubRepoOf('https://github.com/OneFanki/docvi'), {
    owner: 'OneFanki',
    repo: 'docvi',
  })
  assert.deepEqual(githubRepoOf('https://github.com/o/r.git'), { owner: 'o', repo: 'r' })
  assert.deepEqual(githubRepoOf('https://www.github.com/o/r/'), { owner: 'o', repo: 'r' })
})

test('非 GitHub 托管不猜接口', () => {
  assert.equal(githubRepoOf('https://gitlab.com/o/r'), null)
  assert.equal(githubRepoOf('https://gitee.com/o/r'), null)
  assert.equal(githubRepoOf('https://github.com/o'), null)
  assert.equal(githubRepoOf('not a url'), null)
  assert.equal(githubRepoOf(null), null)
})

test('GitHub API 返回里只取可信字段，异常值被丢弃', () => {
  // GraphQL 批量查询的一个别名（scripts/market-refresh.mjs 每日刷新用）
  const meta = parseBatchResponse(
    {
      data: {
        r0: {
          stargazerCount: 123,
          owner: { login: 'OneFanki', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
          url: 'https://github.com/OneFanki/docvi',
        },
      },
    },
    ['r0'],
  )
  assert.deepEqual(meta.get('r0'), {
    stars: 123,
    author: 'OneFanki',
    avatar: 'https://avatars.githubusercontent.com/u/1',
    homepage: 'https://github.com/OneFanki/docvi',
  })
})

test('查询构造：别名与引号安全（仓库带引号也不会破坏 GraphQL 语法）', () => {
  const query = buildBatchQuery([
    { owner: 'a', repo: 'b' },
    { owner: 'c"d', repo: 'e"f' },
  ])
  assert.match(query, /r0: repository\(owner: "a", name: "b"\)/)
  // JSON.stringify 的引号转义在 GraphQL 字符串里同样合法
  assert.match(query, /r1: repository\(owner: "c\\"d", name: "e\\"f"\)/)
})

test('批量解析：仓库消失（null + errors）该键返回 null，其余不受影响', () => {
  const result = parseBatchResponse(
    {
      data: {
        r0: {
          stargazerCount: 5,
          owner: { login: 'o', avatarUrl: '' },
          url: 'https://github.com/o/r',
        },
        r1: null,
        r2: { stargazerCount: 'bogus', owner: null, url: null },
      },
      errors: [{ message: 'Could not resolve to a Repository', path: ['r1'] }],
    },
    ['r0', 'r1', 'r2'],
  )
  assert.equal(result.get('r0')?.stars, 5)
  assert.equal(result.get('r1'), null, '仓库消失的键应为 null（调用方保留旧值）')
  // 字段类型异常的仓库：解析不出可用元信息，同样是 null
  assert.equal(result.get('r2'), null)
})

test('star 数折叠：千位以上用 k，避免卡片被长数字撑宽', () => {
  assert.equal(formatStars(0), '0')
  assert.equal(formatStars(999), '999')
  assert.equal(formatStars(1200), '1.2k')
  assert.equal(formatStars(1000), '1k')
  assert.equal(formatStars(12345), '12k')
  assert.equal(formatStars(Number.NaN), '0')
})
