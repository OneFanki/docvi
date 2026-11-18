import {
  clipboard,
  Menu,
  shell,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from 'electron'

/**
 * 原生右键菜单。
 *
 * Electron 默认不提供右键菜单——`spellcheck: true` 只会画红色波浪线，建议词
 * 仍然要由 `context-menu` 事件自己拼菜单才能出现。Windows / macOS 上「右键
 * 复制 / 粘贴 / 拼写建议」都是系统级肌肉记忆，缺了会明显不像桌面应用。
 *
 * 只在**文本相关**场景弹原生菜单（可编辑、有选中文字、拼写错误、链接）；
 * 目录树 / 标签条这类区域有各自的 Vue 菜单，且文本设置了 `user-select: none`，
 * 不会同时冒出第二个菜单。
 */
const TRUSTED_LINK = /^(https?:\/\/|mailto:)/i

export function installNativeContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template = buildContextMenuTemplate(win, params)
    if (!template.length) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
}

function buildContextMenuTemplate(
  win: BrowserWindow,
  params: ContextMenuParams,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = []
  const { editFlags } = params

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5)
    for (const suggestion of suggestions) {
      template.push({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      })
    }
    if (suggestions.length) template.push({ type: 'separator' })
    template.push({
      label: `添加到词典：「${params.misspelledWord}」`,
      click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    })
    template.push({ type: 'separator' })
  }

  if (params.isEditable) {
    template.push(
      { role: 'undo', label: '撤销', enabled: editFlags.canUndo },
      { role: 'redo', label: '重做', enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: '剪切', enabled: editFlags.canCut },
      { role: 'copy', label: '复制', enabled: editFlags.canCopy },
      { role: 'paste', label: '粘贴', enabled: editFlags.canPaste },
      { role: 'selectAll', label: '全选', enabled: editFlags.canSelectAll },
    )
  } else if (params.selectionText.trim()) {
    template.push({ role: 'copy', label: '复制', enabled: editFlags.canCopy })
  }

  if (params.linkURL && TRUSTED_LINK.test(params.linkURL)) {
    if (template.length) template.push({ type: 'separator' })
    template.push(
      {
        label: '在浏览器中打开链接',
        click: () => void shell.openExternal(params.linkURL),
      },
      {
        label: '复制链接地址',
        click: () => clipboard.writeText(params.linkURL),
      },
    )
  }

  return template
}
