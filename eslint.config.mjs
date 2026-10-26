import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * 仓库级 lint 口径：只拦真实缺陷与硬约束，风格归 prettier。
 *
 * 分层：
 * - scripts/ deployer/ 与构建配置：Node 环境
 * - apps/desktop/src/renderer/：浏览器环境（禁止 Node 与 electron，禁止反向依赖主进程）
 * - apps/desktop/src/service/：Node 环境，只复用 Markdown 文本管线
 * - plugins/：浏览器环境，Vue SFC，只允许依赖 vue
 *
 * 存量债：`no-explicit-any` 在渲染层为 warn，由 scripts/lint.mjs 的基线棘轮
 * 控制——新增 any 会让 lint 失败，存量只能减不能增。
 */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/dist-*/**',
  'packages/*/release/**',
  // docvi 桌面应用构建产物（electron-vite 输出 main/preload/renderer）
  'apps/desktop/out/**',
  // docvi 安装包产物（electron-builder 输出，win-unpacked 里是解包后的第三方 bundle）
  // release-*/ 是向独立目录出包时用的（运行中的实例会锁住 release/win-unpacked）
  'apps/desktop/release/**',
  'apps/desktop/release-*/**',
  'apps/desktop/build/**',
  'courses/**',
  '.temp/**',
  'data/**',
  'deployer/data/**',
]

export default tseslint.config(
  { ignores: IGNORES },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Electron preload 必须是 CommonJS（sandbox 模式只加载 CJS）
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 构建配置与 Node 侧脚本可以自由使用 Node 内置模块与 any（配置对象形态多变）
    files: ['**/*.config.ts', '**/*.config.mjs', 'scripts/**/*.ts', 'deployer/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      globals: { ...globals.browser },
    },
    rules: {
      // 组件包是自包含视图，单文件允许协议 kind 对应的单词组件名
      'vue/multi-word-component-names': 'off',
    },
  },
  {
    files: ['plugins/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/desktop/**', '**/packages/server/**', 'node:*'],
              message: '插件包只允许依赖 vue（peerDependency），禁止访问宿主内部',
            },
          ],
        },
      ],
    },
  },
  prettier,
)
