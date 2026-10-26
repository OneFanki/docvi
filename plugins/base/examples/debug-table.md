---
components:
  debugTable:
    kind: debug-table
    title: 站点构建疑难排查
    rows:
      - {
          symptom: '全站白屏，控制台报 Failed to resolve import',
          cause: '内容根没有指向平台依赖的 node_modules，预打包解析不到依赖',
          fix: '让内容根链接平台的 node_modules（或直接在平台目录内启动）',
          severity: 'error',
          tag: '启动',
        }
      - {
          symptom: '侧栏某项缩进比同级多一级',
          cause: '该目录只有 README、无子项，被归入「隐式分组」渲染',
          fix: '给目录补 index.md（普通文档形态），或给它一个子页面',
          severity: 'warn',
          tag: '目录树',
        }
      - {
          symptom: '文档里的链接 404',
          cause: '旧单课程写法（/chapters/xx）在内容根化后必须带课程目录前缀',
          fix: '链接改为 /<课程目录>/chapters/xx；构建后用死链报告核对',
          severity: 'warn',
          tag: '链接',
        }
      - {
          symptom: '构建产物里打开静态 HTML 是空壳',
          cause: '该目录没在 docs.config.yaml 的 staticDirs 里声明，构建时被丢弃',
          fix: '把放资产的那一层目录声明进 staticDirs',
          severity: 'error',
          tag: '静态资源',
        }
      - {
          symptom: '改了主题样式但页面没变化',
          cause: '主题改动 HMR 不可靠，加上 dev 有两层缓存',
          fix: '清 .vitepress/cache 与 node_modules/.vite 后冷启动',
          severity: 'info',
          tag: '缓存',
        }
    filters:
      - {
          label: '环节',
          on: 'tag',
          options:
            [{ value: '启动' }, { value: '目录树' }, { value: '链接' }, { value: '静态资源' }, { value: '缓存' }],
        }
---

<at-debug-table data-key="debugTable"></at-debug-table>
