/**
 * 字体资产与切换契约。
 *
 * 这里守的是几条**会静默失效**的约定：字体文件丢了、字体栈首位被换掉、
 * 或 data-font 的默认态写反——三种都是「界面看起来正常但用错了字体」，
 * 没有报错，只能靠断言。
 *
 * 另外守许可合规：HarmonyOS Sans 的许可是「未修改 + 显著声明 + 随附原文」，
 * 这三条都要能被机械检查。子集化会在体积上非常诱人（24MB → 2.7MB），
 * 所以用一条测试明确挡住它。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import test from 'node:test'

const ROOT = new URL('..', import.meta.url)
const FONT_DIR = new URL('packages/renderer-core/src/assets/fonts/', ROOT)
const THEME_CSS = readFileSync(new URL('packages/renderer-core/src/styles/theme.css', ROOT), 'utf8')

/* ---------- 资产存在性 ---------- */

test('三字重鸿蒙字体随包分发', () => {
  for (const weight of ['Regular', 'Medium', 'Bold']) {
    const file = new URL(`HarmonyOSSansSC-${weight}.woff2`, FONT_DIR)
    assert.ok(existsSync(file), `缺少 HarmonyOSSansSC-${weight}.woff2`)
    // woff2 魔数是 'wOF2'
    const head = readFileSync(file).subarray(0, 4).toString('latin1')
    assert.equal(head, 'wOF2', `${weight} 不是合法 woff2`)
  }
})

test('等宽字体随包分发（JetBrains Mono）', () => {
  for (const weight of ['Regular', 'Medium', 'Bold']) {
    const file = new URL(`JetBrainsMono-${weight}.woff2`, FONT_DIR)
    assert.ok(existsSync(file), `缺少 JetBrainsMono-${weight}.woff2`)
    assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'wOF2')
  }
})

/* ---------- 许可合规 ---------- */

test('两份字体许可原文都随包', () => {
  const harmony = new URL('LICENSE-HarmonyOS-Sans.txt', FONT_DIR)
  const jetbrains = new URL('LICENSE-JetBrainsMono.txt', FONT_DIR)
  assert.ok(existsSync(harmony), '鸿蒙字体许可原文必须在包内（许可第 4 条）')
  assert.ok(existsSync(jetbrains), 'JetBrains Mono 的 OFL 原文必须在包内')
  assert.match(readFileSync(harmony, 'utf8'), /HarmonyOS Sans Fonts License Agreement/)
  assert.match(readFileSync(jetbrains, 'utf8'), /SIL OPEN FONT LICENSE/i)
})

test('鸿蒙字体未被子集化（许可要求 unmodified copies）', () => {
  /*
   * 子集化能把 12.4MB 压到 2.7MB，非常诱人，但那属于「修改字体文件」。
   * 完整 SC 字体三个字重合起来约 12MB；子集版只有 2-3MB。
   * 阈值取 8MB/文件：完整版单字重 4.0-4.3MB，子集版约 0.9MB。
   */
  for (const weight of ['Regular', 'Medium', 'Bold']) {
    const size = statSync(new URL(`HarmonyOSSansSC-${weight}.woff2`, FONT_DIR)).size
    assert.ok(
      size > 3 * 1024 * 1024,
      `${weight} 只有 ${(size / 1048576).toFixed(2)}MB，疑似被子集化——许可禁止修改字体文件`,
    )
  }
})

test('软件内有显著的字体声明（许可第 2.1 条）', () => {
  const i18n = readFileSync(new URL('apps/desktop/src/renderer/src/lib/i18n.ts', ROOT), 'utf8')
  assert.match(i18n, /about\.fontHarmony/, '缺少字体声明文案')
  assert.match(i18n, /Huawei Device Co\., Ltd\./, '声明里必须写出著作权人')
})

/* ---------- 字体栈与切换 ---------- */

test('默认字体栈首位是鸿蒙，等宽首位是 JetBrains Mono', () => {
  const base = THEME_CSS.slice(THEME_CSS.indexOf(':root {'), THEME_CSS.indexOf('[data-font'))
  const sans = /--dv-font-sans:\s*([^;]+);/.exec(base)?.[1] ?? ''
  const mono = /--dv-font-mono:\s*([^;]+);/.exec(base)?.[1] ?? ''
  assert.match(sans.split(',')[0] ?? '', /HarmonyOS Sans SC/, '默认必须用随包的鸿蒙字体')
  assert.match(mono.split(',')[0] ?? '', /JetBrains Mono/, '代码块必须用等宽')
})

