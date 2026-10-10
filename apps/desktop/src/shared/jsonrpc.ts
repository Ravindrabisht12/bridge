/** Minimal JSON-RPC 2.0 types plus the newline-delimited framing MCP stdio uses. */

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: any
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: any
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: any
  error?: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** Bridge-specific: the call was blocked by policy. */
  PolicyDenied: -32001,
  /** Bridge-specific: the approval prompt expired. */
  ApprovalTimeout: -32002
} as const

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m && m.id !== undefined && m.id !== null
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m)
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !('method' in m) && 'id' in m
}

/**
 * Accumulates raw stdio chunks and emits complete newline-delimited messages.
 * MCP forbids embedded newlines in a stdio frame, so a line is a whole message.
 */
export class LineDecoder {
  private buffer = ''

  constructor(private readonly maxLineBytes = 32 * 1024 * 1024) {}

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = ''
      throw new Error('JSON-RPC frame exceeded maximum size; buffer discarded')
    }
    const out: string[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim().length > 0) out.push(line)
    }
    return out
  }

  /** Any trailing bytes left when the stream closes without a final newline. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [rest] : []
  }
}

export function encodeFrame(msg: JsonRpcMessage): string {
  return JSON.stringify(msg) + '\n'
}

export function parseFrame(line: string): JsonRpcMessage | null {
  try {
    const parsed = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && parsed.jsonrpc === '2.0') return parsed
    return null
  } catch {
    return null
  }
}
