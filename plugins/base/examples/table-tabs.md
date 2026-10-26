---
components:
  tableTabs:
    kind: table-tabs
    title: 订单系统表设计
    tables:
      - name: orders
        cn: 订单
        note: '订单主表：一次交易的根，金额与状态在此维护。'
        fields:
          - { name: 'id', cn: '主键', type: 'bigint', key: 'PK', note: '全局有序 ID' }
          - { name: 'user_id', cn: '下单用户', type: 'bigint', key: 'FK', note: '关联用户中心' }
          - { name: 'status', cn: '状态', type: 'varchar(16)', key: '索引', note: 'pending/paid/shipped/done/canceled' }
          - { name: 'amount', cn: '订单金额', type: 'decimal(10,2)', note: '下单时快照，不随商品调价变化' }
          - { name: 'pay_channel', cn: '支付渠道', type: 'varchar(16)', note: '支付回调确认时写入（wechat/alipay）' }
          - { name: 'paid_at', cn: '支付时间', type: 'datetime', note: '未支付时为 NULL' }
          - { name: 'created_at', cn: '创建时间', type: 'datetime', key: '索引', note: '按天统计的基准列' }
      - name: order_items
        cn: 订单项
        note: '订单里的商品行：数量与成交价快照。'
        fields:
          - { name: 'id', cn: '主键', type: 'bigint', key: 'PK' }
          - { name: 'order_id', cn: '所属订单', type: 'bigint', key: 'FK', note: '订单删除时级联清理' }
          - { name: 'product_id', cn: '商品', type: 'bigint', key: 'FK' }
          - { name: 'quantity', cn: '数量', type: 'int', note: '下单时的数量' }
          - { name: 'price', cn: '成交价', type: 'decimal(10,2)', note: '下单时的价格快照' }
          - { name: 'created_at', cn: '创建时间', type: 'datetime' }
    relations:
      - { from: 'orders', to: 'order_items', label: 'order_id 外键：一个订单多条订单项（一对多）' }
      - { from: 'order_items', to: 'products', label: 'product_id 外键：商品被订单项引用' }
---

<at-table-tabs data-key="tableTabs"></at-table-tabs>
