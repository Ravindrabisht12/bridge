/** Result of an MCP handshake test, shared by main and renderer. */
export interface ProbeResult {
  ok: boolean
  error: string | null
  serverName: string | null
  serverVersion: string | null
  protocolVersion: string | null
  toolCount: number | null
  toolNames: string[]
  /** Whatever the server wrote to stderr — usually the real reason it failed. */
  stderr: string
  durationMs: number
}
