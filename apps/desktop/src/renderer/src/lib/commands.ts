import { ref, type Component } from 'vue'

/**
 * 命令注册表。
 *
 * 命令面板里的每一项都来自这里：内置功能在 App 启动时注册，插件将来走同一条
 * 通道（S4 的贡献点之一）。注册即出现、注销即消失，不需要面板知道命令从哪来。
 */
export interface Command {
  id: string
  title: string
  /** 右侧快捷键提示（纯展示，不参与绑定） */
  hint?: string
  /** 补充关键词：中英文别名、拼音首字母等，参与匹配但不显示 */
  keywords?: string
  icon?: Component
  /** 分组：同组在面板里连续排列 */
  group: string
  run: () => void | Promise<void>
}

const commands = ref<Command[]>([])

export function useCommands() {
  function register(command: Command): () => void {
    commands.value = [...commands.value.filter(item => item.id !== command.id), command]
    return () => unregister(command.id)
  }

  function unregister(id: string): void {
    commands.value = commands.value.filter(item => item.id !== id)
  }

  return { commands, register, unregister }
}

/** 匹配：标题或关键词包含任一 term（大小写不敏感） */
export function matchCommand(command: Command, terms: string[]): boolean {
  if (!terms.length) return true
  const haystack = `${command.title} ${command.keywords ?? ''} ${command.group}`.toLowerCase()
  return terms.every(term => haystack.includes(term.toLowerCase()))
}
