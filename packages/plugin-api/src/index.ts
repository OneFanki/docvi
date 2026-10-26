/**
 * 插件协议：只有类型与常量，零运行时依赖。
 *
 * 这个包将来要能对外发布（第三方照它写插件），因此不允许 import 任何实现，
 * 也不允许依赖 Vue / Electron —— 类型放这里，能力由宿主注入。
 */

/** 协议主版本。主版本不匹配的插件拒绝加载（不做兼容猜测）。 */
export const PLUGIN_API_VERSION = '1'

/** 信任等级，决定安装时的提示强度与能拿到的能力 */
export type TrustLevel =
  /** A 层：渲染进程内的呈现插件（组件 / 主题 / 语法扩展） */
  | 'presentation'
  /** B 层：独立 worker，受限 Node 能力（显式授权的目录与网络） */
  | 'sandbox-service'
  /** C 层：service 进程，完整 Node（git / MCP / AI） */
  | 'trusted-service'

/** 多语言文案：至少要有 zh；host 按当前语言回退 */
export interface LocalizedText {
  zh: string
  en?: string
}

export interface ComponentContribution {
  /** 组件 kind，对应文档里的 `<at-kind>` 与 frontmatter `kind` */
  kind: string
  title: LocalizedText
  description: LocalizedText
  /** 示例文档路径（插件包内相对路径） */
  example?: string
}

export interface ThemeContribution {
  /** 主题 id，与内置主题并列注册 */
  id: string
  title: LocalizedText
  /** 外观档位：light / dark。决定 color-scheme 与派生色 */
  appearance: 'light' | 'dark'
  /**
   * token 文件（插件包内相对路径），内容是 `--dv-*` 变量名 → 颜色值。
   *
   * 一套主题就是一套完整变量：界面（--dv-ui-*）、正文（--dv-doc-*）、编辑器
   * （--dv-ed-*）都由它覆盖，没写的变量回退到内置主题。不再分维度声明——
   * 用户心智里「换主题」是整窗一起换，而分维度会让每个作者都要配齐三套。
   */
  tokens: string
}

export interface MarkdownSyntaxContribution {
  /**
   * 围栏语言名（```` ```chart ````）或容器名（`::: merged`）。
   *
   * 两种形态的数据都写在块内 YAML，都不占 frontmatter——区别只在围栏形状：
   * 围栏是通用 Markdown 语法，格式化工具与其它编辑器都能原样保留；
   * 容器更短，但 `:::` 不是标准语法，换编辑器会看到裸标记。
   */
  name: string
  /** 语法形态：fence = 代码围栏，container = `::: ` 容器 */
  form: 'fence' | 'container'
  /** 交给哪个组件 kind 渲染 */
  component: string
  title: LocalizedText
  description: LocalizedText
}

export interface CommandContribution {
  id: string
  title: LocalizedText
  /** 展示用快捷键提示；实际绑定由宿主决定 */
  hint?: string
  group?: string
}

export interface PluginContributions {
  components?: ComponentContribution[]
  themes?: ThemeContribution[]
  markdownSyntax?: MarkdownSyntaxContribution[]
  commands?: CommandContribution[]
}

export interface PluginManifest {
  /** 唯一 id：小写字母/数字/短横，全局唯一 */
  name: string
  displayName: LocalizedText
  version: string
  apiVersion: string
  description?: LocalizedText
  trust: TrustLevel
  /** 插件入口（ESM），导出 activate(ctx) */
  entry?: string
  /** 需要注入的样式表（插件包内相对路径） */
  styles?: string[]
  contributes?: PluginContributions
  /**
   * 依赖的其他插件 name。
   * 依赖缺失时该插件跳过激活并报错，但不阻塞其他插件。
   */
  dependencies?: string[]
}

/** 宿主看到的插件状态 */
export interface PluginRecord {
  manifest: PluginManifest
  /** builtin = 随应用发布；user = 用户安装 */
  origin: 'builtin' | 'user'
  enabled: boolean
  /** 安装目录绝对路径（宿主内部用；渲染进程只用于展示） */
  dir: string
  /** 加载/校验失败时的可读原因；成功为 null */
  error: string | null
  /**
   * 该包内被单独停用的组件 kind。
   *
   * 清单本身保留原样：面板要能把这些 kind 也列出来（否则停用后就再也点不到
   * 启用了）。宿主注册组件与 MCP 列活跃组件时按下标排除。
   */
  disabledComponents: string[]
}

/** 插件向宿主注册贡献时拿到的上下文 */
export interface PluginActivationContext {
  pluginId: string
  version: string
  /** 共享的 Vue 运行时——插件不得自带 Vue 副本，否则响应式会分裂 */
  vue: Record<string, unknown>
  /** 当前 host 语言（'zh' | 'en'） */
  locale: string
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  /** 注册一个组件实现；返回反注册函数 */
  registerComponent: (kind: string, component: unknown) => () => void
  /** 注册一条命令；返回反注册函数 */
  registerCommand: (command: CommandContribution & { run: () => void }) => () => void
}

/** 插件入口模块的约定导出 */
export interface PluginModule {
  activate?: (ctx: PluginActivationContext) => void | Promise<void>
  deactivate?: () => void | Promise<void>
}
