import { BrowserWindow, dialog, shell } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { ExportDocRequest, ExportDocResult } from '@docvi/shared'

/**
 * 文档导出：Markdown / HTML / PDF。
 *
 * 为什么三种格式合成一个模块：
 *  - 都要「弹保存框 → 拿目标路径 → 落盘」，差别只在产物字节怎么来；
 *  - 错误语义一致（用户取消 ≠ 失败），集中处理才不会出现「有的格式取消报错」。
 *
 * 产物来源的分工是刻意的：
 *  - **markdown**：渲染进程直接给原始缓冲区（原封不动，含 frontmatter）；
 *  - **html**：渲染进程给**已挂载组件后的 DOM 快照** + 内联样式。组件卡片是
 *    运行期 Vue 渲染的产物，主进程没法凭 Markdown 复原；
 *  - **pdf**：主进程把同一份 HTML 放进隐藏窗口打印 A4。用 printToPDF 而不是
 *    打印当前窗口——当前窗口带着标题栏、标签条、侧栏，那些不该进文档。
 */

const FILTERS: Record<ExportDocRequest['format'], Electron.FileFilter[]> = {
  markdown: [{ name: 'Markdown', extensions: ['md'] }],
  html: [{ name: 'HTML', extensions: ['html'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
}

const EXTENSIONS: Record<ExportDocRequest['format'], string> = {
  markdown: 'md',
  html: 'html',
  pdf: 'pdf',
}

/** 文件名里不能带路径分隔符与 Windows 保留字符；空名退回 docvi */
function sanitize(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || 'docvi'
}

/**
 * 写临时 HTML 供隐藏窗口加载。
 *
 * 不用 `data:` URL：长文档的 HTML 动辄几 MB，`data:` 会撞 Chromium 的 URL
 * 长度上限（实测 2MB 左右开始失败，且报错含糊）。落临时文件最稳。
 */
function withTempHtml(html: string, run: (file: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'docvi-export-'))
  const file = join(dir, 'export.html')
  writeFileSync(file, html, 'utf8')
  return run(file).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 隐藏窗口尚未完全释放时删不掉，系统临时目录会自行回收
    }
  })
}

/**
 * 最近一次成功导出的产物路径。
 *
 * 只存在于主进程内存，不落盘、不回传给渲染层。渲染层要「打开所在文件夹」时
 * 只能调 `revealLastExport()`，它没有参数——这样就无法借这个通道去唤起任意
 * 路径的文件管理器。
 *
 * 进程重启就丢，这是可接受的：提示条只活 3.5 秒，按钮与它在同一生命周期内。
 */
let lastExportPath: string | null = null

/** 在文件管理器里选中最近一次导出的产物 */
export async function revealLastExport(): Promise<void> {
  if (!lastExportPath) throw new Error('还没有导出过文件')
  // 文件可能已被用户移走或删掉：此时退而打开父目录，总比什么都不做有用
  if (existsSync(lastExportPath)) {
    shell.showItemInFolder(lastExportPath)
    return
  }
  const error = await shell.openPath(dirname(lastExportPath))
  if (error) throw new Error(error)
}

export async function exportDocument(
  parent: BrowserWindow,
  request: ExportDocRequest,
): Promise<ExportDocResult> {
  const filename = `${sanitize(request.suggestedName)}.${EXTENSIONS[request.format]}`
  /*
   * 自动化验收钩子：设置 DOCVI_EXPORT_DIR 时跳过系统保存框，直接写进该目录。
   *
   * 系统保存框是 OS 级窗口，CDP 与自动化脚本都碰不到它——没有这个钩子，
   * 导出功能在 CI 里只能测到「函数被调用」，测不到产物内容。钩子只改落点，
   * 不改变任何产物生成逻辑。
   */
  const presetDir = process.env.DOCVI_EXPORT_DIR
  let target: string
  if (presetDir) {
    target = join(presetDir, filename)
  } else {
    const result = await dialog.showSaveDialog(parent, {
      title: '导出',
      defaultPath: filename,
      filters: FILTERS[request.format],
    })
    if (result.canceled || !result.filePath) return { canceled: true, path: '' }
    target = result.filePath
  }

  if (request.format === 'markdown' || request.format === 'html') {
    writeFileSync(target, request.text, 'utf8')
    lastExportPath = target
    return { canceled: false, path: target }
  }

  await withTempHtml(request.text, async file => {
    const printer = new BrowserWindow({
      show: false,
      webPreferences: {
        // 导出是静态快照：脚本一律不执行，避免文档里的组件二次初始化
        javascript: false,
        sandbox: true,
        contextIsolation: true,
      },
    })
    try {
      await printer.loadFile(file)
      const pdf = await printer.webContents.printToPDF({
        pageSize: 'A4',
        /*
         * printBackground 决定「背景绘制进 PDF 与否」。
         *
         * 之前一直是 true，于是 `.doc-surface` 的米色底色被整页印进 PDF，用户在
         * 阅读器里看到一块纸面而不是阅读器自己的背景。现在页面底色已被
         * `transparentPage` 抹成透明，这里继续 true 只影响**内容自带的色块**
         * （代码块、提示框、mermaid 节点）——那些必须保留。
         * 若改成 false，这些色块会一起消失，是净损失。
         */
        printBackground: true,
        // 打印边距单位是英寸；左右留窄一些，正文本身已有排版留白
        margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
      })
      writeFileSync(target, pdf)
      lastExportPath = target
    } finally {
      // 隐藏窗口必须销毁：它是真实 BrowserWindow，不关会留下一个不可见进程
      printer.destroy()
    }
  })
  return { canceled: false, path: target }
}
