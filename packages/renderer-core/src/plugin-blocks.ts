/**
 * 插件结构化块的**唯一**扫描实现。
 *
 * 两种形态共用同一套行扫描：
 *  - `container`：`::: <名字>` … `:::`（块内是 YAML）
 *  - `fence`：```` ``` <名字> ```` … 同长度围栏（块内是 YAML）
 *
 * 为什么收成一份：渲染管线（阅读态 / 导出 / 分享）与编辑态（Live Preview 的
 * 块装饰）都需要「哪些行属于一个插件块」。两处各写一份正则曾导致语义漂移——
 * 缩进两格的收尾 `:::` 在编辑态被识别、阅读态不认，同一篇文档两处长得不一样。
 *
 * 三条扫描纪律：
 *  1. **先认普通围栏**：任何 ``` / ~~~ 代码块整段跳过，否则代码块里举例写的
 *     `::: merged` 会被当成真块。
 *  2. **只认已声明的名字**：用户手写的 `::: 随便什么` 留在源码里，强行渲染
 *     会让「名字写错」看起来像已生效。
 *  3. **允许 0–3 个前导空格**：Markdown 里块级结构允许缩进到这个量级；
 *     收尾标记缩进是作者手写时的常态（官方示例就是缩进两格）。
 */

/**
 * 一个插件语的声明。
 *
 * `form` 缺省按 `container` 处理：早期清单没写 form 时只有容器一种形态，
 * 按容器解释才能让老插件继续工作。
 */
export interface PluginSyntaxDeclaration {
  name: string
  form?: 'container' | 'fence'
  /** 目标组件 kind */
  component: string
}

/** 扫描结果：行号与块体都属于「文档坐标」，由调用方各自换算 */
export interface PluginBlockSpan {
  /** 起始行（含围栏行），0 基 */
  startLine: number
  /** 结束行（含收尾行），0 基 */
  endLine: number
  /** 块体原文（去掉围栏行；不 trim，缩进由调用方决定怎么处理） */
  body: string
  /** 命中的语法名 */
  name: string
  /** 目标组件 kind */
  component: string
  form: 'container' | 'fence'
}

/** 前导空格 0–3 + `:::` + 名字；后面不允许再有内容 */
const CONTAINER_OPEN = /^ {0,3}:::[ \t]*([\w-]+)[ \t]*$/
/** 收尾只有 `:::`（允许缩进与尾随空白） */
const CONTAINER_CLOSE = /^ {0,3}:::[ \t]*$/
/** 围栏开：``` 或 ~~~，可带 info；info 首位是语言名 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w-]*)/

function normSyntax(syntax: PluginSyntaxDeclaration[]): {
  containers: Map<string, string>
  fences: Map<string, string>
} {
  const containers = new Map<string, string>()
  const fences = new Map<string, string>()
  for (const item of syntax) {
    if (!item?.name || !item?.component) continue
    if (item.form === 'fence') fences.set(item.name, item.component)
    else containers.set(item.name, item.component)
  }
  return { containers, fences }
}

/**
 * 扫描出全部插件块（按出现顺序）。
 *
 * 传行数组而不是整串：调用方各有所需的坐标（Markdown 用偏移、CM6 用行位置），
 * 由它们自己拼，这里只回答「哪几行、归谁」。
 */
export function findPluginBlocks(
  lines: readonly string[],
  syntax: PluginSyntaxDeclaration[],
): PluginBlockSpan[] {
  if (!syntax.length) return []
  const { containers, fences } = normSyntax(syntax)
  const out: PluginBlockSpan[] = []

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''

    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      // 普通围栏也要整段跳过：代码块里举例的 `::: xxx` 不是真块
      const marker = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      const closeRe = new RegExp(
        `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`,
      )
      let close = -1
      for (let probe = index + 1; probe < lines.length; probe += 1) {
        if (closeRe.test(lines[probe] ?? '')) {
          close = probe
          break
        }
      }
      const component = fences.get(lang)
      if (component && close > index) {
        out.push({
          startLine: index,
          endLine: close,
          body: lines.slice(index + 1, close).join('\n'),
          name: lang,
          component,
          form: 'fence',
        })
      }
      // 未闭合的围栏按「一直到文末」处理，不再继续找块
      index = close > index ? close + 1 : lines.length
      continue
    }

    const open = CONTAINER_OPEN.exec(line)
    if (open?.[1]) {
      const name = open[1]
      const component = containers.get(name)
      if (component) {
        let close = -1
        for (let probe = index + 1; probe < lines.length; probe += 1) {
          if (CONTAINER_CLOSE.test(lines[probe] ?? '')) {
            close = probe
            break
          }
        }
        if (close > index) {
          out.push({
            startLine: index,
            endLine: close,
            body: lines.slice(index + 1, close).join('\n'),
            name,
            component,
            form: 'container',
          })
          index = close + 1
          continue
        }
      }
    }

    index += 1
  }

  return out
}
