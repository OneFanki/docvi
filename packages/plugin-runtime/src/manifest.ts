import type { PluginManifest, TrustLevel } from '@docvi/plugin-api'

/**
 * manifest 校验。
 *
 * 三条原则：
 *  1. **失败必须可读**：返回逐条错误（哪个字段、期望什么），不静默跳过——
 *     插件作者看不到错误就没法修。
 *  2. **不认识的字段不拒绝**：新版本新增字段时旧宿主应能加载（向前兼容），
 *     但 `apiVersion` 主版本不匹配直接拒（协议破坏性变更）。
 *  3. **校验不做 IO**：这里只判形状；entry / tokens 文件是否存在由加载器检查，
 *     这样校验器可以在纯 Node 里单测，也能给插件作者当 lint 用。
 */

export interface ValidationOk {
  ok: true
  manifest: PluginManifest
  /** 兼容旧 manifest 时产生的提示（例如顶层 components 被归一化） */
  notices: string[]
}

export interface ValidationFail {
  ok: false
  errors: string[]
}

export type ValidationResult = ValidationOk | ValidationFail

const TRUST_LEVELS: TrustLevel[] = ['presentation', 'sandbox-service', 'trusted-service']
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
/** 插件包内相对路径：禁止绝对路径与 `..` */
const SAFE_PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function localized(value: unknown): { zh: string; en?: string } | null {
  if (!isRecord(value)) return null
  const zh = typeof value.zh === 'string' ? value.zh.trim() : ''
  if (!zh) return null
  return typeof value.en === 'string' && value.en.trim() ? { zh, en: value.en.trim() } : { zh }
}

function safePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!SAFE_PATH_RE.test(trimmed)) return null
  return trimmed
}

/**
 * 校验一份原始 manifest。
 *
 * @param raw JSON.parse 之后的对象
 * @param hostApiVersion 宿主支持的协议主版本（默认 '1'）
 */
