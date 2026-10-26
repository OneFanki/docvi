/**
 * 平台标识（logo）的唯一几何源头。
 *
 * 构图：「三张错位的文档页 + 一条贯穿页角的斜切强调带」。
 *
 * 用户对前两版的反馈很具体，都记在这里，避免再来一次：
 *  1. 「圆角方块 + 右下角组件块」——任何文档类工具都会自然想到，实测让另一个
 *     AI 写同类工具，产出一模一样，**必然撞车**；
 *  2. 纯「多个文件叠加」——用户自己也说这是通用图标，所以必须加装饰性差异。
 *
 * 所以这一版 = **多文件叠加（可辨识的语义）+ 一处非常规结构（避免通用）**：
 *
 *  - 叠加：三张纸向左上错位，只有最前一张完整——「叠」这个动作在 16px 下仍可读
 *    成多页，不是单个文件图标；
 *  - 差异化：前方那张纸的**右下角被一条 -34° 的斜切带切掉**，切口处露出一条
 *    底色缝，带子延伸到纸张之外、越过叠层边界。这条越界的斜带是整枚标里唯一
 *    「不合常理」的元素，也是它不会被认成通用文件图标的原因；
 *  - 醒目不靠细节：斜带是整枚标里饱和度最高的部分（琥珀），纸张近白，底为深石墨。
 *
 * 配色是**深底 + 黄色文档**（用户第二轮反馈：不要「黄底深纸」那种反过来的做法）：
 * 深石墨色方块托住三张琥珀色纸，斜切带用深色从纸里切过去。黄色集中在「文档」
 * 这个主体上而不是铺满整块画布——缩到 16px 是一枚黄纸图标，而不是一块黄方块。
 *
 * 没有字母、没有折角、没有「角落贴片」——这三种最容易撞车。
 *
 * 调用方（改这里必须同步，`node scripts/build-icons.mjs` 会重生成后两者）：
 *  - `scripts/build-icons.mjs`（应用图标 + docs/assets/logo.svg + renderer/public/favicon.svg）
 *  - `apps/desktop/src/renderer/src/components/TitleBar.vue`（无底板的标记，手写）
 *  - `deployer/src/portal.mjs` 的 `BRANDMARK`（运维页）
 */

/** 画布与背景 */
export const LOGO_BG_RADIUS = 8

/**
 * 三张纸：从后到前，每张向左上错开 `STEP`。
 *
 * 只画前两张的边缘（后两张被挡住大半），既省节点又让「叠」的层次更干净。
 */
export const PAGE = { w: 15.4, h: 18.6, r: 2.6 }
export const STACK = [
  { x: 10.4, y: 8.2 }, // 最底一张（只露右上角）
  { x: 8.6, y: 6.8 }, // 中间一张
  { x: 6.8, y: 5.4 }, // 最前一张（完整）
]
export const FRONT = STACK[2]

/**
 * 切角带：以最前一张纸的中心为原点旋转，从纸内扫到纸的边缘。
 *
 * `from` / `to` 是相对纸张中心的 x 偏移。`to` 取到纸张右缘（半宽 7.7）以内：
 * 让它**收在页内**，靠「把右下角切掉」这件事本身做记忆点。
 *
 * 试过让带子越出叠层：16px 下越出去的那截变成一个孤立黄点，比收在页内更糟；
 * 也试过让带子贯穿整页：两侧描边会让整枚标读成「禁止」符号。两个极端都记在这。
 *
 * `cy` 落在纸张下部、正文行之下：压在正文上会读成「橡皮擦擦掉一半字」。
 */
export const BAND = { angle: -34, h: 4.4, from: -9.4, to: 8.2, cy: 20.4 }
export const FRONT_CENTER = { x: FRONT.x + PAGE.w / 2, y: FRONT.y + PAGE.h / 2 }

const bandTop = BAND.cy - BAND.h / 2
const bandLeft = FRONT_CENTER.x + BAND.from
const bandWidth = BAND.to - BAND.from

/** 底两张纸的可见位移 */
const BACK1 = STACK[0]
const BACK2 = STACK[1]

