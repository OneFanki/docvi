---
components:
  metricRow:
    kind: metric-row
    title: 服务性能指标（对照改造前基线）
    items:
      - label: P95 响应时间
        value: '180'
        unit: ms
        delta: '−44%'
        trend: down
        tone: good
        note: 改造前 320ms
      - label: 错误率
        value: '0.02'
        unit: '%'
        delta: '−0.06pt'
        trend: down
        tone: good
        note: 上线首日统计
      - label: P99 接口耗时
        value: '610'
        unit: ms
        delta: '+12%'
        trend: up
        tone: warn
        note: 受冷启动影响
      - label: 慢查询次数
        value: '3'
        unit: 次/天
        delta: '+3'
        trend: up
        tone: bad
        note: 需关注索引覆盖
---

<at-metric-row data-key="metricRow"></at-metric-row>
