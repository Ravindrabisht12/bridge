import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { StdioTarget } from '@shared/types'
import { LineDecoder, encodeFrame, parseFrame, type JsonRpcMessage } from '@shared/jsonrpc'
import type { UpstreamTransport } from './types'

/** Runs the real MCP server as a child process and speaks stdio to it. */
export class StdioUpstream implements UpstreamTransport {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly decoder = new LineDecoder()
  private messageCb: (msg: JsonRpcMessage) => void = () => {}
  private logCb: (line: string) => void = () => {}
  private closeCb: (info: { code: number | null; reason?: string }) => void = () => {}
  private closed = false

  constructor(private readonly target: StdioTarget) {}

  async start(): Promise<void> {
    const child = spawn(this.target.command, this.target.args, {
      cwd: this.target.cwd,
      env: { ...process.env, ...this.target.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      let lines: string[]
      try {
        lines = this.decoder.push(chunk)
      } catch (err) {
        this.logCb(`framing error: ${(err as Error).message}`)
        return
      }
      for (const line of lines) {
        const msg = parseFrame(line)
        if (msg) this.messageCb(msg)
        else this.logCb(`unparsable frame from server: ${line.slice(0, 400)}`)
      }
    })

    // MCP servers use stderr for human logs; it must never reach the client.
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.logCb(chunk.trimEnd()))

    child.on('error', (err) => {
      this.logCb(`spawn error: ${err.message}`)
      if (!this.closed) {
        this.closed = true
        this.closeCb({ code: null, reason: err.message })
      }
    })

    child.on('exit', (code, signal) => {
      if (this.closed) return
      this.closed = true
      this.closeCb({ code, reason: signal ?? undefined })
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        child.off('spawn', onSpawn)
        reject(err)
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  send(msg: JsonRpcMessage): void {
    if (!this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(encodeFrame(msg))
  }

  onMessage(cb: (msg: JsonRpcMessage) => void): void {
    this.messageCb = cb
  }
  onLog(cb: (line: string) => void): void {
    this.logCb = cb
  }
  onClose(cb: (info: { code: number | null; reason?: string }) => void): void {
    this.closeCb = cb
  }

  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    if (!child || child.exitCode !== null) return
    child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
}
