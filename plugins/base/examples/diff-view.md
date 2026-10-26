---
components:
  diffView:
    kind: diff-view
    title: 导出模块：字节格式化改为复用工具函数
    filename: src/report/export.ts
    source: 教学整理版（对应「消除双实现」的常见重构，有删节）
    diff: |
      --- src/report/export.ts
      +++ src/report/export.ts
      -// 字节格式化在导出模块里内联了一份，与上传模块的实现已经开始走样
      -function formatSize(bytes: number): string {
      -  return `${(bytes / 1024).toFixed(1)} KB`
      -}
      +// 只留一份真相源：复用 utils/format 的 formatBytes（B/KB/MB/GB 全档位）
      +import { formatBytes } from '../utils/format'
       
       const total = rows.reduce((sum, row) => sum + row.size, 0)
      -const label = formatSize(total)
      +const label = formatBytes(total)
       return `${label} · ${rows.length} 行`
---

<at-diff-view data-key="diffView"></at-diff-view>
