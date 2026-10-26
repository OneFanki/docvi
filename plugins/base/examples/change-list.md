---
components:
  changeList:
    kind: change-list
    title: 本次改动
    items:
      - title: 目录树排序采用自然序
        summary: 01-/02- 前缀即可获得稳定顺序，不必额外维护排序字段。
        modules: [shell, scan-docs]
        kind: add
      - title: 移除 VitePress 时代的路由层
        summary: 站点改由自研壳渲染，链接与索引统一从内容根现读。
        modules: [shell, deployer]
        kind: remove
---

<at-change-list data-key="changeList"></at-change-list>
