/**
 * 组件注册表 + 声明式数据桥。
 *
 * 文档里的写法：
 *   ---
 *   components:
 *     flow1:
 *       kind: flow-diagram
 *       nodes: [...]
 *   ---
 *   <at-flow-diagram data-key="flow1"></at-flow-diagram>
 *
 * 渲染时：data-key 指向 frontmatter.components 的键，`kind` 决定用哪个组件，
 * 其余字段**整体透传为 props**。组件不知道自己是第几个、也不知道宿主是谁。
 *
 * 为什么不用 Custom Elements：内置组件走原生 Vue 渲染（`render(h(...))`）零桥接开销；
 * 只有第三方插件产物才需要 defineCustomElement + import map。旧壳把所有组件都包成
 * 自定义元素，代价是 vue-shim 与单实例约束长期难维护。
 */
import { h, render, type AppContext, type Component } from 'vue'
import { parse as parseYaml } from 'yaml'

export interface ComponentMeta {
  title: string
  description: string
  /** 组件包来源（诊断与面板展示用） */
  packageName?: string
}

export interface RegistryEntry {
  kind: string
  component: Component
  meta: ComponentMeta
}

export class ComponentRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  register(kind: string, component: Component, meta: ComponentMeta): void {
    // 同名 kind 后注册者覆盖：宿主负责在更上层做「同名切换」的用户选择
    this.entries.set(kind, { kind, component, meta })
  }

  get(kind: string): RegistryEntry | undefined {
    return this.entries.get(kind)
  }

  has(kind: string): boolean {
    return this.entries.has(kind)
  }

  list(): RegistryEntry[] {
    return [...this.entries.values()]
  }
}

export interface MountOptions {
  /** 当前 appContext：让组件能用 Pinia / 全局组件 / 全局样式 */
  appContext?: AppContext
  /** 数据缺失或组件未注册时的展示（默认内联提示） */
  onMissing?: (info: {
    key: string
    kind: string | null
    reason: 'no-data' | 'no-component'
  }) => void
}

export interface DeclarativeMount {
  /** 卸载全部已挂载组件（切文档前必须调用，否则 Vue 实例泄漏） */
  dispose(): void
  /** 成功挂载的组件数量 */
  readonly count: number
}

/**
 * 把根元素内所有声明式组件挂载为 Vue 组件。
 *
 * 幂等性：每次调用前先卸载上一次的实例；同一数据引用不重复挂载（避免
 * MutationObserver 与 attach 互相触发）。
 */
export function mountDeclarativeComponents(
  root: HTMLElement,
  decl: Record<string, Record<string, unknown>> | null | undefined,
  registry: ComponentRegistry,
  options: MountOptions = {},
): DeclarativeMount {
  const mounted: HTMLElement[] = []

  const dispose = (): void => {
    for (const el of mounted) render(null, el)
    mounted.length = 0
  }

  dispose()

  const targets = Array.from(root.querySelectorAll<HTMLElement>('[data-key]')).filter(el =>
    el.tagName.toLowerCase().startsWith('at-'),
  )

  for (const el of targets) {
    const key = el.dataset.key ?? ''
    const data = key ? decl?.[key] : undefined
    if (!data || typeof data !== 'object') {
      options.onMissing?.({ key, kind: null, reason: 'no-data' })
      continue
    }
    const kind = typeof data.kind === 'string' ? data.kind : el.tagName.toLowerCase().slice(3)
    const entry = registry.get(kind)
    if (!entry) {
      options.onMissing?.({ key, kind, reason: 'no-component' })
      continue
    }
    // 幂等：同元素同数据对象不重复挂载
    const src = (el as unknown as { __declSrc?: unknown }).__declSrc
    if (src === data) {
      mounted.push(el)
      continue
    }
    ;(el as unknown as { __declSrc?: unknown }).__declSrc = data

    const props: Record<string, unknown> = { ...data }
    delete props.kind
    // 容器里可能有上一轮渲染结果（Vue 的 render 不清空容器），挂载前先清空，
    // 否则新旧内容并存，表现为组件被挤到旁边或根本不显示。
    el.replaceChildren()

    const vnode = h(entry.component, props)
    if (options.appContext) vnode.appContext = options.appContext
    render(vnode, el)
    mounted.push(el)
  }

  return {
    dispose,
    get count() {
      return mounted.length
    },
  }
}

/**
 * 挂载插件容器语法声明的结构化块（`::: merged` 之类）。
 *
 * 与声明式组件（frontmatter + data-key）的区别：数据在块内而不是页面头部，
 * 因此这里读占位元素上的 `data-plugin-payload`（percent-encoded YAML）再解析。
 *
 * 三条：
 *  1. 解析失败 / 组件未注册都在原位留可读提示，不吞掉内容；
 *  2. 卸载走同一个 `render(null, el)`，不留实例；
 *  3. 只认 `data-plugin-component`，不猜标签名——语法名和组件名可以不同。
 */
export function mountPluginBlocks(
  root: HTMLElement,
  registry: ComponentRegistry,
  options: MountOptions & {
    onInvalid?: (info: { syntax: string; component: string; message: string }) => void
  } = {},
): DeclarativeMount {
  const mounted: HTMLElement[] = []
  const dispose = (): void => {
    for (const el of mounted) {
      render(null, el)
      // 卸载后把原始 YAML 以纯文本还原：否则停用插件后块会变成空白，
      // 用户既看不到提示也看不到原文（内容还在 Markdown 里，只是没人渲染它）
      const backup = el.dataset.pluginPayload ?? ''
      if (backup) {
        try {
          el.textContent = decodeURIComponent(backup)
        } catch {
          el.textContent = backup
        }
      }
    }
    mounted.length = 0
  }

  dispose()

  const targets = root.querySelectorAll<HTMLElement>('[data-plugin-component]')
  for (const el of targets) {
    const componentKind = el.dataset.pluginComponent ?? ''
    const syntaxName = el.dataset.pluginSyntax ?? componentKind
    const entry = registry.get(componentKind)
    if (!entry) {
      // 未启用对应插件：把 YAML 原文显示出来，让读者仍能看到内容
      el.classList.add('at-plugin-block--missing')
      el.setAttribute('data-missing', `组件未注册：${componentKind}`)
      try {
        el.textContent = decodeURIComponent(el.dataset.pluginPayload ?? '')
      } catch {
        // 编码损坏就保持空容器，不抛错打断整页渲染
      }
      options.onMissing?.({ key: syntaxName, kind: componentKind, reason: 'no-component' })
      continue
    }

    const source = decodeURIComponent(el.dataset.pluginPayload ?? '')
    let props: Record<string, unknown>
    try {
      const parsed = parseYaml(source)
      props =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { ...(parsed as object) }
          : {}
    } catch (error) {
      options.onInvalid?.({
        syntax: syntaxName,
        component: componentKind,
        message: (error as Error).message,
      })
      continue
    }

    // 容器里可能留着上一轮的渲染结果或缺失提示：Vue 的 render 不清空容器，
    // 直接往里挂会让新旧内容并存
    el.replaceChildren()

    const vnode = h(entry.component, props)
    if (options.appContext) vnode.appContext = options.appContext
    render(vnode, el)
    mounted.push(el)
  }

  return {
    dispose,
    get count() {
      return mounted.length
    },
  }
}
