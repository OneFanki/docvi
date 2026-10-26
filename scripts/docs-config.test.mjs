import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DOCS_CONFIG_FILENAME,
  loadDocsConfig,
  mergeConfigs,
  minimalConfigTemplate,
  resolveLaunchTarget,
  serializeAggregateConfig,
  toPosixPath,
} from './docs-config.mjs'

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'docvi-config-'))
}

test('loadDocsConfig 解析标题、侧栏、排除项与课程库', () => {
  const root = makeRoot()
  try {
    mkdirSync(join(root, '长期沉淀', '技术教程'), { recursive: true })
    mkdirSync(join(root, '技能'), { recursive: true })
    writeFileSync(
      join(root, 'docs.config.yaml'),
      [
        'title: 团队知识库',
        'description: 团队知识库',
        'sidebar:',
        '  - text: 长期沉淀',
        '    path: 长期沉淀',
        '    order: 10',
        '  - text: 过程记录',
        '    path: 过程记录/',
        'exclude:',
        '  - 技能/',
        '  - README.md',
        'deadLinks: strict',
      ].join('\n'),
    )

    const config = loadDocsConfig(root)
    assert.equal(config.title, '团队知识库')
    assert.equal(config.description, '团队知识库')
    assert.deepEqual(config.sidebar, [
      { text: '长期沉淀', path: '长期沉淀', order: 10, collapsed: null },
      { text: '过程记录', path: '过程记录', order: null, collapsed: null },
    ])
    assert.deepEqual(config.exclude, ['技能', 'README.md'])
    assert.equal(config.deadLinks, 'strict')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadDocsConfig 无配置返回 null', () => {
  const root = makeRoot()
  try {
    assert.equal(loadDocsConfig(root), null)
    writeFileSync(join(root, 'docs.config.yaml'), 'title: 空配置\n')
    assert.equal(loadDocsConfig(root).title, '空配置')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadDocsConfig 解析 staticDirs 并校验目录存在', () => {
  const root = makeRoot()
  try {
    mkdirSync(join(root, '静态教程'), { recursive: true })
    writeFileSync(
      join(root, 'docs.config.yaml'),
      ['title: 演示站', 'staticDirs:', '  - 静态教程/', 'exclude:', '  - 技能/'].join('\n'),
    )
    const config = loadDocsConfig(root)
    assert.deepEqual(config.staticDirs, ['静态教程'])

    writeFileSync(join(root, 'docs.config.yaml'), ['staticDirs:', '  - 不存在的目录'].join('\n'))
    assert.throws(() => loadDocsConfig(root), /staticDirs 不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('toPosixPath 归一化分隔符与首尾斜杠', () => {
  assert.equal(toPosixPath('长期沉淀\\技术教程/'), '长期沉淀/技术教程')
  assert.equal(toPosixPath('/a/b/'), 'a/b')
  assert.equal(toPosixPath('./x'), 'x')
})

// ── 启动目标解析（三形态） ──

test('resolveLaunchTarget：无目标无环境变量 → courses', () => {
  assert.deepEqual(resolveLaunchTarget({}), { mode: 'courses' })
  assert.deepEqual(resolveLaunchTarget({ target: '', envDocsRoot: '' }), { mode: 'courses' })
})

test('resolveLaunchTarget：目录目标 → standalone，缺配置报错并给模板', () => {
  const root = makeRoot()
  try {
    assert.match(resolveLaunchTarget({ target: root }).error, /docs\.config\.yaml/)
    assert.match(resolveLaunchTarget({ target: root }).error, /title: 我的文档站/)

    writeFileSync(join(root, DOCS_CONFIG_FILENAME), 'title: 外部站\n')
    const launch = resolveLaunchTarget({ target: root })
    assert.equal(launch.mode, 'standalone')
    assert.equal(launch.kind, 'dir')
    assert.equal(launch.dir, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveLaunchTarget：yaml 文件默认聚合，--standalone 切换', () => {
  const root = makeRoot()
  try {
    const yamlPath = join(root, 'my.config.yaml')
    writeFileSync(yamlPath, 'title: 外部站\n')
    const aggregated = resolveLaunchTarget({ target: yamlPath })
    assert.equal(aggregated.mode, 'aggregate')
    assert.equal(aggregated.kind, 'yaml')
    assert.equal(aggregated.dir, root)
    assert.equal(aggregated.yamlPath, yamlPath)

    const alone = resolveLaunchTarget({ target: yamlPath, standalone: true })
    assert.equal(alone.mode, 'standalone')

    assert.match(resolveLaunchTarget({ target: join(root, '不存在.yaml') }).error, /不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveLaunchTarget：DOCS_ROOT 环境变量等价于传目录', () => {
  const root = makeRoot()
  try {
    writeFileSync(join(root, DOCS_CONFIG_FILENAME), 'title: 外部站\n')
    const launch = resolveLaunchTarget({ envDocsRoot: root })
    assert.equal(launch.mode, 'standalone')
    assert.equal(launch.dir, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 聚合合并 ──

test('mergeConfigs：外部树根在前、内置垫底，路径加前缀，标题/导航外部优先', () => {
  const builtin = {
    config: {
      title: 'docvi 示例',
      description: '平台示例',
      nav: [{ text: '首页', link: '/' }],
      deadLinks: 'lenient',
      sidebar: [
        { text: '内建组件', path: 'component-showcase', order: 10, collapsed: null },
        { text: '示例课程', path: 'sample-course', order: 20, collapsed: null },
      ],
      exclude: ['snippets'],
      staticDirs: ['assets-html'],
    },
    prefix: 'built-in',
  }
  const external = {
    config: {
      title: '团队文档',
      description: '',
      nav: [],
      deadLinks: 'strict',
      sidebar: [{ text: '长期沉淀', path: '长期沉淀', order: 10, collapsed: null }],
      exclude: ['过程记录'],
      staticDirs: [],
    },
    prefix: 'external',
  }

  const merged = mergeConfigs({ builtin, external })
  assert.equal(merged.title, '团队文档')
  assert.equal(merged.description, '平台示例')
  assert.deepEqual(merged.nav, [{ text: '首页', link: '/' }])
  assert.equal(merged.deadLinks, 'strict')
  assert.deepEqual(
    merged.sidebar.map(entry => `${entry.text}:${entry.path}`),
    [
      '长期沉淀:external/长期沉淀',
      '内建组件:built-in/component-showcase',
      '示例课程:built-in/sample-course',
    ],
  )
  assert.deepEqual(merged.exclude, ['built-in/snippets', 'external/过程记录'])
  assert.deepEqual(merged.staticDirs, ['built-in/assets-html'])

  // 序列化后应能被 loadDocsConfig 读回（写盘往返一致；staticDirs 的存在性校验
  // 在真实链路里依赖已创建的链接，这里置空以隔离文件系统前提）
  const dir = makeRoot()
  try {
    writeFileSync(
      join(dir, DOCS_CONFIG_FILENAME),
      serializeAggregateConfig({ ...merged, staticDirs: [] }),
    )
    const reloaded = loadDocsConfig(dir)
    assert.equal(reloaded.title, '团队文档')
    assert.deepEqual(
      reloaded.sidebar.map(entry => entry.path),
      ['external/长期沉淀', 'built-in/component-showcase', 'built-in/sample-course'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mergeConfigs：外部未声明标题/导航时回退内置', () => {
  const merged = mergeConfigs({
    builtin: {
      config: {
        title: '内置标题',
        description: '内置描述',
        nav: [{ text: '首页', link: '/' }],
        deadLinks: 'lenient',
        sidebar: [],
        exclude: [],
        staticDirs: [],
      },
      prefix: 'built-in',
    },
    external: {
      config: {
        title: '',
        description: '',
        nav: [],
        deadLinks: 'lenient',
        sidebar: [{ text: '文档', path: '.', order: 10, collapsed: null }],
        exclude: [],
        staticDirs: [],
      },
      prefix: 'external',
    },
  })
  assert.equal(merged.title, '内置标题')
  assert.equal(merged.description, '内置描述')
  assert.deepEqual(merged.nav, [{ text: '首页', link: '/' }])
  assert.deepEqual(merged.sidebar, [
    { text: '文档', path: 'external/.', order: 10, collapsed: null },
  ])
})

test('minimalConfigTemplate 给出可直接照抄的最小 yaml', () => {
  assert.match(minimalConfigTemplate(), /title: 我的文档站/)
  assert.match(minimalConfigTemplate(), /path: \./)
})
