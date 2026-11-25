/**
 * 分享页渲染契约。
 *
 * 这里守的是四条**会静默失效**的约定——都不会报错，只会让分享页看起来不对劲：
 *
 *  1. 主题跟随分享者本机：写进 `<html data-theme>`，而不是按访客系统深浅猜；
 *  2. 插件主题的 token 要真的内联进页面，否则一个只覆盖强调色的主题在分享页上
 *     等于没生效；
 *  3. mermaid 占位块必须带着 `data-mermaid` 与 `pre.at-mermaid-src` 这两个
 *     选择器约定——页面运行时就靠它们找块，改一处就全都不渲染；
 *  4. 下载链接与阅读是同一套路径归一（省略 `.md`、目录落 index.md）。
 *
 * 全部走真实渲染函数，不做「源码里必须有某字符串」式的检测。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { createShareRenderer } from '../../apps/desktop/src/service/share.ts'

const dirs = []
function tempDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `docvi-share-${tag}-`))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function writeFile(root, rel, text) {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

const SAMPLE = `# 标题

正文含 \`console.log(1)\`。

\`\`\`mermaid
flowchart LR
  A[甲] --> B[乙]
\`\`\`

[站内链接](./其它.md)
`

function shareOf(path, kind) {
  return { id: 'a1b2c3d4e5f60718', path, kind, createdAt: 0 }
}

test('分享页用分享者主题，而不是访客系统深浅', async () => {
  const root = tempDir('theme')
  writeFile(root, 'index.md', SAMPLE)
  const renderer = createShareRenderer()
  const out = await renderer.renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'paper',
    appearance: 'light',
    tokens: {},
  })
  assert.ok(out, '目录分享找不到落地页')
  assert.match(out.html, /<html[^>]*data-theme="paper"/, '主题 id 没写进 html')
  assert.match(out.html, /<html[^>]*data-appearance="light"/, '明暗基底没写进 html')
  /*
   * 页面里不能有 prefers-color-scheme 兜底：那会让「本机深色、访客浅色系统」
   * 的组合变成浅色，而这正是被报的那个现象。
   */
  assert.doesNotMatch(out.html, /prefers-color-scheme/, '分享页不该按访客系统配色')
})

test('插件主题的覆盖变量内联进页面', async () => {
  const root = tempDir('plugin-theme')
  writeFile(root, 'index.md', '# x')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'plugin-base-sea',
    appearance: 'dark',
    tokens: { '--dv-doc-accent': '#5cb3c9', '--dv-ui-accent': '#5cb3c9' },
  })
  assert.ok(out)
  assert.match(out.html, /data-theme="plugin-base-sea"/)
  assert.match(out.html, /--dv-doc-accent: #5cb3c9;/, '插件主题变量没进页面')
  assert.match(out.html, /--dv-ui-accent: #5cb3c9;/)
})

test('非法 token 不进入页面（防止主题变成任意 CSS 注入入口）', async () => {
  const root = tempDir('bad-token')
  writeFile(root, 'index.md', '# x')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {
      '--dv-doc-accent': '#fff',
      position: 'fixed; inset: 0',
      '--dv-evil': 'url(https://example.com/leak)',
    },
  })
  assert.ok(out)
  assert.match(out.html, /--dv-doc-accent: #fff;/, '合法 token 应保留')
  /*
   * 只检查**插件主题那一段** style：页面自己的样式里本来就有 `position: fixed`
   * （放大层），拿整页做否定断言会被自己的合法样式绊倒。
   */
  const tokenBlock = /:root\[data-theme='graphite'\]\s*\{([^}]*)\}/.exec(out.html)
  assert.ok(tokenBlock, '找不到插件主题的 token 块')
  assert.doesNotMatch(tokenBlock[1], /position/, '非 --dv-* 变量必须被丢弃')
  assert.doesNotMatch(tokenBlock[1], /example\.com/, 'url() 值必须被丢弃')
})

