/**
 * 键盘快捷键总表。
 *
 * 单一事实源：帮助面板直接渲染这份表，`App.vue` 的全局处理器按 id 分派。
 * 两边共用同一份声明后，「文档里写了 Ctrl+W，实际没绑」这类漂移就不可能出现——
 * 新增快捷键时先加到这里，再在 onKeydown 里按 id 实现。
 */

export interface ShortcutGroup {
  title: string
  items: Array<{ keys: string[]; action: string }>
}

/**
 * 展示用的按键写法：`Mod` 在 Windows/Linux 渲染成 Ctrl、mac 渲染成 ⌘。
 * 平台在启动时确定一次，不必每次渲染都判断。
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)

export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/**
 * 「切换标签」用的是 Ctrl+Tab（⌘⇥ 被 macOS 的系统应用切换器占用），
 * 展示文案必须跟着实现走，不能笼统写成 Mod。
 */
export const TAB_MOD_LABEL = IS_MAC ? '⌃' : 'Ctrl'

export function formatKeys(keys: string[]): string[] {
  return keys.map(key => {
    if (key === 'Mod') return MOD_LABEL
    if (key === 'TabMod') return TAB_MOD_LABEL
    return key
  })
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: '通用',
    items: [
      { keys: ['Mod', 'K'], action: '命令面板（搜索文档 / 执行命令）' },
      { keys: ['Mod', 'B'], action: '显示 / 隐藏目录树（编辑态为加粗）' },
      { keys: ['Mod', 'Alt', 'B'], action: '显示 / 隐藏本页目录' },
      { keys: ['Mod', 'Alt', 'W'], action: '正文宽度：铺满 / 收窄' },
      { keys: ['Mod', 'O'], action: '打开单个 Markdown 文件' },
      { keys: ['Mod', 'Shift', 'L'], action: '打开主题选择' },
      // ⌘, 由 macOS 应用菜单接管；Windows/Linux 没有菜单条，也没有这个习惯键位
      ...(IS_MAC ? [{ keys: ['Mod', ','], action: '打开设置' }] : []),
      { keys: ['Mod', '/'], action: '快捷键与帮助' },
      { keys: ['Esc'], action: '关闭面板 / 退出编辑模式' },
    ],
  },
  {
    title: '标签',
    items: [
      { keys: ['Mod', 'W'], action: '关闭当前标签' },
      { keys: ['TabMod', 'Shift', 'Tab'], action: '上一个标签' },
      { keys: ['TabMod', 'Tab'], action: '下一个标签' },
      { keys: ['←', '→'], action: '标签条内切换（焦点在标签上时）' },
      { keys: ['Delete'], action: '关闭标签（焦点在标签上时）' },
    ],
  },
  {
    title: '阅读',
    items: [
      { keys: ['Mod', 'F'], action: '在文档中查找' },
      { keys: ['Mod', 'E'], action: '进入 / 退出实时预览编辑' },
      { keys: ['Mod', 'S'], action: '保存（编辑态）' },
      { keys: ['F5'], action: '重新载入当前文档（读取磁盘最新内容）' },
      { keys: ['↑', '↓'], action: '目录树移动（焦点在目录树时）' },
      { keys: ['→', '←'], action: '目录树展开 / 折叠' },
    ],
  },
  {
    title: '编辑',
    items: [
      { keys: ['Mod', 'S'], action: '保存当前文档' },
      { keys: ['Mod', 'Z'], action: '撤销' },
      { keys: ['Mod', 'Shift', 'Z'], action: '重做' },
      { keys: ['Mod', 'B'], action: '加粗（选中文本）' },
      { keys: ['Mod', 'I'], action: '斜体（选中文本）' },
      { keys: ['Tab'], action: '缩进（列表内）' },
    ],
  },
]
