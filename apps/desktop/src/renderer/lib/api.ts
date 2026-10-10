import type { IpcApi, IpcChannel, MainEvent } from '@shared/ipc'

interface Bridge {
  invoke<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>): Promise<ReturnType<IpcApi[C]>>
  onEvent(handler: (event: MainEvent) => void): () => void
  onSync(handler: (progress: unknown) => void): () => void
}

declare global {
  interface Window {
    bridge: Bridge
  }
}

export const api = window.bridge

export function onEvent(handler: (event: MainEvent) => void): () => void {
  return window.bridge.onEvent(handler)
}
