import { describe, expect, it, vi } from 'vitest'
import { Interceptor, type InterceptorOptions } from '../proxy/interceptor'
import { dispatchClientMessage } from '../proxy/dispatch'
import { ControlClient } from '../proxy/control-client'
import { redactPayload } from '../scanners/redaction'
import { DEFAULT_SETTINGS, type ApprovalRequest, type ApprovalResult } from '../shared/types'

const secret = 'sk-proj-' + 'A'.repeat(32)
const call = { jsonrpc: '2.0' as const, id: 'request-1', method: 'tools/call', params: { name: 'read_file', arguments: { content: secret } } }
function setup(mode: 'flag' | 'ask' | 'deny', approval: ApprovalResult | null = { id: 'a', effect: 'allow', scope: 'session' }) {
  const send = vi.fn()
  const toClient = vi.fn()
  const requestApproval = vi.fn(async (_request: ApprovalRequest) => approval)
  const interceptor = new Interceptor({ db: null, sessionId: 'session', server: { id: 's', name: 'server', client: 'cursor' },
    upstream: { send }, toClient, log() {}, control: { onConfig() {}, onToolPrefs() {}, send() {}, requestApproval }
  } as unknown as InterceptorOptions)
  Reflect.set(interceptor, 'settings', { ...DEFAULT_SETTINGS, strictActionApproval: false, defaultEffect: 'allow', credentialAction: mode, offlineAskFallback: 'allow' })
  Reflect.get(interceptor, 'sessionGrants').set('read_file', 'allow')
  return { interceptor, send, toClient, requestApproval }
}
describe('outgoing credential decisions', () => {
  it('requires a fresh once-only decision despite a session allow grant', async () => {
    const f = setup('ask')
    await f.interceptor.handleFromClient(call)
    await f.interceptor.handleFromClient({ ...call, id: 'request-2' })
    expect(f.requestApproval).toHaveBeenCalledTimes(2)
    expect(f.requestApproval.mock.calls[0]?.[0]).toMatchObject({ onceOnly: true })
    expect(f.send).toHaveBeenCalledWith(call)
  })
  it('blocks on no response even when the normal offline fallback allows', async () => {
    const f = setup('ask', null)
    await f.interceptor.handleFromClient(call)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.toClient.mock.calls[0]?.[0].error.message).toContain('possible credential')
  })
  it('denies without an approval and does not forward', async () => {
    const f = setup('deny')
    await f.interceptor.handleFromClient(call)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.requestApproval).not.toHaveBeenCalled()
  })
  it('leaves harmless calls and explicit flag-only mode under normal rules', async () => {
    const f = setup('flag')
    await f.interceptor.handleFromClient(call)
    expect(f.send).toHaveBeenCalledWith(call)
    const clean = setup('ask')
    await clean.interceptor.handleFromClient({ ...call, params: { name: 'read_file', arguments: { content: 'hello' } } })
    expect(clean.send).toHaveBeenCalledOnce()
    expect(clean.requestApproval).not.toHaveBeenCalled()
  })
})

describe('inspection errors', () => {
  it('returns the original string id without forwarding or leaking the exception', async () => {
    const reply = vi.fn()
    const log = vi.fn()
    const handle = vi.fn(async () => { throw new Error(secret) })
    await dispatchClientMessage(call, handle, reply, log)
    expect(handle).toHaveBeenCalledOnce()
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ id: call.id, error: { code: -32603 } })
    expect(JSON.stringify([reply.mock.calls, log.mock.calls])).not.toContain(secret)
  })
})

describe('redacted evidence', () => {
  it('preserves JSON keys and masks sensitive fields, tokens and whole private keys', () => {
    const raw = { token: 'short-secret', nested: { password: 'tiny', note: secret }, pem: '-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----' }
    const serialized = JSON.stringify(redactPayload(raw))
    expect(Object.keys(JSON.parse(serialized))).toEqual(['token', 'nested', 'pem'])
    for (const value of ['short-secret', 'tiny', secret, 'private-body']) expect(serialized).not.toContain(value)
    expect(raw.token).toBe('short-secret')
  })
  it('masks approval payloads before queueing control socket messages', () => {
    const control = new ControlClient(() => {})
    control.send({ t: 'approval.request', request: { id: 'approval', args: { token: secret }, findings: [] } } as never)
    const queued = Reflect.get(control, 'outbox') as string[]
    expect(queued[0]).not.toContain(secret)
    expect(JSON.parse(queued[0]!).request.id).toBe('approval')
  })
})

describe('strict action approval', () => {
  it('approves Alice once and blocks a later Bob send despite a reusable approval response', async () => {
    const f = setup('flag')
    Reflect.set(f.interceptor, 'settings', { ...DEFAULT_SETTINGS, offlineAskFallback: 'allow' })
    f.requestApproval.mockResolvedValueOnce({ id: 'a', effect: 'allow', scope: 'always' }).mockResolvedValueOnce(null)
    const email = (id: number, to: string) => ({ jsonrpc: '2.0' as const, id, method: 'tools/call', params: { name: 'send_email', arguments: { to, body: 'Synthetic test only' } } })
    await f.interceptor.handleFromClient(email(1, 'alice@example.test'))
    await f.interceptor.handleFromClient(email(2, 'bob@example.test'))
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.send.mock.calls[0]?.[0].params.arguments.to).toBe('alice@example.test')
    expect(f.requestApproval).toHaveBeenCalledTimes(2)
    expect(f.requestApproval.mock.calls.every(([request]) => request.onceOnly)).toBe(true)
    expect(f.toClient.mock.calls[0]?.[0]).toMatchObject({ id: 2, error: { code: -32001 } })
  })
  it('blocks unknown and read-named tools without an approval', async () => {
    const f = setup('flag', null)
    Reflect.set(f.interceptor, 'settings', DEFAULT_SETTINGS)
    for (const name of ['get_email', 'opaque_operation']) await f.interceptor.handleFromClient({ ...call, params: { name, arguments: {} } })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.requestApproval).toHaveBeenCalledTimes(2)
  })
  it('pause overrides a pending allow response', async () => {
    const f = setup('flag')
    Reflect.set(f.interceptor, 'settings', DEFAULT_SETTINGS)
    let resolve!: (result: ApprovalResult) => void
    f.requestApproval.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = f.interceptor.handleFromClient(call)
    Reflect.set(f.interceptor, 'settings', { ...DEFAULT_SETTINGS, pauseToolCalls: true })
    resolve({ id: 'a', effect: 'allow', scope: 'once' })
    await pending
    expect(f.send).not.toHaveBeenCalled()
    expect(f.toClient.mock.calls[0]?.[0].error.message).toContain('paused')
  })
  it('pause blocks new calls without prompting', async () => {
    const f = setup('flag')
    Reflect.set(f.interceptor, 'settings', { ...DEFAULT_SETTINGS, pauseToolCalls: true })
    await f.interceptor.handleFromClient(call)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.requestApproval).not.toHaveBeenCalled()
  })
})
