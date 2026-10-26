import { computed } from 'vue'

import { pluginThemes } from './plugin-themes'
import { useI18n } from './i18n'

/**
 * 可选主题清单（内置 + 各插件贡献）。
 *
 * 设置页的主题网格与状态栏的主题下拉都用这一份：两处若各自拼一遍列表，
 * 迟早出现「下拉里能选、设置页里没有」这类漂移。内置项的名字走 t()，
 * 因此每次语言切换都会跟着变——所以整份清单是 computed，不是常量数组。
 */
export interface ThemeOption {
  id: string
  title: string
  /** null = 内置主题 */
  plugin: string | null
  appearance: 'light' | 'dark'
}

export function useThemeOptions() {
  const { t } = useI18n()

  return computed<ThemeOption[]>(() => [
    { id: 'slate', title: t('theme.slate'), plugin: null, appearance: 'dark' },
    { id: 'mist', title: t('theme.mist'), plugin: null, appearance: 'light' },
    { id: 'graphite', title: t('theme.graphite'), plugin: null, appearance: 'dark' },
    { id: 'paper', title: t('theme.paper'), plugin: null, appearance: 'light' },
    ...pluginThemes.themes.value.map(item => ({
      id: item.id,
      title: item.title,
      plugin: item.plugin,
      appearance: item.appearance,
    })),
  ])
}
