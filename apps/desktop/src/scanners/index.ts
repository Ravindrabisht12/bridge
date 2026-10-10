import type { Finding, Settings } from '@shared/types'
import { safeRegExp } from '../policy/matcher'
import { scanForInjection, stripInvisible } from './injection'
import { scanForSecrets } from './secrets'

export { scanForInjection, stripInvisible } from './injection'
export { scanForSecrets, redactSecrets, luhn, looksLikeSecret } from './secrets'

/** MCP tool results are content blocks; pull out everything textual. */
export function extractText(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  const parts: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || node === undefined) return
    if (typeof node === 'string') {
      parts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        // Base64 payloads are noise for text scanning.
        if (key === 'data' || key === 'blob') continue
        walk(value, depth + 1)
      }
    }
  }
  walk(result, 0)
  return parts.join('\n')
}

export function scanArguments(args: unknown, settings: Settings): Finding[] {
  if (!settings.scanSecrets) return []
  // Outgoing arguments may put credentials in a field named data/blob or deep in JSON.
  return scanForSecrets(JSON.stringify(args) ?? '', 'args')
}

export function scanResult(result: unknown, settings: Settings): Finding[] {
  const text = extractText(result)
  const findings: Finding[] = []
  if (settings.scanInjection) findings.push(...scanForInjection(text))
  if (settings.scanSecrets) findings.push(...scanForSecrets(text, 'result'))
  return findings
}

export function highestSeverity(findings: readonly Finding[]): 'none' | 'low' | 'medium' | 'high' {
  let best: 'none' | 'low' | 'medium' | 'high' = 'none'
  const rank = { none: 0, low: 1, medium: 2, high: 3 } as const
  for (const f of findings) if (rank[f.severity] > rank[best]) best = f.severity
  return best
}

/**
 * Applies invisible-character stripping and rule-supplied redaction patterns to
 * every string inside a tool result, leaving the structure intact.
 */
export function redactResult(result: unknown, patterns: readonly string[]): { value: unknown; changed: boolean } {
  const regexes = patterns.map((p) => safeRegExp(p, 'gi')).filter((r): r is RegExp => r !== null)
  let changed = false

  const transform = (node: unknown, depth: number): unknown => {
    if (depth > 12) return node
    if (typeof node === 'string') {
      let out = stripInvisible(node)
      for (const re of regexes) {
        re.lastIndex = 0
        out = out.replace(re, '[redacted by Bridge]')
      }
      if (out !== node) changed = true
      return out
    }
    if (Array.isArray(node)) return node.map((item) => transform(item, depth + 1))
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = transform(value, depth + 1)
      }
      return out
    }
    return node
  }

  return { value: transform(result, 0), changed }
}