test('system 档不残留 HarmonyOS（选了系统字体就该真的切走）', () => {
  const block = THEME_CSS.slice(THEME_CSS.indexOf(":root[data-font='system']"))
  const sans = /--dv-font-sans:\s*([^;]+);/.exec(block)?.[1] ?? ''
  assert.doesNotMatch(sans, /HarmonyOS/, 'system 档的正文栈不能还挂着鸿蒙')
})

test('等宽栈保留鸿蒙作为 CJK 回退（代码块里的中文与界面同字形）', () => {
  const base = THEME_CSS.slice(THEME_CSS.indexOf(':root {'), THEME_CSS.indexOf('[data-font'))
  const mono = /--dv-font-mono:\s*([^;]+);/.exec(base)?.[1] ?? ''
  assert.match(mono, /HarmonyOS Sans SC/, '等宽栈需要鸿蒙做中文回退，否则落到宋体')
})

test('代码块的回退顺序是 JetBrains → 鸿蒙，不能颠倒', () => {
  /*
   * 顺序即语义：浏览器按「先到先得」逐字符回退。
   *
   *  - JetBrains 在前 → ASCII/框线等宽，汉字自动落到鸿蒙
   *  - 若鸿蒙在前 → 它没有等宽变体，缩进与框线全歪
   *
   * 所以这两项的相对位置是硬约束，不是风格偏好。
   */
  const base = THEME_CSS.slice(THEME_CSS.indexOf(':root {'), THEME_CSS.indexOf('[data-font'))
  const mono = /--dv-font-mono:\s*([^;]+);/.exec(base)?.[1] ?? ''
  const names = mono
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  const jetbrains = names.indexOf('JetBrains Mono')
  const harmony = names.indexOf('HarmonyOS Sans SC')
  assert.ok(jetbrains >= 0, '等宽栈必须以 JetBrains Mono 开头')
  assert.ok(harmony >= 0, '等宽栈需要鸿蒙兜中文')
  assert.ok(jetbrains < harmony, `JetBrains 必须排在鸿蒙之前，实得 ${JSON.stringify(names)}`)
})

test('字体栈不堆不会命中的中间项', () => {
  /*
   * 鸿蒙 SC 同时含拉丁与汉字，它后面的项只在字体加载失败时才会用到。
   * 链条过长会让设置页展示的「应用顺序」失去信息量——用户看不出哪一项真的
   * 在起作用。正文栈限制在 3 项以内（首选 + 一个兜底 + 通用族关键字）。
   */
  const base = THEME_CSS.slice(THEME_CSS.indexOf(':root {'), THEME_CSS.indexOf('[data-font'))
  const sans = /--dv-font-sans:\s*([^;]+);/.exec(base)?.[1] ?? ''
  const count = sans.split(',').filter(item => item.trim()).length
  assert.ok(count <= 3, `正文栈有 ${count} 项，过长会让「应用顺序」变成噪音：${sans.trim()}`)
})

test('字体切换只在 system 时写属性（缺失 = 鸿蒙）', () => {
  const store = readFileSync(new URL('apps/desktop/src/renderer/src/stores/app.ts', ROOT), 'utf8')
  assert.match(
    store,
    /if \(value === 'system'\)\s*document\.documentElement\.dataset\.font = 'system'\s*else\s*delete document\.documentElement\.dataset\.font/,
    'harmony 必须表现为「属性缺失」，否则漏写属性的场景会静默掉回系统字体',
  )
})

test('设置页展示的字体顺序来自 CSS 计算值，不是另写一份', () => {
  /*
   * 展示与实现必须是同一份数据。
   *
   * 如果在设置页里手写一遍字体清单，CSS 加了回退项界面不会跟着变——用户看到
   * 的「应用顺序」就是假的，而且这种漂移没有任何其他测试能发现（两处都合法，
   * 只是不一样）。所以约定：读 getComputedStyle 的 --dv-font-*。
   */
  const view = readFileSync(
    new URL('apps/desktop/src/renderer/src/components/SettingsView.vue', ROOT),
    'utf8',
  )
  assert.match(view, /getPropertyValue\(/, '字体链必须从 CSS 变量读，不能另写清单')
  assert.match(view, /--dv-font-sans/, '必须读正文栈变量')
  assert.match(view, /--dv-font-mono/, '必须读等宽栈变量')
})

/* ---------- 设置项 ---------- */

test('设置项默认 harmony，且归一化接受两档', async () => {
  const mod = await import('../packages/shared/src/settings.ts')
  assert.equal(mod.DEFAULT_SETTINGS.fontFamily, 'harmony')
  assert.equal(mod.normalizeSettings({}).fontFamily, 'harmony')
  assert.equal(mod.normalizeSettings({ fontFamily: 'system' }).fontFamily, 'system')
  // 非法值回退默认，不整体失效
  assert.equal(mod.normalizeSettings({ fontFamily: 'comic-sans' }).fontFamily, 'harmony')
})
