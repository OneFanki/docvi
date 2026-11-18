import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  BUILTIN_APPEARANCE,
  DEFAULT_SHARE_THEME,
  pluginThemeId,
  sanitizeThemeTokens,
} from '@docvi/shared'
import type { AppSettings, ShareTheme } from '@docvi/shared'

import type { PluginRecord } from '@docvi/plugin-api'

/**
 * 把「应用当前的外观」整理成分享页要用的主题快照。
 *
 * 分享页由服务进程直出，拿不到渲染进程的 DOM（`<html data-theme>` 之类），
 * 所以主题必须以数据形式送过去。输入有两处：
 *
 *  - `settings`：主题 id——主进程本来就持有；
 *  - 插件记录：插件主题声明的 token 表（`themes/*.json`）只在插件目录里，
 *    渲染层是从 `docvi://plugin/…` 现取的，主进程这里直接读文件。
 *
 * 为什么不让渲染层推主题给服务进程：分享链接在窗口关闭后仍可访问（服务常驻），
 * 那时渲染层根本不在，推一次就停摆。主进程是唯一在两种状态下都在的地方。
 */
export function shareThemeFromSettings(
  settings: AppSettings,
  records: readonly PluginRecord[],
): ShareTheme {
  for (const record of records) {
    if (!record.enabled || record.error) continue
    for (const theme of record.manifest.contributes?.themes ?? []) {
      if (pluginThemeId(record.manifest.name, theme.id) !== settings.theme) continue
      return {
        theme: settings.theme,
        appearance: theme.appearance,
        tokens: readTokens(record.dir, theme.tokens),
      }
    }
  }

  return {
    theme: settings.theme,
    // 内置主题查表；主题已被停用 / 卸载时按默认深色，与内置基底一致
    appearance: BUILTIN_APPEARANCE[settings.theme] ?? DEFAULT_SHARE_THEME.appearance,
    tokens: {},
  }
}

/** 读插件主题 token 表；读不到就是空表（退回内置基底，不阻断分享） */
function readTokens(dir: string, relPath: string): Record<string, string> {
  try {
    return sanitizeThemeTokens(JSON.parse(readFileSync(join(dir, relPath), 'utf8')))
  } catch {
    return {}
  }
}
