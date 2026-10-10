import { describe, expect, it, vi } from 'vitest'
import { Interceptor } from '../proxy/interceptor'
import type { InterceptorOptions } from '../proxy/interceptor'
import type { ApprovalResult } from '../shared/types'

function fixture() {
  let answer!: (value: ApprovalResult) => void
  const approval = vi.fn(() => new Promise<ApprovalResult>((resolve) => { answer = resolve }))
  const send = vi.fn()
  const interceptor = new Interceptor({
    db: null, server: { id: 's', name: 'test', client: 'cursor' }, sessionId: 'session',
    control: { onConfig() {}, onToolPrefs() {}, send() {}, requestApproval: approval },
    upstream: { send }, toClient() {}, log() {}
  } as unknown as InterceptorOptions)
  const settings = Reflect.get(interceptor, 'settings')
  Reflect.set(interceptor, 'settings', { ...settings, strictActionApproval: false, defaultEffect: 'ask', askOnToolChange: true })
  return { interceptor, send, approval, answer: () => answer({ id: 'approval', effect: 'allow', scope: 'once' }) }
}
const call = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'write_file' } }

describe('approval lifecycle', () => {
  it('requires fresh approval after drift despite a session grant', async () => {
    const f = fixture()
    Reflect.get(f.interceptor, 'sessionGrants').set('write_file', 'allow')
    Reflect.get(f.interceptor, 'unacknowledgedChanges').add('write_file')
    const work = f.interceptor.handleFromClient(call)
    expect(f.approval).toHaveBeenCalledOnce()
    expect(f.send).not.toHaveBeenCalled()
    f.answer()
    await work
    expect(f.send).toHaveBeenCalledWith(call)
  })
  it('does not execute a call cancelled while approval was pending', async () => {
    const f = fixture()
    const work = f.interceptor.handleFromClient(call)
    await f.interceptor.handleFromClient({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    f.answer()
    await work
    expect(f.send.mock.calls.some(([message]) => message.method === 'tools/call')).toBe(false)
  })
  it('does not execute awaiting calls after upstream shutdown', async () => {
    const f = fixture()
    const work = f.interceptor.handleFromClient(call)
    f.interceptor.failAllPending('closed')
    f.answer()
    await work
    expect(f.send).not.toHaveBeenCalled()
  })
})
