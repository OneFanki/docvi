---
components:
  riskList:
    kind: risk-list
    title: 已知风险
    items:
      - risk: 切换与领取的互斥依赖数据行锁
        impact: 长时间锁等待会拉高接口耗时；极端情况下可能出现死锁。
        handling: 在隔离 MySQL 上用执行计划与竞争测试核实；不承诺无等待或无死锁。
        severity: medium
        tag: 并发
        handled: false
      - risk: 资源指纹随内容变化
        impact: 若不随内容变化，一年 immutable 缓存会挡住同版本更新。
        handling: 已用入口与样式的大小+修改时间算指纹，随 URL 下发。
        severity: high
        tag: 缓存
        handled: true
---

<at-risk-list data-key="riskList"></at-risk-list>
