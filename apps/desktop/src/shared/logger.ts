import { redactPayload } from '../scanners/redaction'
import { appendFileSync } from 'node:fs'
import { ensurePrivateDir } from './private-fs'
import { join } from 'node:path'
import { bridgeHome } from './control'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

/**
 * Appends to a per-component log file. Proxy processes must never write to
 * stdout — that channel carries JSON-RPC — so every diagnostic goes here.
 */
export class FileLogger {
  private readonly path: string
  private readonly min: number

  constructor(name: string, level: LogLevel = (process.env.BRIDGE_LOG_LEVEL as LogLevel) || 'info') {
    const dir = join(bridgeHome(), 'logs')
    try {
      // Logs name tools, servers and arguments; keep them to this user.
      ensurePrivateDir(bridgeHome())
      ensurePrivateDir(dir)
    } catch {
      /* logging must never throw */
    }
    this.path = join(dir, `${name}.log`)
    this.min = ORDER[level] ?? 1
  }

  private write(level: LogLevel, msg: string): void {
    if (ORDER[level] < this.min) return
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redactPayload(msg)}\n`
    try {
      appendFileSync(this.path, line)
    } catch {
      /* ignore */
    }
  }

  debug(msg: string): void {
    this.write('debug', msg)
  }
  info(msg: string): void {
    this.write('info', msg)
  }
  warn(msg: string): void {
    this.write('warn', msg)
  }
  error(msg: string): void {
    this.write('error', msg)
  }
}
