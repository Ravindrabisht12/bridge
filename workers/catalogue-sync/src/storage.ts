import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AssetStorage { put(key: string, bytes: Buffer, contentType: string): Promise<string> }

export function assetStorage(env = process.env): AssetStorage {
  const base = env.CDN_BASE?.replace(/\/$/, '')
  if (!base) throw new Error('CDN_BASE must be set to the public asset URL')
  const publicUrl = new URL(base)
  if (publicUrl.protocol !== 'https:' && !(publicUrl.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(publicUrl.hostname))) {
    throw new Error('CDN_BASE requires HTTPS (localhost HTTP is allowed for development)')
  }
  if (!env.STORAGE_DIR && !(env.SUPABASE_URL && env.CDN_BUCKET && env.CDN_TOKEN)) {
    throw new Error('Set STORAGE_DIR for local assets, or SUPABASE_URL, CDN_BUCKET and CDN_TOKEN')
  }
  return {
    async put(key, bytes, contentType) {
      if (!/^[a-z0-9/_\-.]+$/i.test(key) || key.includes('..')) throw new Error('Invalid asset key')
      if (env.STORAGE_DIR) {
        const destination = join(env.STORAGE_DIR, key)
        await mkdir(dirname(destination), { recursive: true })
        const temporary = `${destination}.${randomUUID()}.tmp`
        await writeFile(temporary, bytes)
        await rename(temporary, destination)
      } else {
        const endpoint = new URL(env.SUPABASE_URL!)
        if (endpoint.protocol !== 'https:') throw new Error('SUPABASE_URL requires HTTPS')
        const res = await fetch(`${endpoint.origin}/storage/v1/object/${encodeURIComponent(env.CDN_BUCKET!)}/${key}`, {
          method: 'POST', redirect: 'error',
          headers: { authorization: `Bearer ${env.CDN_TOKEN}`, 'content-type': contentType, 'x-upsert': 'true', 'cache-control': '31536000' },
          body: bytes, signal: AbortSignal.timeout(30_000)
        })
        if (!res.ok) throw new Error(`Asset upload failed: HTTP ${res.status}`)
      }
      return `${base}/${key}`
    }
  }
}
