/// <reference types="vite/client" />

import type { DocviApi } from '@docvi/shared'

declare global {
  interface Window {
    docvi: DocviApi
  }

  /** 构建期注入的版本号（vite.web.config.ts 的 define；容器版 appInfo 用） */
  const __DOCVI_VERSION__: string
}

export {}
