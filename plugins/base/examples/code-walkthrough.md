---
components:
  codeWalkthrough:
    kind: code-walkthrough
    title: 扫描工具函数
    filename: src/scan-utils.ts
    source: 教学片段：整理注释版（相对真实实现有删节）
    language: ts
    code: |
      /** 路径统一为 POSIX 分隔符（Windows 反斜杠 → 正斜杠） */
      export function toPosixPath(input: string): string {
        return input.replace(/\\/g, '/').replace(/^\.\//, '')
      }

      /** 自然排序：`page2` 排在 `page10` 前面（数字段按数值比较） */
      export function naturalCompare(left: string, right: string): number {
        return left.localeCompare(right, 'zh-CN', { numeric: true })
      }

      /** 收集目录里的 Markdown 文件名（省略递归与过滤细节） */
      export function collectMarkdown(names: string[]): string[] {
        return names
          .filter((name) => name.endsWith('.md'))
          .sort(naturalCompare)
      }
    steps:
      - title: 路径归一化
        lines:
          - - 1
            - 4
        note: toPosixPath：Windows 反斜杠统一成正斜杠，跨平台展示与比较都以 POSIX 形态进行。
      - title: 自然排序
        lines:
          - - 6
            - 9
        note: naturalCompare：numeric 选项让数字段按数值比较——page2 不会排到 page10 之后。
      - title: 组合：过滤 + 排序
        lines:
          - - 11
            - 16
        note: collectMarkdown 先过滤后缀、再复用自然排序；排序键只在这一处定义。
---

<at-code-walkthrough data-key="codeWalkthrough"></at-code-walkthrough>
