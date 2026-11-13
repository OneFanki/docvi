/**
 * 导出产物的主题与资源契约。
 *
 * 这些不是「源码里有没有某字符串」的变更检测，而是导出必须守住的两条语义：
 *  1. **PDF 固定浅色、HTML 跟随文档主题**——深色 PDF 打印费墨，且常与阅读器
 *     深色 UI 叠成一片；HTML 是给人屏幕看的，就该保持他选的主题。
 *  2. **图片走原始字节（Blob）而不是 canvas 重绘**——canvas 会把 JPEG 转成
 *     PNG（体积翻几倍）、丢掉动图与 SVG 语义、跨源图还会 taint 画布。
 *
 * 第 1 条还有一条隐性依赖：离屏渲染必须在**目标主题作用域内**完成。主题选择器
 * 都写成 `:root[data-theme=…]`，所以只能临时改 documentElement；只给离屏容器
 * 加 data-theme 不会命中，mermaid 会把屏幕配色烘焙进产物。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const SOURCE = readFileSync(
  new URL('../apps/desktop/src/renderer/src/lib/export-doc.ts', import.meta.url),
  'utf8',
)

/* ---------- 主题口径 ---------- */

test('PDF 走 paper，HTML 跟随文档主题', () => {
  // 调用方在 App.vue 里决定；这里断言导出层的落点读的是 renderTheme
  assert.match(
    SOURCE,
    /data-theme="\$\{escapeHtml\(options\.renderTheme\)\}"/,
    '产物 <html data-theme> 必须来自 renderTheme，而不是另算一个',
  )
})

/* ---------- 页面底色 ---------- */

