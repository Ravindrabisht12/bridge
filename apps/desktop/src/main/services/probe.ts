/**
 * Connection test for a configured server.
 *
 * "Did it work?" is the first question after installing anything, and today the
 * only way to answer it is to restart the AI client and see whether the server
 * goes red. This runs the same handshake the client would — `initialize` then
 * `tools/list` — directly against the target, and reports what came back.
 *
 * It deliberately bypasses the Bridge proxy. The question being asked is
 * "does this server work", not "does the proxy work", and mixing the two would
 * make a failure ambiguous.
 */
import { spawn } from 'node:child_process'
import { LineDecoder, encodeFrame, parseFrame, type JsonRpcMessage } from '@shared/jsonrpc'
import type { UpstreamTarget } from '@shared/types'
import type { ProbeResult } from '@shared/probe'

export type { ProbeResult }

const TIMEOUT_MS = 20_000

/** Digs the errno out of a fetch failure, however deeply undici buried it. */
function errnoOf(err: unknown, depth = 0): string | null {
  if (!err || depth > 5) return null
  const e = err as { code?: string; cause?: unknown; errors?: unknown[] }
  if (typeof e.code === 'string') return e.code
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) {
      const found = errnoOf(inner, depth + 1)
      if (found) return found
    }
  }
  return errnoOf(e.cause, depth + 1)
}

const fail = (error: string, startedAt: number, stderr = ''): ProbeResult => ({
  ok: false,
  error,
  serverName: null,
  serverVersion: null,
  protocolVersion: null,
  toolCount: null,
  toolNames: [],
  stderr,
  durationMs: Date.now() - startedAt
})

async function probeStdio(target: Extract<UpstreamTarget, { kind: 'stdio' }>): Promise<ProbeResult> {
  const startedAt = Date.now()

  return new Promise<ProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(target.command, target.args, {
        cwd: target.cwd,
        env: { ...process.env, ...target.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err) {
      resolve(fail(`Could not start "${target.command}": ${(err as Error).message}`, startedAt))
      return
    }

    let stderr = ''
    let settled = false
    const decoder = new LineDecoder()
    const seen = new Map<number, JsonRpcMessage & { result?: any; error?: any }>()

    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 1500).unref?.()
      } catch {
        /* already gone */
      }
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish(
        fail(
          'The server did not complete the MCP handshake within 20 seconds. It may be waiting on input, downloading, or missing a required value.',
          startedAt,
          stderr.slice(-2000)
        )
      )
    }, TIMEOUT_MS)

    child.on('error', (err) => {
      const hint =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `"${target.command}" is not installed or not on PATH.`
          : err.message
      finish(fail(hint, startedAt, stderr.slice(-2000)))
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })

    child.on('exit', (code) => {
      if (settled) return
      finish(
        fail(
          `The server exited with code ${code} before completing the handshake.`,
          startedAt,
          stderr.slice(-2000)
        )
      )
    })

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      let lines: string[]
      try {
        lines = decoder.push(chunk)
      } catch {
        return
      }
      for (const line of lines) {
        const msg = parseFrame(line)
        if (!msg || !('id' in msg)) continue
        seen.set(Number(msg.id), msg as never)

        if (Number(msg.id) === 1) {
          // Handshake accepted; the protocol requires this before tools/list.
          child.stdin?.write(encodeFrame({ jsonrpc: '2.0', method: 'notifications/initialized' }))
          child.stdin?.write(encodeFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))
        }

        if (seen.has(2)) {
          const init = seen.get(1)
          const list = seen.get(2)
          if (list?.error) {
            finish({
              ok: false,
              error: `The server rejected tools/list: ${list.error.message}`,
              serverName: init?.result?.serverInfo?.name ?? null,
              serverVersion: init?.result?.serverInfo?.version ?? null,
              protocolVersion: init?.result?.protocolVersion ?? null,
              toolCount: null,
              toolNames: [],
              stderr: stderr.slice(-2000),
              durationMs: Date.now() - startedAt
            })
            return
          }
          const tools: Array<{ name: string }> = list?.result?.tools ?? []
          finish({
            ok: true,
            error: null,
            serverName: init?.result?.serverInfo?.name ?? null,
            serverVersion: init?.result?.serverInfo?.version ?? null,
            protocolVersion: init?.result?.protocolVersion ?? null,
            toolCount: tools.length,
            toolNames: tools.slice(0, 12).map((t) => t.name),
            stderr: stderr.slice(-2000),
            durationMs: Date.now() - startedAt
          })
        }
      }
    })

    child.stdin?.on('error', () => undefined)
    child.stdin?.write(
      encodeFrame({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bridge-probe', version: '1.0.0' }
        }
      })
    )
  })
}

