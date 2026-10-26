import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'

/**
 * 内容根配置（docs.config.yaml）。
 *
 * 语义与旧平台一致：配置存在时按 `sidebar` 声明映射树根（text 作显示名、
 * order 作排序键）；不存在时回退为自动扫描目录。
 *
 * 只读取树形相关字段——正文渲染、主题等配置由渲染层消费，主进程不需要知道。
 */
export interface SidebarEntry {
  text: string
  path: string
  order?: number
}

export interface ContentConfig {
  title?: string
  description?: string
  sidebar?: SidebarEntry[]
}

export const CONFIG_FILENAME = 'docs.config.yaml'

export function readConfig(root: string): ContentConfig | null {
  try {
    const text = readFileSync(join(root, CONFIG_FILENAME), 'utf8')
    const parsed = parseYaml(text) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const raw = parsed as Record<string, unknown>

    const sidebar = Array.isArray(raw.sidebar)
      ? raw.sidebar.flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const entry = item as Record<string, unknown>
          if (typeof entry.text !== 'string' || typeof entry.path !== 'string') return []
          return [
            {
              text: entry.text,
              path: entry.path,
              ...(typeof entry.order === 'number' ? { order: entry.order } : {}),
            },
          ]
        })
      : undefined

    return {
      ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(sidebar?.length ? { sidebar } : {}),
    }
  } catch {
    return null
  }
}
