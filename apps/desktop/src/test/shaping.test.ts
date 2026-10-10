import { describe, expect, it, vi } from 'vitest'
import { RepeatTracker, REPEAT_THRESHOLD, stableStringify, trimResult } from '@shared/shaping'
import { Interceptor, type InterceptorOptions } from '../proxy/interceptor'

const text = (t: string) => ({ type: 'text', text: t })

describe('result trimming', () => {
  it('leaves a result under the limit alone', () => {
    const result = { content: [text('short')] }
    expect(trimResult(result, 100)).toMatchObject({ changed: false, value: result })
  })

  it('is off at 0', () => {
    expect(trimResult({ content: [text('x'.repeat(10_000))] }, 0).changed).toBe(false)
  })

  it('cuts text to the budget, keeps images and structuredContent, and says what it did', () => {
    const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
    const result = { content: [text('a'.repeat(300)), image, text('b'.repeat(300))], structuredContent: { rows: 3 } }
    const out = trimResult(result, 100) // 400 chars
    expect(out.changed).toBe(true)
    expect(out.fromTokens).toBe(150)
    const value = out.value as { content: Array<{ type: string; text?: string }>; structuredContent: unknown }
    expect(value.structuredContent).toEqual({ rows: 3 })
    expect(value.content[1]).toBe(image)
    expect(value.content[0]?.text).toHaveLength(300)
    expect(value.content[2]?.text).toHaveLength(100)
    expect(value.content.at(-1)?.text).toMatch(/trimmed this result from about 150 to 100 tokens.*narrower query/)
  })

  it('prefers to cut on a line break near the limit', () => {
    const body = `${'x'.repeat(370)}\n${'y'.repeat(200)}`
    const out = trimResult({ content: [text(body)] }, 100)
    expect((out.value as { content: Array<{ text: string }> }).content[0]?.text).toBe('x'.repeat(370))
  })

  it('drops whole text blocks past the budget and counts them', () => {
    const out = trimResult({ content: [text('a'.repeat(400)), text('b'), text('c')] }, 100)
    expect((out.value as { content: Array<{ text: string }> }).content.at(-1)?.text).toMatch(/dropping 2 later text blocks/)
  })

  it('does not touch a result with no content array', () => {
    expect(trimResult({ toolResult: 'x'.repeat(10_000) }, 10).changed).toBe(false)
  })
})

describe('repeat tracking', () => {
  it('ignores key order in arguments', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('counts only while both the arguments and the result stay the same', () => {
    const t = new RepeatTracker()
    expect(t.observe('status', { id: 1 }, 'pending')).toBe(1)
    expect(t.observe('status', { id: 1 }, 'pending')).toBe(2)
    expect(t.observe('status', { id: 1 }, 'done')).toBe(1)
    expect(t.observe('status', { id: 2 }, 'done')).toBe(1)
    expect(t.observe('status', { id: 1 }, 'done')).toBe(2)
  })
})

describe('interceptor shaping', () => {
  function fixture(settings: Record<string, unknown>) {
    const toClient = vi.fn()
    const sent: unknown[] = []
    const interceptor = new Interceptor({
      db: null, server: { id: 's', name: 'test', client: 'cursor' }, sessionId: 'session',
      control: { onConfig() {}, onToolPrefs() {}, send: (m: unknown) => sent.push(m), requestApproval: vi.fn() },
      upstream: { send() {} }, toClient, log() {}
    } as unknown as InterceptorOptions)
    Reflect.set(interceptor, 'settings', { ...Reflect.get(interceptor, 'settings'), strictActionApproval: false, defaultEffect: 'allow', ...settings })
    const run = async (id: number, result: unknown) => {
      await interceptor.handleFromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: { q: 'x' } } })
      interceptor.handleFromServer({ jsonrpc: '2.0', id, result } as never)
      return { toModel: toClient.mock.calls.at(-1)?.[0].result, recorded: (sent.at(-1) as { call: { result: unknown; shaping: unknown } }).call }
    }
    return { run }
  }

  it('sends the model a trimmed result and keeps the full one in the trace', async () => {
    const f = fixture({ maxResultTokens: 10, annotateRepeats: false })
    const full = { content: [text('z'.repeat(400))] }
    const { toModel, recorded } = await f.run(1, full)
    expect(toModel.content[0].text).toHaveLength(40)
    expect(recorded.result).toEqual(full)
    expect(recorded.shaping).toEqual({ trimmedFromTokens: 100, deliveredTokens: 10 })
  })

  it('adds a note on the third identical call with an identical result', async () => {
    const f = fixture({ maxResultTokens: 0, annotateRepeats: true })
    const same = { content: [text('no results')] }
    for (let i = 1; i < REPEAT_THRESHOLD; i++) {
      const { toModel, recorded } = await f.run(i, same)
      expect(toModel.content).toHaveLength(1)
      expect(recorded.shaping).toBeNull()
    }
    const { toModel, recorded } = await f.run(REPEAT_THRESHOLD, same)
    expect(toModel.content.at(-1).text).toMatch(/call 3 in a row to "search"/)
    expect(recorded.shaping).toEqual({ repeatCount: 3 })
  })

  it('leaves error results alone', async () => {
    const f = fixture({ maxResultTokens: 1, annotateRepeats: true })
    const error = { isError: true, content: [text('boom '.repeat(50))] }
    const { toModel } = await f.run(1, error)
    expect(toModel).toEqual(error)
  })
})
