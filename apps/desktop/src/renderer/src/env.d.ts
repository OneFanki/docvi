/// <reference types="vite/client" />

import type { DocviApi } from '@docvi/shared'

declare global {
  interface Window {
    docvi: DocviApi
  }
}

export {}
