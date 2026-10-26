---
components:
  decisionCard:
    kind: decision-card
    title: 构建管线的设计决策
    decisions:
      - decision: 目录树排序采用自然序，而不是字典序
        reason: 字典序会把 page10 排在 page2 前面；自然序让数字段按数值比较。写教程时用 01-/02- 前缀即可获得稳定顺序，不必额外维护排序字段。
        evidence: 实现：sort.ts 的 naturalCompare（localeCompare + numeric）
        kind: why
      - decision: 不为「不在树里但可访问」的页面造第二套路由
        reason: 造两套路由会让链接与构建互相打架：同一路径两种行为，调试成本远高于收益。
        kind: avoid
---

<at-decision-card data-key="decisionCard"></at-decision-card>
