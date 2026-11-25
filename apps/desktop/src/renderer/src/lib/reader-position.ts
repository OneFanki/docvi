/**
 * 阅读位置恢复的策略选择（纯函数，可单测）。
 *
 * 切标签 / 换文档后要把「上次读到哪」放回去，有两个坐标系可用：
 *  - **源行**（`topLine`）：Markdown 原文的行号，与渲染后的高度无关，永远有效；
 *  - **像素**（`scrollY`）：准确的连续位置，但只在排版没变时成立。
 *
 * 这里的唯一职责是回答「这一次该信哪一个」。判据抽出来单测，是因为它出错的
 * 表现（切标签先回顶再闪回去）在真实应用里只能靠抓帧观察，而策略本身是纯算术。
 *
 * 三个关键事实，各自对应一条规则：
 *
 * 1. **早期落位必须用源行**。正文刚插进 DOM、高亮与图表还没跑时，文档高度仍在
 *    增长；此时把像素值赋给 scrollTop 会被上限截断，落到比目标更靠前的位置，
 *    等高度长出来也不会自己修正。
 * 2. **排版签名一致时像素更准**。块级源行定位只能定位到块的起点，在超高块
 *    （长表格、大图）内部会差几十像素。
 * 3. **源行必须是可信的**。老会话文件里 `topLine` 缺省为 0，照单全收会把文档
 *    滚到顶部并「成功返回」，压住像素兜底——这正是「切标签回顶」的成因。
 */

/** 恢复策略：按源行定位，或按像素定位 */
export type RestoreStrategy = 'source' | 'pixel'

export interface RestoreInput {
  /** 记录里的源行（Markdown 原文行号），-1 表示未知 */
  topLine: number
  /** 记录里的像素位置 */
  scrollY: number
  /** 记录时的排版签名；空串表示从未记录过 */
  layoutKey: string
  /** 当前排版签名 */
  currentLayoutKey: string
  /** 是否是「正文刚插入 DOM」的早期落位 */
  early: boolean
}

/** 记录的位置是否可信到能当主判据 */
export function positionTrustworthy(input: Pick<RestoreInput, 'topLine' | 'scrollY'>): boolean {
  if (input.topLine < 0) return false
  // topLine 为 0 时多疑一步：老会话把「不知道」也存成 0。
  // 只有像素也接近顶部时，0 才是真的「用户就在开头」。
  return input.topLine > 0 || input.scrollY < 40
}

/**
 * 选择这一次恢复该用哪个坐标系。
 *
 * 顺序不可交换：
 *  1. 早期落位 → 源行（高度未稳定，像素会被截断）；
 *  2. 排版签名一致且可信 → 像素（最准）；
 *  3. 其余 → 源行（排版变了，像素失效）；
 *  4. 源行不可信 → 像素兜底（此时没有更好的选择）。
 */
export function chooseRestoreStrategy(input: RestoreInput): RestoreStrategy {
  const trustworthy = positionTrustworthy(input)
  const layoutUnchanged = Boolean(input.layoutKey) && input.layoutKey === input.currentLayoutKey

  if (input.early) return trustworthy ? 'source' : 'pixel'
  if (layoutUnchanged && trustworthy) return 'pixel'
  if (trustworthy) return 'source'
  return 'pixel'
}
