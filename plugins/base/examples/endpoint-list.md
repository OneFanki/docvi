---
components:
  endpointList:
    kind: endpoint-list
    title: 订单系统接口清单
    endpoints:
      - method: GET
        path: /api/orders
        summary: '订单列表：按状态筛选、分页排序'
        auth: 登录
        params:
          - {
              name: 'status',
              in: 'query',
              type: 'string',
              desc: '按订单状态筛选（pending/paid/cancelled），缺省返回全部',
            }
          - { name: 'page', in: 'query', type: 'number', desc: '页码，缺省 1' }
        response:
          - { name: 'items', type: 'OrderBrief[]', desc: '订单摘要列表（不含订单项明细）' }
          - { name: 'total', type: 'number', desc: '符合筛选的总条数，供分页器使用' }
        invariants:
          - '只返回当前登录用户的订单：用户维度在服务端强制过滤，不信任入参'
      - method: POST
        path: /api/orders
        summary: '创建订单：校验并锁定库存，金额以服务端快照为准'
        auth: 登录
        params:
          - {
              name: 'items',
              in: 'body',
              type: 'OrderItemInput[]',
              required: true,
              desc: '订单项（商品 ID + 数量）；同一商品重复出现会被合并',
            }
          - { name: 'remark', in: 'body', type: 'string', desc: '买家备注，上限 200 字' }
        response:
          - { name: 'orderId', type: 'bigint', desc: '新订单 ID' }
          - { name: 'status', type: 'string', desc: '初始状态恒为 pending' }
        invariants:
          - '金额只由服务端计算：客户端提交的价格字段不参与结算'
          - statement: '库存不足时整单拒绝（不部分成交、不超卖）'
            kind: must-not
      - method: POST
        path: /api/orders/:id/pay
        summary: '发起支付：返回支付网关跳转参数'
        auth: 登录
        deprecated: true
        note: '已由 /api/payments 收银台替代（统一多支付渠道）；保留仅为存量客户端兼容，新调用不要接入。'
---

<at-endpoint-list data-key="endpointList"></at-endpoint-list>
