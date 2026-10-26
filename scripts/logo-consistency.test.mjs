/**
 * 平台标识（logo）的一致性守卫。
 *
 * 品牌标在这个仓里有四个落点，历史上反复出现「改一处漏三处」：
 *  1. `scripts/lib/logo.mjs` —— 几何与配色的唯一源头；
 *  2. 脚本产出的 `icon.png/.ico/.icns`、`docs/assets/logo.svg`、`renderer/public/favicon.svg`；
 *  3. `TitleBar.vue` 里手写的界面内标记（渲染层不能 import 构建脚本）；
 *  4. `deployer/src/portal.mjs` 的运维页顶栏。
 *
 * 3 只能手写，所以这里断言它没有漂：坐标必须是 logo.mjs 里的那一组，
 * 配色必须是同一套 (琥珀底 / 石墨纸 / 奶油带)，而不是跟着主题变量走。
 *
 * 用户对这一版的具体要求：**黄色作为主题色 + 扁平化 + 多个文件叠加**。下面
 * 「黄色占主体」那条就是为这句话服务的——深底 + 一小块黄曾经做过一版，被否了。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BAND, FRONT, LOGO_COLORS, LOGO_MARK, LOGO_SVG, PAGE, STACK } from './lib/logo.mjs'

const titleBar = readFileSync(
  new URL('../apps/desktop/src/renderer/src/components/TitleBar.vue', import.meta.url),
  'utf8',
)

/** 从 TitleBar 模板里取内联 svg 片段 */
const svgBlock = /<svg[\s\S]*?class="titlebar__logo"[\s\S]*?<\/svg>/.exec(titleBar)?.[0] ?? ''

test('标题栏标记与 logo.mjs 共用同一组几何坐标', () => {
  assert.ok(svgBlock, '找不到标题栏里的 logo svg')
  for (const page of STACK) {
    assert.ok(
      svgBlock.includes(`x="${page.x}"`) && svgBlock.includes(`y="${page.y}"`),
      `标题栏缺少叠页坐标 x=${page.x} y=${page.y}`,
    )
  }
  assert.ok(
    svgBlock.includes(`width="${PAGE.w}"`) && svgBlock.includes(`height="${PAGE.h}"`),
    '标题栏叠页尺寸与 PAGE 不一致',
  )
  // 中心是 5.4 + 18.6/2 = 14.7，浮点算出来是 14.700000000000001，比对前先取整
  const cx = Number((FRONT.x + PAGE.w / 2).toFixed(2))
  const cy = Number((FRONT.y + PAGE.h / 2).toFixed(2))
  assert.ok(
    svgBlock.includes(`rotate(${BAND.angle} ${cx} ${cy})`),
    `斜带旋转中心与 logo.mjs 的 FRONT_CENTER 不一致（期望 ${BAND.angle} ${cx} ${cy}）`,
  )
})

test('标题栏标记用与图标相同的色值，不跟随主题变量', () => {
  const styles = titleBar.slice(titleBar.indexOf('<style scoped>'))
  assert.ok(styles.includes(`fill: ${LOGO_COLORS.page}`), '纸张必须是琥珀色')
  assert.ok(styles.includes(`fill: ${LOGO_COLORS.band}`), '斜带必须是深色')
  assert.ok(
    !/\.logo__page[^}]*var\(--dv-ui-/.test(styles) &&
      !/\.logo__band[^}]*var\(--dv-ui-/.test(styles),
    '品牌标不能跟着主题变量走——浅色主题下会变味',
  )
})

test('标题栏标记不带底板（深色方块在浅色主题下像黑补丁）', () => {
  assert.ok(!svgBlock.includes('logo__plate'), '标题栏不应画底板')
  assert.ok(!/class="logo__plate"/.test(titleBar), '底板样式与元素都应删除')
})

test('图标是深底 + 黄色文档，不是黄底深文档', () => {
  assert.match(
    LOGO_SVG,
    /<rect width="32" height="32" rx="8" fill="url\(#dv-bg\)"/,
    '底色块应铺满 32×32',
  )
  const stops = [...LOGO_SVG.matchAll(/stop-color="#([0-9a-f]{6})"/gi)].map(m => m[1])
  assert.ok(stops.length >= 2, '底色应有渐变')
  // 前两个 stop 是底色：必须是深石墨（亮度低），不能是黄
  for (const hex of stops.slice(0, 2)) {
    const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16))
    assert.ok(r < 90 && g < 90 && b < 90, `底色 ${hex} 必须是深色（用户要求深色背景）`)
  }
  // 纸张渐变（后两个 stop）必须是琥珀黄
  for (const hex of stops.slice(2, 4)) {
    const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16))
    assert.ok(r > 200 && r > g && g > b, `纸张 ${hex} 必须是琥珀黄（用户要求黄色图标）`)
  }
})

test('扁平化：没有投影、没有光晕', () => {
  assert.ok(!/<filter/.test(LOGO_SVG), '扁平图标不使用 filter')
  assert.ok(!/radialGradient/.test(LOGO_SVG), '不用径向光晕')
  assert.ok(!/feDropShadow/i.test(LOGO_SVG), '不用投影')
})

test('LOGO_MARK 与 LOGO_SVG 同色，自带 clipPath，且无底板', () => {
  assert.ok(LOGO_MARK.includes(LOGO_COLORS.page), '标记纸张色不一致')
  assert.ok(LOGO_MARK.includes(LOGO_COLORS.band), '标记斜带色不一致')
  assert.match(LOGO_MARK, /<clipPath id="dv-logo-clip">/, '标记必须自带 clipPath 才能独立内联')
  assert.ok(!LOGO_MARK.includes(LOGO_COLORS.plate), '界面内标记不应带底板')
})
