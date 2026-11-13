#!/usr/bin/env node
/**
 * 检查导出的 PDF 页面有没有整页底色填充。
 *
 * 为什么不能用截图判断：Chromium 的 PDF 阅读器给透明页显示的也是白底，
 * 「看起来白色」既可能是「页面透明、阅读器给白」，也可能是「页面填了白色」。
 * 两者在验收上完全不同——后者在深色阅读器里会变成刺眼的白块。
 *
 * 所以直接解压 PDF 内容流，找有没有覆盖整个 MediaBox 的填充矩形。
 * 判据：页面上必须有内容绘制（文字、代码块底色），但**不能有**与 MediaBox
 * 等大的矩形填充。
 *
 * 用法：node scripts/dev/probe-pdf-page-bg.mjs <pdf 路径>
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/dev/probe-pdf-page-bg.mjs <pdf>')
  process.exit(1)
}

const buffer = readFileSync(file)
const latin = buffer.toString('latin1')
const log = (...args) => console.log('[pdf-bg]', ...args)

/* ---------- 取页面尺寸 ---------- */

const boxes = []
for (const match of latin.matchAll(/\/MediaBox\s*\[\s*([\d.\s-]+)\]/g)) {
  const nums = match[1].trim().split(/\s+/).map(Number)
  if (nums.length === 4) {
    boxes.push({ width: Math.abs(nums[2] - nums[0]), height: Math.abs(nums[3] - nums[1]) })
  }
}
if (!boxes.length) throw new Error('找不到 MediaBox')
// 取最常见的尺寸（不同页面可能因旋转不同，但同一份产物是一致的）
const page = boxes[0]
log(
  `页面尺寸: ${page.width.toFixed(1)} × ${page.height.toFixed(1)} pt（共 ${boxes.length} 个 MediaBox）`,
)

/* ---------- 按 /Contents 引用定位页面绘制流 ---------- */

/*
 * 不能「解压所有 stream 再挑大的」：最大的那个是内嵌字体（HarmonyOS 的
 * glyf 表动辄几百 KB），不是页面绘制指令。必须顺着页面对象的 /Contents
 * 引用去找，才对准真正画内容的那个流。
 */
const objects = new Map()
for (const found of latin.matchAll(/(\d+)\s+0\s+obj\b/g)) {
  objects.set(Number(found[1]), found.index)
}

function streamOf(num) {
  const at = objects.get(num)
  if (at === undefined) return null
  const streamAt = latin.indexOf('stream', at)
  if (streamAt < 0) return null
  const start = latin.indexOf('\n', streamAt) + 1
  const end = latin.indexOf('endstream', start)
  if (end < 0) return null
  try {
    return inflateSync(buffer.subarray(start, end)).toString('latin1')
  } catch {
    return null
  }
}

/*
 * 找「被填充的路径」的包围盒。
 *
 * ⚠️ 三个都踩过：
 *  1. 必须区分裁剪与填色。Chromium 用大矩形做裁剪路径（`re` + `W n`），
 *     不产生像素；只看尺寸会把裁剪误判成整页填色。
 *  2. 填充不一定是 `re`。圆角卡片、列表圆点都是曲线路径
 *     （`m` / `l` / `c` / `h` + `f`），只认 `re` 会漏掉内容色块。
 *  3. **不能把 `cm` 的参数当坐标**。坐标变换矩阵形如 `3.125 0 0 3.125 x y cm`，
 *     参数对长得和 `x y` 一模一样。混进包围盒后，一个 720×83 的代码块会被算成
 *     2359×3212，凭空长出「整页填充」。所以先删掉所有 cm 行再解析，
 *     且只认带明确绘图操作符（m / l / c / re）的坐标组。
 */
