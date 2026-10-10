import { contextBridge, ipcRenderer } from 'electron'
import { MAIN_EVENT_CHANNEL, type IpcApi, type IpcChannel, type MainEvent } from '@shared/ipc'

/**
 * The renderer is sandboxed and has no Node access; this is the entire surface
 * it can reach. Every call is a named, typed channel — no dynamic eval path.
 */
const api = {
  invoke<C extends IpcChannel>(channel: C, ...args: Parameters<IpcApi[C]>): Promise<ReturnType<IpcApi[C]>> {
    return ipcRenderer.invoke(channel, ...args) as Promise<ReturnType<IpcApi[C]>>
  },
  onSync(handler: (progress: unknown) => void): () => void {
    const listener = (_e: unknown, payload: unknown): void => handler(payload)
    ipcRenderer.on('bridge:sync', listener)
    return () => ipcRenderer.off('bridge:sync', listener)
  },
  onEvent(handler: (event: MainEvent) => void): () => void {
    const listener = (_e: unknown, payload: MainEvent): void => handler(payload)
    ipcRenderer.on(MAIN_EVENT_CHANNEL, listener)
    return () => ipcRenderer.off(MAIN_EVENT_CHANNEL, listener)
  }
}

contextBridge.exposeInMainWorld('bridge', api)

export type BridgeApi = typeof api
