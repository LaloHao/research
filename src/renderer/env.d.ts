/// <reference types="vite/client" />
import type { ResearchApi } from '../shared/ipc'

declare global {
  interface Window {
    research: ResearchApi
  }
}
