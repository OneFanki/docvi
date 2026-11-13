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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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

test('界面不硬编码字体栈（唯一来源是 CSS 变量）', () => {
  /*
   * base.css 里曾经写死一份 `Inter → Segoe UI Variable Text → …`，与 theme.css
   * 的 --dv-font-sans 并存。两份都在时 body 的直接声明赢过变量，于是**换字体
   * 设置完全不生效**——变量改了，body 读的是写死那份。CSS 变量本身完全正确，
   * 症状只是「改了但界面毫无变化」，极难发现。
   *
   * 判据：样式文件里出现 font-family 时，值必须是 var(...) 或 inherit。
   */
  const offenders = []
  const roots = [
    new URL('apps/desktop/src/renderer/src/styles/', ROOT),
    new URL('packages/renderer-core/src/styles/', ROOT),
  ]
  for (const dir of roots) {
    let names = []
    try {
      names = readdirSync(dir).filter(name => name.endsWith('.css'))
    } catch {
      continue
    }
    for (const name of names) {
      const css = readFileSync(new URL(name, dir), 'utf8')
      /*
       * 只扫**声明**，不扫注释：
       *  - `@font-face` 块里的 font-family 是字体定义本身，跳过；
       *  - 注释里会提到 `font-family: monospace` 这类示例，必须剥掉，
       *    否则测试被自己的解释文字绊倒。
       */
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
      const withoutFaces = withoutComments.replace(/@font-face\s*\{[^}]*\}/g, '')
      for (const match of withoutFaces.matchAll(/font-family:\s*([^;]+);/g)) {
        const value = match[1].trim()
        if (/^var\(--|^inherit/.test(value)) continue
        offenders.push(`${name}: font-family: ${value.slice(0, 60)}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `样式里硬编码了字体栈，会让 --dv-font-* 失效：\n${offenders.join('\n')}`,
  )
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

test('字体链的角色标注按字体能力给，不按位次猜', () => {
  /*
   * 早先按「是不是等宽栈 + 是不是 JetBrains」推角色，结果 `JetBrains Mono`
   * 在正文栈里被标成「中文回退」——它一个汉字都没有，说明与事实相反。
   * 角色只能来自「这个字体有没有这些字形」的固定映射。
   */
  const view = readFileSync(
    new URL('apps/desktop/src/renderer/src/components/SettingsView.vue', ROOT),
    'utf8',
  )
  const fn = /function chainRole\(([^)]*)\)[\s\S]*?\n\}/.exec(view)?.[0] ?? ''
  assert.ok(fn, '找不到 chainRole')
  assert.doesNotMatch(fn, /kind/, '角色判定不能收 kind 参数——按栈的类别决定角色就是把位次当能力')
  assert.match(
    view,
    /'JetBrains Mono':\s*'settings\.fontRoleLatinMono'/,
    '等宽字体必须标为英文等宽',
  )
  assert.match(
    view,
    /'HarmonyOS Sans SC':\s*'settings\.fontRoleAll'/,
    '鸿蒙同时覆盖中英文，必须标为「中文 + 英文」',
  )
})

/* ---------- 英数等宽 ---------- */

test('英数等宽默认开启，且缺失字段按开启处理', async () => {
  /*
   * 「缺失 = 开启」是这条设置的核心，不是随手写的容错：
   * 全新安装、旧版设置文件没有这个键、导出产物没写属性——三种场景都必须落在
   * 开启上。若写成 `record.monoLatin === true`，任何漏写都会静默关掉它，
   * 而用户看到的只是「界面英文忽然变宽了」，不会想到是设置丢了。
   */
  const mod = await import('../packages/shared/src/settings.ts')
  assert.equal(mod.DEFAULT_SETTINGS.monoLatin, true)
  assert.equal(mod.normalizeSettings({}).monoLatin, true)
  assert.equal(mod.normalizeSettings({ monoLatin: undefined }).monoLatin, true)
  assert.equal(mod.normalizeSettings({ monoLatin: false }).monoLatin, false)
  assert.equal(mod.normalizeSettings({ monoLatin: true }).monoLatin, true)
})

test('英数等宽的 CSS 覆盖排在 system 档之后（否则被它盖掉）', () => {
  /*
   * 两条规则特异性相同（都是 :root 加一个属性选择器），谁在后面谁生效。
   * system 档写的是系统字体栈，若它排在等宽覆盖之后，选「系统字体 + 英数等宽」
   * 时英文会回到 Segoe UI——用户看到的是「开关点了没反应」。
   */
  const systemAt = THEME_CSS.indexOf(":root[data-font='system'] {")
  const monoAt = THEME_CSS.indexOf(":root:not([data-mono-latin='off']) {")
  assert.ok(systemAt > 0, '找不到 system 档')
  assert.ok(monoAt > 0, '找不到英数等宽覆盖')
  assert.ok(
    monoAt > systemAt,
    `英数等宽覆盖必须在 system 档之后，实得 system@${systemAt} > mono@${monoAt}`,
  )
})

test('英数等宽把 JetBrains 放正文栈首位，汉字仍由鸿蒙兜', () => {
  const block = THEME_CSS.slice(THEME_CSS.indexOf(":root:not([data-mono-latin='off']) {"))
  const sans = /--dv-font-sans:\s*([^;]+);/.exec(block)?.[1] ?? ''
  const names = sans
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  assert.equal(names[0], 'JetBrains Mono', `首位必须是等宽，实得 ${JSON.stringify(names)}`)
  assert.ok(names.includes('HarmonyOS Sans SC'), `汉字需要鸿蒙兜底，实得 ${JSON.stringify(names)}`)
})

test('英数等宽的正文栈不挂永远命不中的项', () => {
  /*
   * `HarmonyOS Sans SC` 已同时含拉丁与汉字，它后面除通用族关键字外的任何字体
   * 都命中不到。早先这条栈是 4 项，中间夹着 `Segoe UI`——英文被 JetBrains
   * 拿走、汉字被鸿蒙拿走，它一次都不会被选中，却让设置页的「应用顺序」多出
   * 一个假的层级。
   */
  const block = THEME_CSS.slice(THEME_CSS.indexOf(":root:not([data-mono-latin='off']) {"))
  const sans = /--dv-font-sans:\s*([^;]+);/.exec(block)?.[1] ?? ''
  const names = sans
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  assert.deepEqual(
    names,
    ['JetBrains Mono', 'HarmonyOS Sans SC', 'sans-serif'],
    `鸿蒙之后不该再有具体字体（永远命不中），实得 ${JSON.stringify(names)}`,
  )
})

test('system 档 + 英数等宽不残留 HarmonyOS', () => {
  const block = THEME_CSS.slice(
    THEME_CSS.indexOf(":root[data-font='system']:not([data-mono-latin='off'])"),
  )
  const sans = /--dv-font-sans:\s*([^;]+);/.exec(block)?.[1] ?? ''
  assert.equal(
    sans
      .split(',')[0]
      .trim()
      .replace(/^['"]|['"]$/g, ''),
    'JetBrains Mono',
    'system 档下也应以等宽开头',
  )
  assert.doesNotMatch(sans, /HarmonyOS/, `system 档下不该再挂鸿蒙：${sans.trim()}`)
})

test('关闭英数等宽时删属性，不写 false（缺失才等于默认开启）', () => {
  const store = readFileSync(new URL('apps/desktop/src/renderer/src/stores/app.ts', ROOT), 'utf8')
  assert.match(
    store,
    /if \(value\)\s*delete document\.documentElement\.dataset\.monoLatin\s*else\s*document\.documentElement\.dataset\.monoLatin = 'off'/,
    '开启态必须表现为属性缺失，写 data-mono-latin="1" 会让漏写属性掉回关闭',
  )
})

test('导出产物只在关闭时写 data-mono-latin', () => {
  /*
   * 导出文件是独立文档，没有应用的 store，只能靠 <html> 属性表达这个设置。
   * 只在关闭时写出，是因为属性缺失就是开启（与应用内一致）——两边口径一旦
   * 不一致，就会出现「应用里是等宽、导出的 HTML 不是」这种无报错的错位。
   */
  const source = readFileSync(
    new URL('apps/desktop/src/renderer/src/lib/export-doc.ts', ROOT),
    'utf8',
  )
  assert.match(
    source,
    /renderMonoLatin \? '' : ' data-mono-latin="off"'/,
    '导出产物必须只在关闭时写属性',
  )
  assert.match(source, /renderMonoLatin:/, '导出选项必须带上该设置')
})
