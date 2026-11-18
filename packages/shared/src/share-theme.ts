/**
 * 分享页的主题快照。
 *
 * 分享页由服务进程直出（不走渲染进程），拿不到 `<html>` 上的主题属性；而它
 * 又必须长得跟分享者本机一样——「本机选的深色，同事打开是白的」是最直接的
 * 不信任感来源。所以主进程把当前主题整理成这份纯数据快照推给服务进程，
 * 服务进程原样写进分享页的 `<html>` 属性，theme.css 的变量照旧生效。
 *
 * 只放数据与净化规则：渲染进程读它算 DOM 属性，主进程读它算分享快照，
 * 服务进程读它拼页面。三处共用一份，避免「本机能选、分享页不认」的漂移。
 */

/** 内置主题的明暗。插件主题的明暗写在插件清单里，不在这张表内。 */
export const BUILTIN_APPEARANCE: Record<string, 'light' | 'dark'> = {
  graphite: 'dark',
  paper: 'light',
  slate: 'dark',
  mist: 'light',
}

/**
 * 插件主题在宿主的 id：`plugin-<插件名>-<主题 id>`。
 *
 * 加前缀是为了不与内置主题撞名（插件作者取 `paper` 也不能覆盖内置纸张）。
 * 规则只有这一处：渲染进程注入 `:root[data-theme='…']` 时用它，主进程给
 * 分享页算主题快照时也用它，两边拼法必须一致。
 */
export function pluginThemeId(plugin: string, themeId: string): string {
  return `plugin-${plugin}-${themeId}`
}

/**
 * 插件主题 token 的净化规则。
 *
 * 主题 token 会被内联进 `<style>`（分享页）或注入 DOM（宿主），所以只接受
 * `--dv-*` 变量名与「单一颜色值」——挡掉 `position:fixed; inset:0` 这类整页
 * 覆盖，也挡掉 `expression()` / `url()` 之类外带通道。宁可少认一个写法，
 * 也不让插件在别人的窗口上画任意东西。
 */
const VARIABLE_RE = /^--dv-[a-z0-9-]+$/
const VALUE_RE =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/]+\)|color-mix\([^;{}]+\)|var\(--dv-[a-z0-9-]+\))$/i

/** 读一份插件主题 token 表（`themes/*.json` 的形状），丢弃不合规的键值 */
export function sanitizeThemeTokens(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const clean: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VARIABLE_RE.test(name)) continue
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!VALUE_RE.test(trimmed)) continue
    clean[name] = trimmed
  }
  return clean
}

/**
 * 分享页要跟随的主题状态。
 *
 * `tokens` 只对插件主题有内容：内置主题的整套变量已经写在 theme.css 的
 * `:root[data-theme='…']` 里，分享页内联同一份 CSS 即可，不需要再抄一遍。
 *
 * 字体**不在这里**：分享页在别人的机器上打开，那台机器没有随包分发的鸿蒙字体，
 * 也不该为看一篇文档下 12MB 字体。分享页去掉 `@font-face`、按主题自带的
 * 系统字体栈回退，是与「跟随主题」唯一不冲突的取舍。
 */
export interface ShareTheme {
  /** 写进 `<html data-theme>` 的主题 id */
  theme: string
  /** 写进 `data-appearance`：插件主题没声明的变量按它从内置基底继承 */
  appearance: 'light' | 'dark'
  /** 插件主题的覆盖变量（已净化） */
  tokens: Record<string, string>
}

/** 没有主题信息时的兜底：与 `:root` 的深色基底一致，不闪色 */
export const DEFAULT_SHARE_THEME: ShareTheme = {
  theme: 'graphite',
  appearance: 'dark',
  tokens: {},
}
