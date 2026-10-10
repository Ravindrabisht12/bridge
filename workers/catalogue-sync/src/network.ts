/** Bounded HTTPS requests to public addresses; redirects are never followed. */
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a !== undefined && b !== undefined && a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && (b === 18 || b === 19))
  }
  // Public global unicast only; exclude mapped IPv4, loopback and local networks.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !address.toLowerCase().startsWith('2001:db8:')
}

export const publicFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Only public HTTPS endpoints on port 443 are allowed')
  }
  const addresses = await lookup(url.hostname, { all: true })
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error('Non-public endpoint refused')
  const chosen = addresses[0]!
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, {
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      // Pin the checked address; preserve the original TLS hostname.
      lookup: (_host, _options, cb) => cb(null, chosen.address, chosen.family),
      signal: init?.signal ?? AbortSignal.timeout(15_000)
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) { req.destroy(new Error('Response exceeds 1 MiB')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        const status = res.statusCode ?? 502
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }))
      })
    })
    req.on('error', reject)
    if (init?.body) req.write(init.body)
    req.end()
  })
}
