---
components:
  tableGraph:
    kind: table-graph
    title: 订单系统表关系
    tables:
      - id: order_items
        name: order_items
        cn: 订单项
        note: '订单里的商品行：外键指向订单。'
        fields:
          - { name: 'id', cn: '主键', type: 'bigint', key: 'PK' }
          - { name: 'order_id', cn: '所属订单', type: 'bigint', key: 'FK' }
          - { name: 'quantity', cn: '数量', type: 'int' }
      - id: orders
        name: orders
        cn: 订单
        note: '订单主表：金额与状态在此维护，外键指向用户。'
        fields:
          - { name: 'id', cn: '主键', type: 'bigint', key: 'PK' }
          - { name: 'user_id', cn: '下单用户', type: 'bigint', key: 'FK' }
          - { name: 'status', cn: '状态', type: 'varchar(16)', key: '索引' }
      - id: users
        name: users
        cn: 用户
        note: '账号主数据：本页只作被引用的上游示意。'
        fields:
          - { name: 'id', cn: '主键', type: 'bigint', key: 'PK' }
          - { name: 'name', cn: '用户名', type: 'varchar(64)', key: 'UK' }
    relations:
      - { from: 'order_items', fromField: 'order_id', to: 'orders', toField: 'id', label: '一个订单多条订单项' }
      - { from: 'orders', fromField: 'user_id', to: 'users', toField: 'id', label: '一个用户多条订单' }
---

<at-table-graph data-key="tableGraph"></at-table-graph>
