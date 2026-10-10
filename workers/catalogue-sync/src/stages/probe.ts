/**
 * Stage 3: verify that a curated endpoint is really the vendor's.
 *
 * Degrades. A failed probe leaves `verified_at` stale; it does not un-verify
 * anything, because a vendor having a bad afternoon is not evidence that they
 * never published the server.
 *
 * The key judgement here, and the one that makes the whole first-party claim
 * work: **an OAuth wall is a success.** A 401 from `mcp.notion.com` proves
 * there is a real MCP server behind it that Notion operates. Treating that as
 * a failure would leave almost every genuinely first-party entry unverified —
 * which is exactly backwards, since needing an account is a sign of a real
 * product rather than a hobby rebuild.
 */
import { publicFetch } from '../network'
import type { ProbeOutcome, ProbeResult } from '@bridge/types'
import type { Stage, StageContext } from '../stages'
import type { CatalogueStore, ProbeTarget } from '../store'

const TIMEOUT_MS = 15_000

/** Outcomes that prove the endpoint exists, and so may move `verified_at`. */
export const PROVES_EXISTENCE: ReadonlySet<ProbeOutcome> = new Set<ProbeOutcome>(['ok', 'auth-required'])

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-probe', version: '1.0.0' }
  }
}

export async function probeEndpoint(
  target: ProbeTarget,
  now: () => Date,
  fetchImpl: typeof fetch = publicFetch
): Promise<ProbeResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const base = { key: target.key, endpoint: target.endpoint, probedAt: now().toISOString() }

  try {
    const endpoint = new URL(target.endpoint)
    const domain = target.vendorDomain.toLowerCase()
    if (endpoint.protocol !== 'https:' || !(endpoint.hostname === domain || endpoint.hostname.endsWith('.' + domain))) {
      return { ...base, outcome: 'refused', detail: { reason: 'endpoint does not match curated vendor domain' } }
    }
    const res = await fetchImpl(target.endpoint, {
      redirect: 'error',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(INITIALIZE),
      signal: ctrl.signal
    })

    if (res.status === 401 && /Bearer\s/i.test(res.headers.get('www-authenticate') ?? '') && /resource_metadata=/i.test(res.headers.get('www-authenticate') ?? '')) {
      // Not a failure. See the note at the top of this file.
      return { ...base, outcome: 'auth-required', detail: { status: res.status } }
    }
    if (!res.ok) {
      return { ...base, outcome: 'refused', detail: { status: res.status } }
    }
    const text = await res.text()
    const messages = res.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()) : [text]
    const valid = messages.some((raw) => {
      try {
        const msg = JSON.parse(raw)
        return msg.jsonrpc === '2.0' && msg.id === INITIALIZE.id && typeof msg.result?.protocolVersion === 'string' &&
          typeof msg.result?.serverInfo?.name === 'string' && typeof msg.result?.capabilities === 'object'
      } catch { return false }
    })
    return { ...base, outcome: valid ? 'ok' : 'refused', detail: { status: res.status } }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    return {
      ...base,
      outcome: aborted ? 'timeout' : 'error',
      detail: { message: err instanceof Error ? err.message : String(err) }
    }
  } finally {
    clearTimeout(timer)
  }
}

export interface ProbeStageOptions {
  store: CatalogueStore
  fetchImpl?: typeof fetch
  /** Re-verify anything not confirmed within this window. */
  staleAfterDays?: number
  concurrency?: number
}

export function probeStage(opts: ProbeStageOptions): Stage {
  return {
    name: 'probe',
    async run(ctx: StageContext) {
      const days = opts.staleAfterDays ?? 30
      const staleBefore = new Date(ctx.now().getTime() - days * 86_400_000).toISOString()
      const targets = await opts.store.probeTargets(staleBefore)

      let fetched = 0
      let changed = 0
      const queue = [...targets]
      const worker = async (): Promise<void> => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          fetched++
          const result = await probeEndpoint(t, ctx.now, opts.fetchImpl)
          await opts.store.recordProbe(result)
          if (PROVES_EXISTENCE.has(result.outcome)) {
            await opts.store.setVerified(t.key, result.probedAt)
            changed++
          }
        }
      }
      // Deliberately low: these are other people's production endpoints.
      await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker))

      ctx.log(`probe: ${changed} of ${fetched} confirmed`)
      return { fetched, added: 0, changed, removed: 0, error: null }
    }
  }
}