/**
 * 彩色版（应用图标 / 运维页 / 文档 / favicon）。
 *
 * 深底 + 琥珀纸 + 深斜带。纸张只用 6% 的上下渐变把三张分开，不用投影与光晕——
 * 扁平化靠明度对比，不靠光影造层次。
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%" role="img" aria-label="docvi">
  <defs>
    <linearGradient id="dv-bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#2b2e35"/>
      <stop offset="1" stop-color="#16181d"/>
    </linearGradient>
    <linearGradient id="dv-page" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#f9cd72"/>
      <stop offset="1" stop-color="#e0a03d"/>
    </linearGradient>
    <clipPath id="dv-clip">
      <rect x="${FRONT.x}" y="${FRONT.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}"/>
    </clipPath>
  </defs>
  <rect width="32" height="32" rx="${LOGO_BG_RADIUS}" fill="url(#dv-bg)"/>
  <rect x="0.6" y="0.6" width="30.8" height="30.8" rx="${LOGO_BG_RADIUS - 0.55}" fill="none" stroke="#ffffff" stroke-opacity="0.09"/>
  <rect x="${BACK1.x}" y="${BACK1.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}" fill="#e8b055" fill-opacity="0.34"/>
  <rect x="${BACK2.x}" y="${BACK2.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}" fill="#e8b055" fill-opacity="0.62"/>
  <g clip-path="url(#dv-clip)">
    <rect x="${FRONT.x}" y="${FRONT.y}" width="${PAGE.w}" height="${PAGE.h}" fill="url(#dv-page)"/>
    <!-- 正文短线：32px 以上读得出「这是一页字」，16px 下自然消失，不糊剪影 -->
    <g fill="#3a2a0e" fill-opacity="0.42">
      <rect x="${FRONT.x + 2.8}" y="${FRONT.y + 3.2}" width="7.4" height="1.5" rx="0.75"/>
      <rect x="${FRONT.x + 2.8}" y="${FRONT.y + 6}" width="9.8" height="1.5" rx="0.75"/>
      <rect x="${FRONT.x + 2.8}" y="${FRONT.y + 8.8}" width="8.2" height="1.5" rx="0.75"/>
      <rect x="${FRONT.x + 2.8}" y="${FRONT.y + 11.6}" width="5.6" height="1.5" rx="0.75"/>
    </g>
    <g transform="rotate(${BAND.angle} ${FRONT_CENTER.x} ${FRONT_CENTER.y})">
      <rect x="${bandLeft}" y="${bandTop}" width="${bandWidth}" height="${BAND.h}" rx="${BAND.h / 2}" fill="#1b1d22"/>
    </g>
  </g>
</svg>`

/**
 * 标记的三个色值：琥珀纸 / 深斜带 / 深底板。
 *
 * 与 LOGO_SVG 里的一致。单独导出是为了让消费方（组件样式、运维页内联 CSS）
 * 不必从 SVG 字符串里反读色值。
 */
export const LOGO_COLORS = { page: '#eeb254', band: '#1b1d22', plate: '#23262c' }

/**
 * 界面内标记（标题栏 / 运维页顶栏）：**不带底板**，只留三张琥珀纸与深色斜带。
 *
 * 用户明确要求标题栏不要底板——深色方块贴在浅色主题的标题栏上像一个黑补丁。
 * 去掉底板后黄色在深浅主题上都成立，斜带保持深色，视觉语言与应用图标一致。
 *
 * 颜色写死而不是用 `currentColor`：品牌标记在任何主题下都应是同一组颜色，
 * 跟着主题走会让它在浅色主题里变成黑纸。
 *
 * 用 `<svg viewBox="0 0 32 32">` 包住这段片段即可；clipPath 的 id 固定，
 * 同页出现两个标记时后面的会复用前面的定义（几何相同，结果一致）。
 */
export const LOGO_MARK =
  `<rect x="${BACK1.x}" y="${BACK1.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}" fill="${LOGO_COLORS.page}" fill-opacity="0.34"/>` +
  `<rect x="${BACK2.x}" y="${BACK2.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}" fill="${LOGO_COLORS.page}" fill-opacity="0.62"/>` +
  `<g clip-path="url(#dv-logo-clip)">` +
  `<rect x="${FRONT.x}" y="${FRONT.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}" fill="${LOGO_COLORS.page}"/>` +
  `<g transform="rotate(${BAND.angle} ${FRONT_CENTER.x} ${FRONT_CENTER.y})">` +
  `<rect x="${bandLeft}" y="${bandTop}" width="${bandWidth}" height="${BAND.h}" rx="${BAND.h / 2}" fill="${LOGO_COLORS.band}"/>` +
  `</g></g>` +
  `<clipPath id="dv-logo-clip"><rect x="${FRONT.x}" y="${FRONT.y}" width="${PAGE.w}" height="${PAGE.h}" rx="${PAGE.r}"/></clipPath>`
