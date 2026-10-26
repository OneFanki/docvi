---
components:
  codeBlock:
    kind: code-block
    title: 字节数格式化
    filename: src/utils/format.ts
    source: 教学片段：整理注释版
    language: ts
    lineNumbers: true
    code: |
      /** 字节数格式化：1024 进制，保留一位小数（1024 → 1.0 KB） */
      export function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`

        const units = ['KB', 'MB', 'GB', 'TB']
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
        return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`
      }
---

<at-code-block data-key="codeBlock"></at-code-block>