export function validateManifest(raw: unknown, hostApiVersion = '1'): ValidationResult {
  const errors: string[] = []
  const notices: string[] = []

  if (!isRecord(raw)) return { ok: false, errors: ['manifest 必须是一个 JSON 对象'] }

  /* ---- name / version / apiVersion ---- */
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!name) errors.push('name 缺失')
  else if (!NAME_RE.test(name)) errors.push(`name 非法（只允许小写字母、数字、短横）：${name}`)

  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!version) errors.push('version 缺失')
  else if (!VERSION_RE.test(version)) errors.push(`version 必须是 semver：${version}`)

  const apiVersion = typeof raw.apiVersion === 'string' ? raw.apiVersion.trim() : ''
  if (!apiVersion) errors.push('apiVersion 缺失')
  else if (apiVersion.split('.')[0] !== hostApiVersion) {
    errors.push(`apiVersion 主版本不兼容：插件 ${apiVersion}，宿主 ${hostApiVersion}`)
  }

  const displayName = localized(raw.displayName)
  if (!displayName) errors.push('displayName.zh 缺失（或不是非空字符串）')

  /*
   * trust 缺省时按「呈现插件」处理。
   *
   * 旧插件包没有这个字段，而呈现层是最低权限、受 CSP 约束的那一层——
   * 缺省给最低权限、显式声明才升级，符合最小权限原则；
   * 反过来（缺省给高权限）会让一个漏写字段的插件拿到完整 Node。
   */
  const trustRaw = raw.trust
  const trust: TrustLevel =
    typeof trustRaw === 'string' && TRUST_LEVELS.includes(trustRaw as TrustLevel)
      ? (trustRaw as TrustLevel)
      : 'presentation'
  if (trustRaw !== undefined && typeof trustRaw !== 'string') {
    errors.push(`trust 必须是字符串（${TRUST_LEVELS.join(' / ')}）`)
  } else if (typeof trustRaw === 'string' && !TRUST_LEVELS.includes(trustRaw as TrustLevel)) {
    errors.push(`trust 必须是 ${TRUST_LEVELS.join(' / ')} 之一，收到：${trustRaw}`)
  } else if (trustRaw === undefined) {
    notices.push('未声明 trust，按「呈现插件」处理')
  }

  const description =
    raw.description === undefined ? undefined : (localized(raw.description) ?? undefined)
  if (raw.description !== undefined && !description) {
    errors.push('description 存在但不是合法多语言对象（需要 zh）')
  }

  const entry = raw.entry === undefined ? undefined : safePath(raw.entry)
  if (raw.entry !== undefined && !entry) errors.push('entry 必须是包内相对路径，且不能包含 ..')

  const styles: string[] = []
  if (raw.styles !== undefined) {
    if (!Array.isArray(raw.styles)) errors.push('styles 必须是数组')
    else {
      for (const item of raw.styles) {
        const path = safePath(item)
        if (!path) errors.push(`styles 含非法路径：${String(item)}`)
        else styles.push(path)
      }
    }
  }

  const dependencies: string[] = []
  if (raw.dependencies !== undefined) {
    if (!Array.isArray(raw.dependencies)) errors.push('dependencies 必须是数组')
    else {
      for (const dep of raw.dependencies) {
        if (typeof dep !== 'string' || !NAME_RE.test(dep)) {
          errors.push(`dependencies 含非法插件名：${String(dep)}`)
        } else dependencies.push(dep)
      }
    }
  }

  /* ---- 贡献点 ---- */
  const contributesRaw = isRecord(raw.contributes) ? raw.contributes : {}
  // 旧 manifest：components 直接挂在顶层。归一化进 contributes，并提示迁移。
  const legacyComponents = raw.components
  if (legacyComponents !== undefined && contributesRaw.components === undefined) {
    notices.push('顶层 components 已废弃，请迁移到 contributes.components')
  }
  const componentsRaw = contributesRaw.components ?? legacyComponents

  const components: NonNullable<PluginManifest['contributes']>['components'] = []
  if (componentsRaw !== undefined) {
    if (!Array.isArray(componentsRaw)) errors.push('contributes.components 必须是数组')
    else {
      const seen = new Set<string>()
      for (const [index, item] of componentsRaw.entries()) {
        if (!isRecord(item)) {
          errors.push(`components[${index}] 不是对象`)
          continue
        }
        const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
        if (!kind) {
          errors.push(`components[${index}].kind 缺失`)
          continue
        }
        if (seen.has(kind)) {
          errors.push(`components 内 kind 重复：${kind}`)
          continue
        }
        seen.add(kind)
        const title = localized(item.title)
        const itemDescription = localized(item.description)
        if (!title) errors.push(`components[${index}].title.zh 缺失`)
        if (!itemDescription) errors.push(`components[${index}].description.zh 缺失`)
        const example = item.example === undefined ? undefined : safePath(item.example)
        if (item.example !== undefined && !example) {
          errors.push(`components[${index}].example 非法路径`)
        }
        if (title && itemDescription) {
          components.push({
            kind,
            title,
            description: itemDescription,
            ...(example ? { example } : {}),
          })
        }
      }
    }
  }

  const themes: NonNullable<PluginManifest['contributes']>['themes'] = []
  if (contributesRaw.themes !== undefined) {
    if (!Array.isArray(contributesRaw.themes)) errors.push('contributes.themes 必须是数组')
    else {
      for (const [index, item] of contributesRaw.themes.entries()) {
        if (!isRecord(item)) {
          errors.push(`themes[${index}] 不是对象`)
          continue
        }
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const title = localized(item.title)
        const appearance =
          item.appearance === 'light' || item.appearance === 'dark' ? item.appearance : null
        const tokens = safePath(item.tokens)
        if (!id || !NAME_RE.test(id)) errors.push(`themes[${index}].id 非法：${String(item.id)}`)
        if (!title) errors.push(`themes[${index}].title.zh 缺失`)
        if (!appearance) errors.push(`themes[${index}].appearance 必须是 light 或 dark`)
        if (!tokens) errors.push(`themes[${index}].tokens 必须是包内相对路径`)

        if (id && title && appearance && tokens) {
          themes.push({ id, title, appearance, tokens })
        }
      }
    }
  }

  const markdownSyntax: NonNullable<PluginManifest['contributes']>['markdownSyntax'] = []
  if (contributesRaw.markdownSyntax !== undefined) {
    if (!Array.isArray(contributesRaw.markdownSyntax)) {
      errors.push('contributes.markdownSyntax 必须是数组')
    } else {
      for (const [index, item] of contributesRaw.markdownSyntax.entries()) {
        if (!isRecord(item)) {
          errors.push(`markdownSyntax[${index}] 不是对象`)
          continue
        }
        const syntaxName = typeof item.name === 'string' ? item.name.trim() : ''
        const form = item.form === 'fence' || item.form === 'container' ? item.form : null
        const component = typeof item.component === 'string' ? item.component.trim() : ''
        const title = localized(item.title)
        const itemDescription = localized(item.description)
        if (!syntaxName) errors.push(`markdownSyntax[${index}].name 缺失`)
        if (!form) errors.push(`markdownSyntax[${index}].form 必须是 fence 或 container`)
        if (!component) errors.push(`markdownSyntax[${index}].component 缺失`)
        if (!title) errors.push(`markdownSyntax[${index}].title.zh 缺失`)
        if (!itemDescription) errors.push(`markdownSyntax[${index}].description.zh 缺失`)
        if (syntaxName && form && component && title && itemDescription) {
          markdownSyntax.push({
            name: syntaxName,
            form,
            component,
            title,
            description: itemDescription,
          })
        }
      }
    }
  }

  const commands: NonNullable<PluginManifest['contributes']>['commands'] = []
  if (contributesRaw.commands !== undefined) {
    if (!Array.isArray(contributesRaw.commands)) errors.push('contributes.commands 必须是数组')
    else {
      for (const [index, item] of contributesRaw.commands.entries()) {
        if (!isRecord(item)) {
          errors.push(`commands[${index}] 不是对象`)
          continue
        }
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const title = localized(item.title)
        if (!id) errors.push(`commands[${index}].id 缺失`)
        if (!title) errors.push(`commands[${index}].title.zh 缺失`)
        if (id && title) {
          commands.push({
            id,
            title,
            ...(typeof item.hint === 'string' && item.hint.trim()
              ? { hint: item.hint.trim() }
              : {}),
            ...(typeof item.group === 'string' && item.group.trim()
              ? { group: item.group.trim() }
              : {}),
          })
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors }

  // 入口缺省时允许「纯声明插件」（只有主题或组件元数据，没有代码）
  const hasCode = Boolean(entry)
  const contributes: PluginManifest['contributes'] = {}
  if (components.length) contributes.components = components
  if (themes.length) contributes.themes = themes
  if (markdownSyntax.length) contributes.markdownSyntax = markdownSyntax
  if (commands.length) contributes.commands = commands

  if (!hasCode && !Object.keys(contributes).length) {
    return { ok: false, errors: ['插件既没有 entry，也没有任何 contributes 声明'] }
  }

  const manifest: PluginManifest = {
    name,
    displayName: displayName as { zh: string; en?: string },
    version,
    apiVersion,
    trust,
    ...(description ? { description } : {}),
    ...(entry ? { entry } : {}),
    ...(styles.length ? { styles } : {}),
    ...(dependencies.length ? { dependencies } : {}),
    ...(Object.keys(contributes).length ? { contributes } : {}),
  }

  return { ok: true, manifest, notices }
}

/** 便于插件作者自查：把校验错误拼成一段可读文本 */
export function formatValidation(result: ValidationResult): string {
  if (result.ok)
    return result.notices.length ? `通过（提示：${result.notices.join('；')}）` : '通过'
  return `校验失败：\n- ${result.errors.join('\n- ')}`
}
