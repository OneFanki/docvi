---
components:
  timeline:
    kind: timeline
    title: 一次功能迭代的排程
    items:
      - { time: 'W1', title: '需求评审', status: 'done', note: '确认范围与验收口径。' }
      - { time: 'W2–W3', title: '开发实现', status: 'done' }
      - { time: 'W4', title: '测试与修复', status: 'warn', note: '发现 2 个阻塞缺陷，当天修复。' }
      - { time: 'W5', title: '灰度发布', status: 'active', note: '10% 流量观察一周。' }
      - { time: 'W6', title: '全量发布', status: 'todo' }
---

<at-timeline data-key="timeline"></at-timeline>
