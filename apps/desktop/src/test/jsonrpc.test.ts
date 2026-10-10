import { describe, expect, it } from 'vitest'
import { LineDecoder, encodeFrame, isNotification, isRequest, isResponse, parseFrame } from '@shared/jsonrpc'

describe('LineDecoder', () => {
  it('reassembles messages split across chunks', () => {
    const d = new LineDecoder()
    expect(d.push('{"jsonrpc":"2.0",')).toEqual([])
    expect(d.push('"id":1,"method":"ping"}\n')).toEqual(['{"jsonrpc":"2.0","id":1,"method":"ping"}'])
  })

  it('emits several messages arriving in one chunk', () => {
    const d = new LineDecoder()
    expect(d.push('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('tolerates CRLF and blank lines', () => {
    const d = new LineDecoder()
    expect(d.push('{"a":1}\r\n\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('returns trailing bytes on flush', () => {
    const d = new LineDecoder()
    d.push('{"a":1}')
    expect(d.flush()).toEqual(['{"a":1}'])
  })

  it('refuses to buffer unbounded input', () => {
    const d = new LineDecoder(16)
    expect(() => d.push('x'.repeat(32))).toThrow(/maximum size/)
  })
})

describe('framing helpers', () => {
  it('round-trips a message', () => {
    const msg = { jsonrpc: '2.0' as const, id: 7, method: 'tools/call' }
    expect(parseFrame(encodeFrame(msg).trim())).toEqual(msg)
  })

  it('rejects non-JSON-RPC payloads', () => {
    expect(parseFrame('not json')).toBeNull()
    expect(parseFrame('{"hello":true}')).toBeNull()
  })

  it('classifies message kinds', () => {
    expect(isRequest({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe(true)
    expect(isNotification({ jsonrpc: '2.0', method: 'x' })).toBe(true)
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true)
    expect(isRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false)
  })
})