test('mermaid 占位块保持运行时约定', async () => {
  const root = tempDir('mermaid')
  writeFile(root, 'index.md', SAMPLE)
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  /*
   * 两个选择器都是硬契约：runtime 用 `pre.at-mermaid-src[data-mermaid]` 找块，
   * 改掉任何一个都会让图表退回源码（且控制台没有任何报错）。
   */
  assert.match(out.html, /<pre class="at-mermaid-src" data-mermaid>/, 'mermaid 占位块结构变了')
  assert.match(out.html, /flowchart LR/, '图源码应留在占位块里')
})

test('运行时脚本地址能被浏览器解析（绝对路径 + data-assets）', async () => {
  const root = tempDir('runtime')
  writeFile(root, 'index.md', '# x')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  assert.match(out.html, /data-assets="\/share-assets\/"/, '缺 data-assets，深层链接会解析错')
  assert.match(
    out.html,
    /<script type="module" src="\/share-assets\/runtime\.js">/,
    '运行时脚本必须是根绝对路径',
  )
})

test('下载链接与阅读共用路径归一：省略 .md 与目录落地页', async () => {
  const root = tempDir('download')
  writeFile(root, 'index.md', '# 首页')
  writeFile(root, '指南/index.md', '# 指南')
  const renderer = createShareRenderer()
  const share = shareOf(root, 'dir')

  // 目录 → 落地页
  assert.equal(renderer.resolveDocRel(share, ''), 'index.md')
  assert.equal(renderer.resolveDocRel(share, '指南'), '指南/index.md')
  // 省略扩展名
  assert.equal(renderer.resolveDocRel(share, '指南/index'), '指南/index.md')
  // 已带扩展名：原样
  assert.equal(renderer.resolveDocRel(share, 'index.md'), 'index.md')
  // 文件分享：只有一个目标，相对路径为空
  const fileShare = shareOf(join(root, 'index.md'), 'file')
  assert.equal(renderer.resolveDocRel(fileShare, ''), '')
})

test('下载链接出现在页面里，并指向当前文档', async () => {
  const root = tempDir('dl-link')
  writeFile(root, '指南/一篇.md', '# 一篇')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '指南/一篇', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  assert.match(
    out.html,
    /href="\/s\/a1b2c3d4e5f60718\/%E6%8C%87%E5%8D%97\/%E4%B8%80%E7%AF%87\.md\?download=1"/,
    '下载链接应指向归一后的源文件（全路径逐段编码，与阅读页同口径）',
  )
})

test('站内链接与图片都前缀化到分享路由', async () => {
  const root = tempDir('links')
  writeFile(root, '指南/一篇.md', '# 一篇\n\n[其它](./其它.md)\n\n![图](./a.png)\n')
  writeFile(root, '指南/其它.md', '# 其它')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '指南/一篇', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  /*
   * 编码口径：**全路径逐段编码**（目录段也要编码）。
   *
   * 这条踩过——渲染管线原本只编码链接目标那段，而 urlPrefix 是宿主拼的原文，
   * 于是同一页里正文链接与侧栏链接是两种形态，指向同一个文件却互相认不出。
   * 现在由 encodeRel 统一，正文、图片、侧栏、下载按钮四个入口逐字一致。
   */
  const dir = encodeURIComponent('指南')
  const other = encodeURIComponent('其它')
  assert.ok(
    out.html.includes(`href="/s/a1b2c3d4e5f60718/${dir}/${other}"`),
    '站内链接没按统一口径前缀化',
  )
  assert.ok(out.html.includes(`src="/s/a1b2c3d4e5f60718/${dir}/a.png"`), '图片没按统一口径前缀化')
  assert.ok(
    out.html.includes(`href="/s/a1b2c3d4e5f60718/${dir}/${other}.md"`),
    '侧栏与正文必须是同一套编码',
  )
})

test('导航只套一层 nav，子目录不产生嵌套容器', async () => {
  const root = tempDir('nav')
  writeFile(root, 'index.md', '# 首页')
  writeFile(root, '指南/进阶/一篇.md', '# 一篇')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  const opens = (out.html.match(/<nav class="share-nav">/g) ?? []).length
  const closes = (out.html.match(/<\/nav>/g) ?? []).length
  assert.equal(opens, 1, `侧栏应只有一个 nav 容器，实得 ${opens} 个`)
  assert.equal(closes, 1, 'nav 开闭要成对')
})

