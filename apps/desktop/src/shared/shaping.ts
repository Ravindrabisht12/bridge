/**
 * Changes Bridge makes to a tool result for the model's sake rather than for
 * security: trimming a result too large to be worth its context, and telling
 * the model when it is calling the same tool with the same arguments and
 * getting the same answer.
 *
 * Both alter what the model sees, so both are settings, both are recorded on
 * the call (`CallRecord.shaping`), and the trace keeps the untrimmed result.
 */
import { createHash } from 'node:crypto'

const CHARS_PER_TOKEN = 4

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

export interface TrimOutcome {
  value: unknown
  changed: boolean
  fromTokens: number
  toTokens: number
}

interface TextBlock {
  type: 'text'
  text: string
}

const isTextBlock = (block: unknown): block is TextBlock =>
  !!block && typeof block === 'object' && (block as TextBlock).type === 'text' && typeof (block as TextBlock).text === 'string'

/**
 * Cuts the text blocks of an MCP `CallToolResult` down to `maxTokens`.
 *
 * Only `content` text is touched. Images and resource blocks pass through, and
 * so does `structuredContent`: a tool with an `outputSchema` must return it and
 * a client may validate it, so removing it would turn a long answer into an
 * error. The cut lands on a line break when one is near, and a closing note
 * tells the model what happened and what to do about it.
 */
export function trimResult(result: unknown, maxTokens: number): TrimOutcome {
  const content = (result as { content?: unknown })?.content
  if (!maxTokens || !Array.isArray(content)) return { value: result, changed: false, fromTokens: 0, toTokens: 0 }

  const texts = content.filter(isTextBlock)
  const fromTokens = estimateTokens(texts.map((b) => b.text).join(''))
  if (fromTokens <= maxTokens) return { value: result, changed: false, fromTokens, toTokens: fromTokens }

  let budget = maxTokens * CHARS_PER_TOKEN
  const kept: unknown[] = []
  let dropped = 0
  for (const block of content) {
    if (!isTextBlock(block)) {
      kept.push(block)
      continue
    }
    if (budget <= 0) {
      dropped++
      continue
    }
    if (block.text.length <= budget) {
      kept.push(block)
      budget -= block.text.length
      continue
    }
    let cut = budget
    const lineBreak = block.text.lastIndexOf('\n', cut)
    if (lineBreak > cut * 0.8) cut = lineBreak
    kept.push({ ...block, text: block.text.slice(0, cut) })
    budget = 0
  }

  const toTokens = estimateTokens(
    kept.filter(isTextBlock).map((b) => b.text).join('')
  )
  kept.push({
    type: 'text',
    text:
      `[Bridge trimmed this result from about ${fromTokens.toLocaleString('en-US')} to ${toTokens.toLocaleString('en-US')} tokens` +
      `${dropped > 0 ? `, dropping ${dropped} later text block${dropped === 1 ? '' : 's'}` : ''}. ` +
      'If you need the rest, call the tool again with a narrower query, a filter, or pagination.]'
  })
  return { value: { ...(result as object), content: kept }, changed: true, fromTokens, toTokens }
}

/** JSON with sorted keys, so `{a,b}` and `{b,a}` are the same call. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
  return `{${entries.join(',')}}`
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24)

/** How many identical calls in a row it takes before the model is told. */
export const REPEAT_THRESHOLD = 3

/**
 * Counts identical calls that keep returning an identical result, per session.
 *
 * Polling is legitimate — "is the build done yet?" — so the arguments alone are
 * not enough; the count only grows while the answer is also unchanged, and
 * resets the moment it differs. Nothing is blocked: the model gets a note.
 */
export class RepeatTracker {
  private readonly last = new Map<string, { result: string; count: number }>()

  /** Records a completed call and returns how many times in a row it has repeated. */
  observe(tool: string, args: unknown, resultText: string): number {
    const key = digest(`${tool}\u0000${stableStringify(args)}`)
    const result = digest(resultText)
    const prior = this.last.get(key)
    const count = prior && prior.result === result ? prior.count + 1 : 1
    this.last.set(key, { result, count })
    // A long session should not grow this without bound.
    if (this.last.size > 500) this.last.delete(this.last.keys().next().value as string)
    return count
  }
}

export function repeatNote(tool: string, count: number): { type: 'text'; text: string } {
  return {
    type: 'text',
    text: `[Bridge: this is call ${count} in a row to "${tool}" with identical arguments, and the result has not changed. Calling it again the same way will return the same thing; change the arguments or move on.]`
  }
}
