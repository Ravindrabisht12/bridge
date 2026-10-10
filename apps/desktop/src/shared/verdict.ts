/**
 * The one sentence the Overview page leads with.
 *
 * Six identically-weighted metric cards could not answer the only question the
 * page exists to answer: is anything wrong right now? A Blocked of 0 and a
 * Blocked of 12 rendered the same. This picks the most severe thing that is
 * true, says it in words, and leaves the rest as chips.
 */

export type VerdictTone = 'ok' | 'warn' | 'danger' | 'idle'

export interface VerdictInput {
  sessions: number
  connectedServers: number
  tools: number
  denied: number
  flagged: number
  changedTools: number
}

export interface VerdictChip {
  /** Which page answers this chip. */
  goto: 'trace' | 'tools' | 'servers'
  count: number
  label: string
  tone: 'warn' | 'danger' | 'plain'
}

export interface Verdict {
  tone: VerdictTone
  headline: string
  detail: string
  /** The problems the headline does not already name. */
  chips: VerdictChip[]
}

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)

export function overviewVerdict(input: VerdictInput): Verdict {
  const { sessions, connectedServers, tools, denied, flagged, changedTools } = input

  const chips: VerdictChip[] = []
  if (denied > 0) {
    chips.push({ goto: 'trace', count: denied, label: `${plural(denied, 'call')} blocked`, tone: 'danger' })
  }
  if (changedTools > 0) {
    chips.push({
      goto: 'tools',
      count: changedTools,
      label: `${plural(changedTools, 'definition')} changed`,
      tone: 'danger'
    })
  }
  if (flagged > 0) {
    chips.push({ goto: 'trace', count: flagged, label: `${plural(flagged, 'result')} flagged`, tone: 'warn' })
  }

  // Nothing is wrong, but nothing is running either — that is not "all clear".
  if (connectedServers === 0) {
    return {
      tone: 'idle',
      headline: 'Nothing is being watched yet',
      detail: 'Bridge can see the MCP servers already configured in your AI clients and wrap them, so calls on those connections go through here.',
      chips: []
    }
  }

  const watching =
    `Configured for ${connectedServers} ${plural(connectedServers, 'server')} · ${tools} ${plural(tools, 'tool')} exposed to the model`

  // A chip that repeats the headline is noise, so the lead is dropped from it.
  const others = (goto: VerdictChip['goto'], label: string): VerdictChip[] =>
    chips.filter((c) => !(c.goto === goto && c.label === label))

  if (denied > 0) {
    return {
      tone: 'danger',
      headline: `${denied} ${plural(denied, 'call')} blocked by policy`,
      detail: watching,
      chips: others('trace', `${plural(denied, 'call')} blocked`)
    }
  }

  if (changedTools > 0) {
    return {
      tone: 'danger',
      headline: `${changedTools} tool ${plural(changedTools, 'definition has', 'definitions have')} changed`,
      detail: `${watching}. Each will ask for approval again the next time it runs.`,
      chips: others('tools', `${plural(changedTools, 'definition')} changed`)
    }
  }

  if (flagged > 0) {
    return {
      tone: 'warn',
      headline: `${flagged} ${plural(flagged, 'result')} carried a finding`,
      detail: watching,
      chips: others('trace', `${plural(flagged, 'result')} flagged`)
    }
  }

  if (sessions === 0) {
    return {
      tone: 'idle',
      headline: 'No client is connected right now',
      detail: `${watching}. Rows appear the moment an AI client launches one of them.`,
      chips: []
    }
  }

  return {
    tone: 'ok',
    headline: 'No findings in recorded activity',
    detail: `${sessions} live ${plural(sessions, 'session')} · ${watching.toLowerCase()}. This is not a guarantee that all activity is safe or monitored.`,
    chips: []
  }
}
