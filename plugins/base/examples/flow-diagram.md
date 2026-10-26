---
components:
  flowDiagram:
    kind: flow-diagram
    title: 静态站点构建管线
    nodes:
      - id: source
        label: 内容源（Markdown 目录）
        kind: start
        note: 任意目录 + 一份可选配置；构建的输入只有这些。
      - id: config
        label: 读取配置
        kind: step
        note: 解析 docs.config.yaml：树根声明、排除项、静态目录。
      - id: scan
        label: 扫描目录树
        kind: step
        note: 递归目录、收集 Markdown、自然排序，产出侧栏结构。
      - id: render
        label: 渲染页面
        kind: step
        note: Markdown → HTML，套上主题与交互组件。
      - id: build
        label: 产出静态站点
        kind: end
        note: 拷贝静态资源，得到可直接托管的 dist。
    edges:
      - from: source
        to: config
        label: 内容根
      - from: config
        to: scan
        label: 树根节点 / 排除项
      - from: scan
        to: render
        label: 页面清单
      - from: render
        to: build
        label: 含资源拷贝
---

<at-flow-diagram data-key="flowDiagram"></at-flow-diagram>
