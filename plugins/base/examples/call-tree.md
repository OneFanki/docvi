---
components:
  callTree:
    kind: call-tree
    title: buildSite 的调用树
    data:
      - name: buildSite()
        open: true
        meta: 1 次
        children:
          - name: loadConfig()
            meta: 3ms
            note: 读配置、校验目录存在
          - name: scanDir()
            meta: 12ms
            children:
              - name: collectMarkdown()
                note: 收集 .md 并过滤排除项
              - name: naturalCompare()
                meta: ×86
                note: 排序键比较
          - name: renderPage()
            meta: ×9
            children:
              - name: markdownToHtml()
              - name: escapeHtml()
                meta: ×210
---

<at-call-tree data-key="callTree"></at-call-tree>