test('分享页不泄漏分享者的本机路径', async () => {
  const root = tempDir('leak')
  writeFile(root, 'index.md', '# x')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  assert.ok(!out.html.includes(root), `页面里出现了本机路径：${root}`)
})

test('分享页带图表放大层的样式', async () => {
  const root = tempDir('lightbox')
  writeFile(root, 'index.md', '# x')
  /*
   * baseCss 传占位样式：真实样式来自 theme.css / doc.css，那两份由
   * share-css.ts 在打包期注入，Node 单测里没有（`?raw` 是打包器语义）。
   * 这里只验证**页面自己提供**的放大层样式，以及 baseCss 被正确内联。
   */
  const out = await createShareRenderer(':root{--probe:1}').renderShareDoc(
    shareOf(root, 'dir'),
    '',
    { theme: 'graphite', appearance: 'dark', tokens: {} },
  )
  assert.ok(out)
  assert.match(out.html, /<style>:root\{--probe:1\}<\/style>/, 'baseCss 没被内联进页面')
  /*
   * 放大层的 DOM 由 share-runtime.js 在浏览器里建，但**样式必须由页面提供**
   * （运行时脚本不注入 <style>：那会让「页面长什么样」分散在两处）。
   * 缺任何一条都会让全屏是坏的一半。
   */
  assert.match(out.html, /\.share-lightbox\s*\{[^}]*position:\s*fixed/, '放大层必须铺满视口')
  assert.match(
    out.html,
    /\.share-lightbox__content\s*\{[^}]*width:\s*max-content/,
    '内容盒要按原尺寸排版，否则钉好的 SVG 宽度会被压缩',
  )
  assert.match(
    out.html,
    /\.share-lightbox__content svg\s*\{[^}]*max-width:\s*none/,
    '正文的 max-width 会把放大后的 SVG 压回去，必须显式解除',
  )
})

/*
 * CSP：分享页在**读者的普通浏览器**里打开，不享受 Electron 渲染进程那套策略。
 * 正文是用户 Markdown 经 `html: true` 渲染出来的，作者写下的 <script> /
 * onerror= / javascript: 链接默认都会执行。没有 CSP 时，一篇被分享的文档
 * 就能在同源下拿到脚本执行权——那等于拿到全部分享路径与 /share-assets/ 的读写面。
 */
test('分享页带 CSP，禁止内联脚本与事件属性', async () => {
  const root = tempDir('csp')
  writeFile(root, 'index.md', '# x')
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)

  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(out.html)
  assert.ok(meta, '分享页必须带 CSP meta')

  const policy = meta[1]
  assert.match(policy, /script-src 'self'/, '脚本只允许同源（拦内联 <script> 与 on* 属性）')
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/, '脚本绝不能放开 unsafe-inline')
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-eval'/, '脚本绝不能放开 unsafe-eval')
  assert.match(policy, /object-src 'none'/, '插件（object/embed）必须封死')
  assert.match(policy, /base-uri 'none'/, '<base> 劫持必须封死')
  /*
   * 样式必须允许内联：主题令牌与正文样式都以 <style> 内联下发，
   * 收紧到这里会让分享页完全失去配色。这条是**有意为之**，不是遗漏。
   */
  assert.match(policy, /style-src[^;]*'unsafe-inline'/, '内联样式是分享页的既定形态')
})

test('正文里的 <script> 不会被当作可执行内容（转义或留在不可执行位置）', async () => {
  const root = tempDir('inline-script')
  writeFile(
    root,
    'index.md',
    '# x\n\n<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned=2">\n',
  )
  const out = await createShareRenderer().renderShareDoc(shareOf(root, 'dir'), '', {
    theme: 'graphite',
    appearance: 'dark',
    tokens: {},
  })
  assert.ok(out)
  /*
   * `html: true` 会让这类标签原样进页面，所以**不能**断言「页面里没有这串字符」
   * ——那会与既定渲染策略冲突。真正拦住它的是上面那条 CSP：`script-src 'self'`
   * 下内联脚本不执行、on* 属性不执行。这里只钉住 CSP 存在且脚本面未放开。
   */
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(out.html)
  assert.ok(meta, '没有 CSP 时这类正文就是可执行的')
  assert.match(meta[1], /script-src 'self'/)
})
