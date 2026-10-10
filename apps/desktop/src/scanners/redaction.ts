import { redactSecrets } from './secrets'

const SECRET_FIELD = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|access_token|refresh_token|api[_-]?key|token)$/i
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----|$)/g

/** Redact values before serialization so matching an assignment cannot corrupt JSON. */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 32) return '[omitted: nesting limit]'
  if (typeof value === 'string') return redactSecrets(value.replace(PRIVATE_KEY, '[redacted private key]'))
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, SECRET_FIELD.test(key) && item !== null ? '[redacted]' : redactPayload(item, depth + 1)
    ]))
  }
  return value
}