async function probeHttp(target: Extract<UpstreamTarget, { kind: 'http' }>): Promise<ProbeResult> {
  const startedAt = Date.now()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)

  const post = async (body: unknown, sessionId?: string | null): Promise<Response> =>
    fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...target.headers,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {})
      },
      body: JSON.stringify(body),
      signal: abort.signal
    })

  /** A single JSON-RPC reply, whether the server answers as JSON or as SSE. */
  const readReply = async (res: Response): Promise<any> => {
    const type = res.headers.get('content-type') ?? ''
    const text = await res.text()
    if (!type.includes('text/event-stream')) return text.trim() ? JSON.parse(text) : null
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n')
      if (data) return JSON.parse(data)
    }
    return null
  }

  try {
    const initRes = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'bridge-probe', version: '1.0.0' }
      }
    })

    if (initRes.status === 401 || initRes.status === 403) {
      return fail(
        `The server refused the connection (HTTP ${initRes.status}). It needs credentials, or the ones supplied are not accepted.`,
        startedAt
      )
    }
    if (!initRes.ok) {
      return fail(`HTTP ${initRes.status} ${initRes.statusText} from ${target.url}`, startedAt)
    }

    const sessionId = initRes.headers.get('mcp-session-id')
    const init = await readReply(initRes)
    if (init?.error) return fail(`The server rejected initialize: ${init.error.message}`, startedAt)

    const listRes = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId)
    const list = listRes.ok ? await readReply(listRes) : null
    const tools: Array<{ name: string }> = list?.result?.tools ?? []

    return {
      ok: true,
      error: null,
      serverName: init?.result?.serverInfo?.name ?? null,
      serverVersion: init?.result?.serverInfo?.version ?? null,
      protocolVersion: init?.result?.protocolVersion ?? null,
      toolCount: list?.result?.tools ? tools.length : null,
      toolNames: tools.slice(0, 12).map((t) => t.name),
      stderr: '',
      durationMs: Date.now() - startedAt
    }
  } catch (err) {
    // `fetch failed` on its own tells the user nothing, so name the host and
    // the underlying cause. undici nests it, sometimes inside an AggregateError,
    // so walk the chain rather than reading one level.
    const cause = errnoOf(err)
    const host = (() => {
      try {
        return new URL(target.url).host
      } catch {
        return target.url
      }
    })()
    const message = abort.signal.aborted
      ? `${host} did not respond within 20 seconds.`
      : cause === 'ENOTFOUND'
        ? `${host} could not be resolved — check the URL.`
        : cause === 'ECONNREFUSED'
          ? `${host} refused the connection — is the server running?`
          : cause === 'CERT_HAS_EXPIRED' || cause === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
            ? `${host} has a TLS certificate problem (${cause}).`
            : `Could not reach ${host}${cause ? ` (${cause})` : ''}: ${(err as Error).message}`
    return fail(message, startedAt)
  } finally {
    clearTimeout(timer)
  }
}

export function probeTarget(target: UpstreamTarget): Promise<ProbeResult> {
  return target.kind === 'http' ? probeHttp(target) : probeStdio(target)
}
