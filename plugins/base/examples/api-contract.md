---
components:
  apiContract:
    kind: api-contract
    title: 内容扫描器模块契约
    inputs:
      - name: 'scan(root, config)'
        type: ScanOptions
        description: '内容根与归一化配置（树根、排除项）；扫描器不读全局状态。'
      - name: readDocMeta(file)
        type: string
        description: '读取单个文档的标题与排序键（首个 H1 / frontmatter order），缺失时回退文件名。'
    outputs:
      - name: sidebar
        type: 'SidebarNode[]'
        description: '侧栏数组：每级节点带图标标记与链接（无落地页则为纯分组，不带链接）。'
      - name: pages
        type: 'string[]'
        description: '页面清单（相对路径，POSIX 形态），供死链检查与搜索索引复用。'
    invariants:
      - '同一输入必须产出同一棵树：扫描是纯处理，不依赖时间、顺序或环境'
      - statement: '同一页面路径不得出现在树的两个位置'
        kind: must-not
      - '排除项一处声明、两处生效：页面发现与文件监听同时遵守'
---

<at-api-contract data-key="apiContract"></at-api-contract>
