---
components:
  stateFlow:
    kind: state-flow
    title: 订单状态机
    states:
      - id: pending
        label: 待支付
        kind: start
        note: 下单成功、等待付款；超时后自动取消。
      - id: paid
        label: 已支付
        note: 支付回调确认后进入，等待发货。
      - id: shipped
        label: 已发货
        note: 物流单号已生成，等待收货。
      - id: done
        label: 已完成
        kind: end
        note: 确认收货后归档。
      - id: canceled
        label: 已取消
        kind: error
        note: 超时未支付，或用户主动取消。
    transitions:
      - { from: 'pending', to: 'paid', label: '支付成功' }
      - { from: 'pending', to: 'canceled', label: '超时 / 主动取消' }
      - { from: 'paid', to: 'shipped', label: '发货' }
      - { from: 'shipped', to: 'done', label: '确认收货' }
    current: paid
---

<at-state-flow data-key="stateFlow"></at-state-flow>
