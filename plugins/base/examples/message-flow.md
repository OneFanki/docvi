---
components:
  messageFlow:
    kind: message-flow
    title: 创建订单的请求时序
    participants:
      - id: browser
        label: 浏览器
      - id: gateway
        label: 网关
      - id: app
        label: 应用服务
    messages:
      - from: browser
        to: gateway
        label: POST /orders
        note: 创建订单请求到达网关。
      - from: gateway
        to: app
        label: 转发 + 鉴权
        note: 网关校验登录态，附上用户标识后转发。
      - from: app
        to: browser
        label: 201 Created
        kind: return
        note: 返回订单 ID 与初始状态 pending。
---

<at-message-flow data-key="messageFlow"></at-message-flow>