test('PDF 抹掉整页底色，HTML 保留主题底色', () => {
  /*
   * 两侧口径必须相反，理由也相反：
   *  - PDF 里那层米色纸面会和阅读器自己的背景叠成一块突兀的色块，深色阅读器
   *    尤其明显。抹掉后纸张颜色交给阅读器，内容色块（代码块/提示框/mermaid）
   *    仍保留——它们是语义色，不是页面装饰。
   *  - HTML 是独立文件，没有「阅读器背景」可继承，透明等于白底，
   *    反而丢掉用户选的主题外观。
   */
  const app = readFileSync(
    new URL('../apps/desktop/src/renderer/src/App.vue', import.meta.url),
    'utf8',
  )
  assert.match(app, /transparentPage:\s*format === 'pdf'/, '只有 PDF 该抹底色；HTML 透明等于丢主题')

  /* 补丁必须排在主题之后，否则 .doc-surface 的底色会把它盖回去 */
  const order = SOURCE.slice(
    SOURCE.indexOf('const styles = ['),
    SOURCE.indexOf('const styles = [') + 400,
  )
  const themeAt = order.indexOf('themeCss')
  const patchAt = order.indexOf('transparentPage ? TRANSPARENT_PAGE_CSS')
  assert.ok(themeAt >= 0 && patchAt > themeAt, '透明补丁必须排在主题 CSS 之后')

  /* 补丁要覆盖三层承载「页面本身」的元素，且不动内容元素 */
  const patch = /const TRANSPARENT_PAGE_CSS = `([^`]+)`/.exec(SOURCE)?.[1] ?? ''
  assert.ok(patch, '找不到 TRANSPARENT_PAGE_CSS')
  for (const selector of ['html', 'body', '.docvi-export']) {
    assert.ok(patch.includes(selector), `透明补丁要覆盖 ${selector}`)
  }
  assert.doesNotMatch(
    patch,
    /pre|code|blockquote|table|mermaid/,
    '内容色块必须保留，补丁不能把它们一起抹掉',
  )
})

test('离屏渲染临时切换 documentElement 主题并恢复', () => {
  assert.match(SOURCE, /root\.dataset\.theme = options\.renderTheme/, '渲染前必须切到目标主题')
  assert.match(SOURCE, /root\.dataset\.appearance = options\.renderAppearance/)
  assert.match(SOURCE, /restoreTheme\(\)/, '渲染完必须还回去')
  // 只给离屏容器加 data-theme 是不够的：主题档都写成 :root[...]
  assert.doesNotMatch(
    SOURCE,
    /host\.dataset\.theme\s*=/,
    '离屏容器上的 data-theme 不命中 :root 选择器，别用这种写法',
  )
})

test('主题恢复发生在 finally 里（渲染抛错也要还回去）', () => {
  const from = SOURCE.indexOf('await highlightPass')
  // 从渲染调用开始截到函数收尾（用下一个函数的声明做右界，避免撞上类型声明里的 dispose）
  const to = SOURCE.indexOf('/** 清理只对屏幕有意义的东西')
  assert.ok(from > 0 && to > from, '导出源码结构变了，请更新本测试的切片边界')
  const block = SOURCE.slice(from, to)
  assert.match(block, /finally\s*\{[\s\S]*?restoreTheme\(\)/, '恢复必须在 finally 中')
})

/* ---------- 图片内联 ---------- */

test('图片内联取原始字节，不用 canvas 重绘', () => {
  assert.match(SOURCE, /await fetch\(src\)/, '必须先试 fetch 原始字节')
  assert.match(SOURCE, /blobToDataUrl/, '必须按原始 MIME 转 data URL')
  // canvas 方案的三个损失见文件头注释；出现 toDataURL 就说明退回去了
  assert.doesNotMatch(
    SOURCE,
    /toDataURL\(/,
    '不能用 canvas.toDataURL 重绘（丢格式/涨体积/跨源 taint）',
  )
})

test('取不到字节时保留原地址而不是删掉图片', () => {
  assert.match(SOURCE, /if \(!response\.ok\) return/)
  // 失败分支只是 return（不改 src），不是 remove()
  const inlineBody = SOURCE.slice(SOURCE.indexOf('async function inlineImages'))
  assert.doesNotMatch(inlineBody.slice(0, 1200), /\.remove\(\)/, '失败不该删元素')
})

test('MIME 未知时不内联（避免 data:;base64 死链）', () => {
  assert.match(SOURCE, /if \(!mime\.startsWith\('image\/'\)\) return/)
})

/* ---------- 屏幕专用元素 ---------- */

test('导出产物剔除只对屏幕有意义的按钮', () => {
  const cleaner = SOURCE.slice(
    SOURCE.indexOf('function cleanClone'),
    SOURCE.indexOf('function materializeEmbeds'),
  )
  for (const selector of ['header-anchor', 'at-copy', 'at-htmlembed__open']) {
    assert.ok(cleaner.includes(`.${selector}`), `.${selector} 必须被清掉`)
  }
})

/* ---------- 界面入口 ---------- */

test('阅读视图每个实例都接上了导出的三种格式', () => {
  /*
   * 导出入口原先只存在于命令面板（Ctrl+K），界面上没有任何按钮——用户根本
   * 不知道有这功能。加了按钮之后，风险变成「新加的阅读视图实例忘了接线」：
   * 按钮渲染出来、点了却什么都不发生，且不报错。
   *
   * 所以检查的是**每个 <ReaderView> 都有 @export**，而不是「源码里出现过 @export」。
   */
  const app = readFileSync(
    new URL('../apps/desktop/src/renderer/src/App.vue', import.meta.url),
    'utf8',
  )
  const instances = app.split('<ReaderView').slice(1)
  assert.ok(instances.length >= 2, `预期至少两个阅读视图实例，实得 ${instances.length}`)
  for (const [index, chunk] of instances.entries()) {
    // 每个实例的属性区到下一个标签结束为止
    const body = chunk.slice(0, chunk.indexOf('/>') + 2)
    assert.match(body, /@export="exportDoc"/, `第 ${index + 1} 个 ReaderView 没接 @export`)
  }

  /* 视图侧：按钮存在、菜单里三种格式齐全、事件声明带 format 参数 */
  const reader = readFileSync(
    new URL('../apps/desktop/src/renderer/src/components/ReaderView.vue', import.meta.url),
    'utf8',
  )
  assert.match(reader, /export: \[format: 'markdown' \| 'html' \| 'pdf'\]/, '事件签名必须带格式')
  for (const key of ['reader.exportMarkdown', 'reader.exportHtml', 'reader.exportPdf']) {
    assert.ok(reader.includes(key), `菜单缺少 ${key}`)
  }
  assert.match(
    reader,
    /ContextMenu[\s\S]{0,400}@select="pickExport/,
    '下拉菜单必须接回 pickExport，否则点了没反应',
  )
})

test('只读宿主不显示导出入口', () => {
  /*
   * 容器读者面（`isReadOnlyHost`）没有主进程，导出要走 IPC 落盘——那里既没有
   * IPC 也不该让读者下载整站文档。按钮必须与分享按钮同样受这个条件约束。
   */
  const reader = readFileSync(
    new URL('../apps/desktop/src/renderer/src/components/ReaderView.vue', import.meta.url),
    'utf8',
  )
  const buttonAt = reader.indexOf('ref="exportButton"')
  assert.ok(buttonAt > 0, '找不到导出按钮')
  const before = reader.slice(Math.max(0, buttonAt - 300), buttonAt)
  assert.match(before, /v-if="!isReadOnlyHost"/, '导出按钮必须受 isReadOnlyHost 约束')
})

/* ---------- 打开所在文件夹 ---------- */

test('「打开所在文件夹」不接受路径参数（不给任意路径唤起能力）', () => {
  /*
   * 导出可以写到用户选的任意位置，所以「打开导出所在目录」天然会碰到绝对路径。
   * 但如果让渲染层把路径传上来，这条通道就变成通用的「唤起任意路径文件管理器」
   * 能力——渲染进程被 XSS 或恶意插件利用时，可以直接把用户引导到任意目录。
   *
   * 做法：主进程自己记住上次导出到哪，渲染层只能说「打开那个」。
   */
  const ipc = readFileSync(new URL('../packages/shared/src/ipc.ts', import.meta.url), 'utf8')
  assert.match(
    ipc,
    /docExportReveal\(\): Promise<Result<null>>/,
    'docExportReveal 必须无参数，否则等于开放任意路径唤起',
  )

  const main = readFileSync(new URL('../apps/desktop/src/main/ipc.ts', import.meta.url), 'utf8')
  /* 只取这一个 handler 的签名（到第一个 `{` 为止），避免带上后续 handler */
  const handlerAt = main.indexOf('ipcMain.handle(IPC.docExportReveal')
  assert.ok(handlerAt > 0, '找不到 docExportReveal 的 handler')
  const signature = main.slice(handlerAt, main.indexOf('{', handlerAt))
  assert.doesNotMatch(signature, /_event|absolutePath|path/, 'handler 不能收任何路径类参数')
  assert.match(signature, /async\s*\(\s*\)/, 'handler 必须无参')

  /* 主进程侧必须只认自己记录的那个路径 */
  const source = readFileSync(
    new URL('../apps/desktop/src/main/export-doc.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /let lastExportPath: string \| null = null/, '主进程要记录最近导出路径')
  assert.match(
    source,
    /if \(!lastExportPath\) throw new Error/,
    '没有导出记录时必须报错，不能回退成「打开当前目录」',
  )
})

test('导出成功后提示条带「打开所在文件夹」而非走错误通道', () => {
  /*
   * 原来导出成功用 store.setError：界面弹出红色感叹号、必须手动关，用户以为
   * 出错了。成功就该是成功提示，并且给一个能立刻用的下一步动作。
   */
  const app = readFileSync(
    new URL('../apps/desktop/src/renderer/src/App.vue', import.meta.url),
    'utf8',
  )
  const body = app.slice(app.indexOf('async function exportDoc'), app.indexOf('/* ---------- 导航'))
  assert.doesNotMatch(body, /store\.setError\(exportNotice/, '成功不该走错误通道')
  assert.match(body, /showNotice\(\s*exportNotice/, '成功要用 showNotice')
  assert.match(body, /t\('export\.revealInFolder'\)/, '提示条必须带打开文件夹的动作')
  assert.match(body, /docExportReveal\(\)/, '动作要调 reveal 通道')
})

test('提示条的时长足以读完路径再决定是否点击', () => {
  const app = readFileSync(
    new URL('../apps/desktop/src/renderer/src/App.vue', import.meta.url),
    'utf8',
  )
  assert.match(app, /durationMs = 3500/, '默认提示 3.5 秒')
  const body = app.slice(app.indexOf('async function exportDoc'), app.indexOf('/* ---------- 导航'))
  assert.match(body, /8000,/, '带操作的导出提示要延长到 8 秒')
})