function fillBounds(stream) {
  const found = []
  /*
   * 先按裁剪操作（`W n` / `W* n`）切断。
   *
   * 为什么必须先切这一刀：一段流里常有 `re W* n ... 曲线路径 ... f`，按 f 分组
   * 会把裁剪矩形和真正的填充路径算进同一段，包围盒立刻膨胀成整页——第一版
   * 探针就是这么把「页面真的透明」误判成「还有底色」的。
   */
  const segments = stream.split(/\bW\*?\s+n\b/)
  for (const segment of segments) {
    const parts = segment.split(/\b(f\*?)\b/)
    for (let index = 0; index < parts.length - 1; index += 2) {
      /* 去掉 cm 行：它的六个参数不是路径点 */
      const path = (parts[index] ?? '').replace(/[\d.-\s]+cm\b/g, '')
      const points = []
      /* m / l：坐标后紧跟操作符，这是唯一可靠的「这是点」的信号 */
      for (const nums of path.matchAll(/([\d.-]+)\s+([\d.-]+)\s+[ml]\b/g)) {
        points.push([Number(nums[1]), Number(nums[2])])
      }
      /* c：六参数曲线，末两点是终点（控制点可能外扩，但对整页判定无害） */
      for (const curve of path.matchAll(
        /([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+c\b/g,
      )) {
        points.push([Number(curve[5]), Number(curve[6])])
      }
      /* re：矩形以起点 + 宽高描述 */
      for (const rect of path.matchAll(/([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+re\b/g)) {
        const x = Number(rect[1])
        const y = Number(rect[2])
        points.push([x, y], [x + Number(rect[3]), y + Number(rect[4])])
      }
      if (!points.length) continue
      const xs = points.map(point => point[0])
      const ys = points.map(point => point[1])
      found.push({
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        filled: true,
      })
    }
  }
  return found
}

const contents = []
for (const ref of latin.matchAll(/\/Type\s*\/Page\b[\s\S]{0,800}?\/Contents\s+(\d+)\s+0\s+R/g)) {
  const stream = streamOf(Number(ref[1]))
  if (stream) contents.push(stream)
}
log(`页面内容流: ${contents.length} 个`)

/*
 * 页面流只画文字与结构，卡片/代码块的底色画在它引用的 **XObject Form** 里。
 * 不把 XObject 一起查，「内容填充」对照组的计数就会是 0——那样即使页面上
 * 真有整页底色也发现不了（判定基础不成立）。
 *
 * 这里把所有 Form XObject 都纳入：它们坐标空间被 cm 变换过，尺寸对不上
 * MediaBox，所以整页填充只可能在页面流里被判出来；XObject 只用来做对照组。
 */
const xobjects = []
for (const num of objects.keys()) {
  const stream = streamOf(num)
  /* 有文字绘制的流才是内容流；字体程序、图片二进制里没有 BT/ET 配对 */
  if (stream && /\bBT\b[\s\S]*?\bET\b/.test(stream) && !contents.includes(stream)) {
    xobjects.push(stream)
  }
}
log(`XObject 内容流: ${new Set(xobjects).size} 个`)

/*
 * 整页填充只可能在页面流里。判据用「在内容流自己的坐标空间里比较」，不直接
 * 比 MediaBox：Chromium 会先写一条 `cm` 把页面缩放进内容空间（实测 0.24 或
 * 3.125 两种），裸坐标与 pt 差着一个倍数，直接比必然对不上。
 *
 * 参照物取该流里最大的**裁剪矩形**——那正是「可绘制页面区域」，Chromium 每次
 * 都以它限界。底色若是整页，它的填充包围盒会与之相当。
 */
function clipArea(stream) {
  let best = null
  for (const match of stream.matchAll(
    /([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+re\s+W\*?\s+n/g,
  )) {
    const width = Math.abs(Number(match[3]))
    const height = Math.abs(Number(match[4]))
    if (!best || width * height > best.width * best.height) best = { width, height }
  }
  return best
}

const fullPageFills = []
for (const [index, stream] of contents.entries()) {
  const area = clipArea(stream)
  if (!area) continue
  for (const bounds of fillBounds(stream)) {
    /* 覆盖率 ≥ 90% 就是整页底色；内容色块（卡片、代码块）远小于此 */
    if (bounds.width >= area.width * 0.9 && bounds.height >= area.height * 0.9) {
      fullPageFills.push({ stream: index, rect: `${bounds.width}×${bounds.height}` })
    }
  }
}

/*
 * 对照组：内容区必须有**填充**（代码块、提示框、分隔线、列表圆点），否则
 * 「没找到整页填充」可能只是解析根本没读到绘制指令。页面流与 XObject 一起数。
 * 高度阈值取 0.5：分隔线只有 1 单位高，再大就漏了。
 */
const contentFills = [...contents, ...xobjects].flatMap(stream =>
  fillBounds(stream).filter(bounds => bounds.width > 2 && bounds.height > 0.5),
)
const hasText = contents.some(stream => /\bBT\b[\s\S]*?\bET\b/.test(stream))

log(
  `对照组 内容填充: ${contentFills.length} 处${contentFills.length ? `（如 ${contentFills[0].width}×${contentFills[0].height}）` : ''}`,
)
log(`对照组 文字绘制: ${hasText ? '有' : '无'}`)
log(`与页面等大的填充矩形: ${fullPageFills.length} 个`)

const bad = []
if (!contentFills.length) bad.push('内容流里没有任何内容填充，判定不可信')
if (!hasText) bad.push('内容流里没有文字绘制，判定不可信')
if (fullPageFills.length) {
  bad.push(`有 ${fullPageFills.length} 处整页填充，页面仍有底色（例：${fullPageFills[0].rect}）`)
}

if (bad.length) {
  log('❗ 结论:', bad.join('；'))
  process.exitCode = 1
} else {
  log('✓ 结论: 页面无整页底色填充，内容色块照常保留')
}
