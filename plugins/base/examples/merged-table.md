# 合并单元格表格示例

原生 Markdown 表达不了合并单元格，用 `::: merged` 块补充：

::: merged
title: 发布节奏
columns: [阶段, 负责人, 状态]
caption: 阶段跨多行时用 rowspan 合并。
rows:

- [{ cell: 设计, rowspan: 2 }, 张三, 已完成]
- [李四, 进行中]
- [{ cell: 开发, rowspan: 2, head: true }, 王五, 已完成]
- [{ cell: 联调, colspan: 2 }, 未开始]
:::