/**
 * 代码高亮：Shiki 细粒度按需加载。
 *
 * ⚠️ 不能用 `import { createHighlighter, bundledLanguages } from 'shiki'`：
 * 那个入口会静态引入**全量语言注册表**（几百个 `() => import('./abap-….js')`
 * 描述符），把入口 chunk 撑到 1.2MB（S1 实测）。这里只用 core + 一个引擎 +
 * 显式的语言集合，未列出的语言按需动态 import。
 *
 * 双主题产物走 `defaultColor: false`：明暗切换只换 CSS 变量，不重新高亮。
 */
import { createHighlighterCore } from '@shikijs/core'
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma'
import type { HighlighterCore } from '@shikijs/core'

/**
 * 直载语言（文档里出现频率最高的十个）。
 *
 * ⚠️ 必须用**显式 import**，不能写 `import(\`@shikijs/langs/${id}\`)`：
 * 打包器无法静态分析模板拼接，产物里会留下裸标识符，运行时抛
 * `Failed to resolve module specifier`（S1 实测，高亮静默失败）。
 */
const LANG_IMPORTS: Record<string, () => Promise<{ default: unknown }>> = {
  typescript: () => import('@shikijs/langs/typescript'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  yaml: () => import('@shikijs/langs/yaml'),
  markdown: () => import('@shikijs/langs/markdown'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  vue: () => import('@shikijs/langs/vue'),
  diff: () => import('@shikijs/langs/diff'),
  tsx: () => import('@shikijs/langs/tsx'),
  jsx: () => import('@shikijs/langs/jsx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  sql: () => import('@shikijs/langs/sql'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  ini: () => import('@shikijs/langs/ini'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  toml: () => import('@shikijs/langs/toml'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  java: () => import('@shikijs/langs/java'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  xml: () => import('@shikijs/langs/xml'),
  graphql: () => import('@shikijs/langs/graphql'),
  scss: () => import('@shikijs/langs/scss'),
  nginx: () => import('@shikijs/langs/nginx'),
  make: () => import('@shikijs/langs/make'),
}

const PRELOAD_LANGS = [
  'typescript',
  'javascript',
  'shellscript',
  'json',
  'yaml',
  'markdown',
  'html',
  'css',
  'vue',
  'diff',
] as const

type LangId = (typeof PRELOAD_LANGS)[number] | string

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  // ⚠️ bash 模块里的语言定义名叫 shellscript（含 sh/bash 别名），
  // 索引必须用 shellscript，用 'bash' 会查不到已加载语言而反复重载。
  bash: 'shellscript',
  sh: 'shellscript',
  shell: 'shellscript',
  yml: 'yaml',
  py: 'python',
  rs: 'rust',
  md: 'markdown',
}

let highlighterPromise: Promise<HighlighterCore> | null = null

/**
 * 把语言模块的导出归一成 `loadLanguage` 可接受的形态。
 *
 * ⚠️ `@shikijs/langs/<id>` 的 default 是**数组**（一个模块可含多个语言定义，
 * 例如 `bash` 模块里同时有 `shellscript` 与其别名），不能直接展开成对象，
 * 否则 tmlanguage 注册器会在 `displayName.split()` 处抛 TypeError（S1 实测）。
 */
function langDefs(mod: { default?: unknown } | unknown): unknown {
  const value = (mod as { default?: unknown })?.default ?? mod
  return value
}

async function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [lightTheme, darkTheme] = await Promise.all([
      import('@shikijs/themes/github-light'),
      import('@shikijs/themes/github-dark'),
    ])
    const langs = await Promise.all(
      PRELOAD_LANGS.map(async id => {
        const loader = LANG_IMPORTS[id]
        return loader ? langDefs(await loader()) : null
      }),
    )
    return createHighlighterCore({
      themes: [lightTheme.default ?? lightTheme, darkTheme.default ?? darkTheme],
      langs: langs.flatMap(def => (Array.isArray(def) ? def : [def])).filter(Boolean) as never,
      /**
       * 用 Oniguruma（wasm）而不是 JavaScript 正则引擎。
       *
       * 实测（S1）：JS 引擎会把 Oniguruma 语法翻译成 JS 正则，产物里带一个
       * 18KB 的单行 Unicode 字符类表 + 大量匹配器代码；Oniguruma 引擎只有一段
       * wasm（独立资源、可缓存、不进 JS 包）。wasm 需要 CSP 的
       * `wasm-unsafe-eval`（见 index.html，否则编译被拦、高亮静默失败）。
       */
      engine: createOnigurumaEngine(import('@shikijs/engine-oniguruma/wasm-inlined')),
    })
  })()
  return highlighterPromise
}

function normalizeLang(lang: string): string {
  const lower = lang.toLowerCase()
  return LANG_ALIASES[lower] ?? lower
}

async function highlightCode(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter()
  const normalized = normalizeLang(lang)
  const isLoaded = highlighter.getLoadedLanguages().includes(normalized)

  if (!isLoaded) {
    const loader = LANG_IMPORTS[normalized]
    if (!loader) return plainBlock(code)
    try {
      const mod = await loader()
      await highlighter.loadLanguage(langDefs(mod) as never)
    } catch {
      return plainBlock(code)
    }
  }

  try {
    return highlighter.codeToHtml(code, {
      lang: normalized as LangId,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    })
  } catch {
    return plainBlock(code)
  }
}

function plainBlock(code: string): string {
  return `<pre class="shiki"><code>${code.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</code></pre>`
}

/** 替换容器内全部代码块占位；已处理的打标记，重复调用幂等 */
export async function highlightPass(root: HTMLElement): Promise<void> {
  const placeholders = root.querySelectorAll<HTMLElement>('div[class*="language-"] pre > code')
  for (const codeEl of Array.from(placeholders)) {
    const wrapper = codeEl.closest<HTMLElement>('div[class*="language-"]')
    if (!wrapper || wrapper.dataset.highlighted) continue
    const lang = (/language-([\w-]+)/.exec(wrapper.className)?.[1] ?? 'text').toLowerCase()
    const code = codeEl.textContent ?? ''
    wrapper.dataset.highlighted = '1'
    try {
      const html = await highlightCode(code, lang)
      const pre = wrapper.querySelector('pre')
      if (pre) {
        pre.outerHTML = html
        wrapper.classList.add('highlighted')
      }
    } catch (error) {
      console.warn('[renderer] 高亮失败（保留原文）:', lang, error)
    }
  }
}
