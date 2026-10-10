/**
 * Credential and PII detection for tool *arguments* — data on its way out of
 * the machine — and for results that echo secrets back into context.
 */
import type { Finding, Severity } from '@shared/types'
import { excerptAround } from './injection'

interface SecretPattern {
  id: string
  label: string
  severity: Severity
  re: RegExp
  /** Optional second-stage check to cut false positives. */
  validate?: (match: string) => boolean
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { id: 'aws-akid', label: 'AWS access key id', severity: 'high', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { id: 'anthropic', label: 'Anthropic API key', severity: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'openai', label: 'OpenAI API key', severity: 'high', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'github', label: 'GitHub token', severity: 'high', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: 'slack', label: 'Slack token', severity: 'high', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: 'google-api', label: 'Google API key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'stripe', label: 'Stripe secret key', severity: 'high', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'private-key', label: 'Private key block', severity: 'high', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g },
  {
    id: 'jwt',
    label: 'JSON Web Token',
    severity: 'medium',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
  },
  {
    id: 'generic',
    label: 'Generic credential assignment',
    severity: 'medium',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|auth)\b["'\s]*[:=]["'\s]*([A-Za-z0-9_\-./+]{16,})/gi,
    validate: (m) => !/\b(?:example|placeholder|your[_-]?|xxx+|<[^>]+>|null|undefined|redacted)\b/i.test(m)
  },
  {
    id: 'card',
    label: 'Possible payment card number',
    severity: 'high',
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (m) => luhn(m.replace(/\D/g, ''))
  },
  { id: 'email', label: 'Email address', severity: 'low', re: /\b[\w.+-]+@[\w-]+\.[A-Za-z]{2,}\b/g }
]

export function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

export function scanForSecrets(text: string, side: 'args' | 'result'): Finding[] {
  if (!text) return []
  const findings: Finding[] = []
  const seen = new Set<string>()

  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0
    let match: RegExpExecArray | null
    let hits = 0
    while ((match = p.re.exec(text)) !== null && hits < 5) {
      if (match[0].length === 0) {
        p.re.lastIndex++
        continue
      }
      if (p.validate && !p.validate(match[0])) continue
      hits++
      if (seen.has(p.id)) continue
      seen.add(p.id)
      findings.push({
        type: p.id === 'email' || p.id === 'card' ? 'pii' : 'secret',
        severity: p.severity,
        label: p.label,
        detail:
          side === 'args'
            ? 'This value is being sent to an external tool.'
            : 'A credential-shaped value came back into the model context.',
        side,
        excerpt: redactSecrets(excerptAround(text, match.index))
      })
    }
  }
  return findings
}

/** Masks everything but the first four characters of each detected secret. */
export function redactSecrets(text: string): string {
  let out = text
  for (const p of SECRET_PATTERNS) {
    if (p.id === 'email') continue
    out = out.replace(new RegExp(p.re.source, p.re.flags), (m) =>
      m.length <= 8 ? '••••' : `${m.slice(0, 4)}${'•'.repeat(Math.min(12, m.length - 4))}`
    )
  }
  return out
}

/**
 * Whether a single value is credential-shaped, at medium confidence or above.
 *
 * Used to keep secrets out of long-lived records a user reads back — a grant's
 * constraints, most of all. Low-severity matches (a bare email address) are not
 * treated as credentials, but a card number is.
 */
export function looksLikeSecret(value: string): boolean {
  if (!value) return false
  return scanForSecrets(value, 'args').some((finding) => finding.severity !== 'low')
}
