---
components:
  fileTree:
    kind: file-tree
    title: 生成器目录
    data:
      - name: src/
        open: true
        note: 站点生成器（教学示意）
        children:
          - name: config.ts
            note: 读取配置并归一化：树根、排除项、静态目录
          - name: scan.ts
            note: 递归扫描目录，产出站点树与页面清单
          - name: sort.ts
            note: 自然排序与排序键（order / 名称）
          - name: render.ts
            note: Markdown 渲染与页面组装
          - name: theme/
            note: 主题与组件（略）
---

<at-file-tree data-key="fileTree"></at-file-tree>
