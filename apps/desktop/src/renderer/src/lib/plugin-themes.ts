import { ref } from 'vue'

import type { PluginRecordView, Result } from '@docvi/shared'

/**
 * 插件主题加载。
 *
 * 主题的本质是「一整套 CSS 变量」。插件交一份 token 表即可覆盖任意层级：
 * 界面（--dv-ui-*）、正文（--dv-doc-*）、编辑器（--dv-ed-*）全部挂在同一个
 * `:root[data-theme='<id>']` 上，没写的变量从内置主题继承。
 *
 * 为什么不再按维度拆分：拆分意味着插件作者要为「界面 / 文档 / 编辑器」各交
 * 一套（3×3×3 种组合都要能看），而用户心智里「换主题」就是整窗一起换。
 * 一个主题插件可以包含多套主题（themes 数组），这才是"多套"的正确粒度。
 *
 * 安全边界：token 只接受 `--dv-*` 变量名与颜色值，绝不注入到 DOM 之外的
 * 任意 CSS（防 `position:fixed; inset:0` 之类整页覆盖）。
 */

export interface LoadedTheme {
  /** 选择器里用的 id，加 `plugin-` 前缀避免与内置主题撞名 */
  id: string
  title: string
  appearance: 'light' | 'dark'
  plugin: string
}

const VARIABLE_RE = /^--dv-[a-z0-9-]+$/
/** 颜色值白名单：hex / rgb(a) / hsl(a) / color-mix / var() 引用。挡掉整段 CSS 注入 */
const VALUE_RE =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/]+\)|color-mix\([^;{}]+\)|var\(--dv-[a-z0-9-]+\))$/i

const themes = ref<LoadedTheme[]>([])
/** 已注入的样式表（按插件 id），停用时要能撤掉 */
const injected = new Map<string, HTMLStyleElement>()

export function usePluginThemes() {
  /**
   * 读取插件声明的全部主题并注入样式。
   *
   * 每插件一个 `<style>`：停用插件时整块移除，不会残留半套变量。
   */
  async function load(records: PluginRecordView[]): Promise<void> {
    const next: LoadedTheme[] = []

    for (const record of records) {
      if (!record.enabled || record.error) continue
      const declared = record.contributes?.themes ?? []
      if (!declared.length) continue

      const blocks: string[] = []
      for (const theme of declared) {
        const tokens = await readTokens(record.name, theme.tokens)
        if (!tokens) continue
        const id = `plugin-${record.name}-${theme.id}`
        const body = Object.entries(tokens)
          .map(([name, value]) => `  ${name}: ${value};`)
          .join('\n')
        if (!body) continue

        /*
         * 整套变量挂同一个选择器：没声明的变量从内置主题继承，因此插件只写
         * 自己想改的部分（例如只改强调色）也能成立，不会出现「半套主题」。
         */
        blocks.push(`:root[data-theme='${id}'] {\n${body}\n}`)

        next.push({
          id,
          title: theme.title.zh,
          appearance: theme.appearance,
          plugin: record.name,
        })
      }

      if (!blocks.length) continue
      let style = injected.get(record.name)
      if (!style) {
        style = document.createElement('style')
        style.dataset.pluginTheme = record.name
        document.head.appendChild(style)
        injected.set(record.name, style)
      }
      style.textContent = blocks.join('\n\n')
    }

    // 清理已不存在/已停用插件注入的样式
    const alive = new Set(records.filter(r => r.enabled && !r.error).map(r => r.name))
    for (const [plugin, style] of injected) {
      if (alive.has(plugin)) continue
      style.remove()
      injected.delete(plugin)
    }

    themes.value = next
  }

  return { themes, load }
}

async function readTokens(plugin: string, relPath: string): Promise<Record<string, string> | null> {
  try {
    // 资源的真实位置由宿主决定：Electron 走 docvi:// 自定义协议，容器里是
    // HTTP（/plugins/<name>/<version>/…）。渲染层不自己拼 URL。
    const url =
      window.docvi.pluginAssetUrl?.(plugin, relPath) ??
      `docvi://plugin/${encodeURIComponent(plugin)}/${relPath}`
    const response = await fetch(url)
    if (!response.ok) return null
    const raw = (await response.json()) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const clean: Record<string, string> = {}
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!VARIABLE_RE.test(name)) continue
      if (typeof value !== 'string') continue
      if (!VALUE_RE.test(value.trim())) continue
      clean[name] = value.trim()
    }
    return clean
  } catch {
    return null
  }
}

/** 全局共享：主题是应用级单例 */
export const pluginThemes = usePluginThemes()

/** 供测试与诊断：按插件 id 直接拉一次 token（不注入） */
export async function dryRunTokens(plugin: string, relPath: string) {
  return readTokens(plugin, relPath)
}

export type { Result }
