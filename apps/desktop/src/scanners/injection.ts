/**
 * Heuristic prompt-injection detection for MCP tool *results*.
 *
 * A tool result is untrusted input that goes straight into the model's context.
 * These patterns catch the common shapes: instruction overrides, exfiltration
 * requests, and text made invisible to a human reviewing the same output.
 */
import type { Finding, Severity } from '@shared/types'

interface Pattern {
  id: string
  label: string
  severity: Severity
  re: RegExp
  detail: string
}

const PATTERNS: Pattern[] = [
  {
    id: 'override',
    label: 'Instruction override',
    severity: 'high',
    detail: 'The tool result tries to cancel earlier instructions.',
    re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(all\s+)?(previous|prior|earlier|above|preceding|system)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction|message)s?\b/i
  },
  {
    id: 'role-reassign',
    label: 'Role reassignment',
    severity: 'high',
    detail: 'The tool result attempts to redefine the assistant.',
    re: /\byou\s+are\s+(now|actually)\b|\bnew\s+(system\s+)?(instruction|prompt|persona|role)s?\b|\bact\s+as\s+(if\s+you|a\s+)/i
  },
  {
    id: 'system-prompt-leak',
    label: 'System prompt extraction',
    severity: 'high',
    detail: 'The tool result asks the model to reveal hidden instructions.',
    re: /\b(reveal|print|repeat|output|show|dump)\b[^.\n]{0,30}\b(system\s+prompt|initial\s+instructions|hidden\s+instructions|your\s+instructions)\b/i
  },
  {
    id: 'exfiltration',
    label: 'Data exfiltration request',
    severity: 'high',
    detail: 'The tool result asks for local data to be sent somewhere.',
    re: /\b(send|post|upload|forward|transmit|exfiltrate|email)\b[^.\n]{0,50}\b(to|at)\b\s*(https?:\/\/|[\w.+-]+@[\w-]+\.[a-z]{2,})/i
  },
  {
    id: 'tool-chaining',
    label: 'Injected tool instruction',
    severity: 'high',
    detail: 'The tool result instructs the model to invoke another tool.',
    re: /\b(call|invoke|run|use|execute)\b[^.\n]{0,30}\b(the\s+)?(tool|function|command|mcp)\b[^.\n]{0,40}\b(with|and)\b/i
  },
  {
    id: 'secret-read',
    label: 'Credential access request',
    severity: 'high',
    detail: 'The tool result asks the model to read local secrets.',
    re: /\b(read|open|cat|fetch|contents?\s+of)\b[^.\n]{0,40}(\.env|id_rsa|\.ssh\/|credentials|\.aws\/|keychain|password\s*file)/i
  },
  {
    id: 'markdown-beacon',
    label: 'Markdown image beacon',
    severity: 'medium',
    detail: 'An image URL with a query string can leak context when rendered.',
    re: /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]+\?[^)\s]{8,}\)/i
  },
  {
    id: 'hidden-html',
    label: 'Hidden HTML instruction',
    severity: 'medium',
    detail: 'Instructions concealed in a comment or hidden element.',
    re: /<!--[\s\S]{0,400}?\b(ignore|instruction|assistant|you must|system)\b[\s\S]{0,400}?-->|style\s*=\s*["'][^"']*(display\s*:\s*none|font-size\s*:\s*0|color\s*:\s*#?f{3,6})/i
  },
  {
    id: 'urgency',
    label: 'Authority or urgency framing',
    severity: 'low',
    detail: 'Language commonly used to pressure a model into compliance.',
    re: /\b(important|urgent|critical|mandatory)\b[^.\n]{0,30}\b(you\s+must|do\s+not\s+tell|without\s+asking|do\s+not\s+mention|silently)\b/i
  },
  {
    id: 'no-confirm',
    label: 'Confirmation suppression',
    severity: 'high',
    detail: 'The result asks the model to skip telling the user.',
    re: /\b(do\s+not|don't|never)\b[^.\n]{0,25}\b(tell|inform|mention|show|ask)\b[^.\n]{0,25}\b(the\s+)?(user|human|owner)\b/i
  }
]

/** Unicode tag block — renders as nothing but is read by the model. */
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/u
const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF]/
const BIDI_OVERRIDE = /[\u202A-\u202E\u2066-\u2069]/

export function excerptAround(text: string, index: number, span = 60): string {
  const start = Math.max(0, index - span)
  const end = Math.min(text.length, index + span)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return prefix + text.slice(start, end).replace(/\s+/g, ' ').trim() + suffix
}

export function scanForInjection(text: string): Finding[] {
  if (!text) return []
  const findings: Finding[] = []

  for (const p of PATTERNS) {
    const match = p.re.exec(text)
    if (match) {
      findings.push({
        type: 'injection',
        severity: p.severity,
        label: p.label,
        detail: p.detail,
        side: 'result',
        excerpt: excerptAround(text, match.index)
      })
    }
  }

  const invisible: Array<[RegExp, string, Severity, string]> = [
    [TAG_CHARS, 'Unicode tag characters', 'high', 'Text invisible to humans but readable by the model.'],
    [ZERO_WIDTH, 'Zero-width characters', 'medium', 'Zero-width characters can hide instructions between visible words.'],
    [BIDI_OVERRIDE, 'Bidirectional override', 'medium', 'Bidi controls can make displayed text differ from actual text.']
  ]
  for (const [re, label, severity, detail] of invisible) {
    const match = re.exec(text)
    if (match) {
      findings.push({
        type: 'invisible-text',
        severity,
        label,
        detail,
        side: 'result',
        excerpt: excerptAround(text, match.index)
      })
    }
  }

  return findings
}

/** Strips characters that are invisible to a human reader. */
export function stripInvisible(text: string): string {
  return text
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
}
