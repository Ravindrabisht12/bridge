import type { JsonRpcMessage } from '@shared/jsonrpc'

export interface UpstreamTransport {
  start(): Promise<void>
  send(msg: JsonRpcMessage): void
  onMessage(cb: (msg: JsonRpcMessage) => void): void
  onLog(cb: (line: string) => void): void
  onClose(cb: (info: { code: number | null; reason?: string }) => void): void
  close(): Promise<void>
}
