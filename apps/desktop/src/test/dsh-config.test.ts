import { describe, expect, it } from 'vitest'
import { dshEntryCurrent, dshServers, headersFromEnv, restoreDshServer, wrapDshServer } from '@shared/dsh-config'

const PATCH = `# my own notes
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
          LOG_LEVEL: warn
        cwd: !!js process.cwd()
    - id: mcp-web
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web
        transport: streamable-http
        url: http://localhost:3000/mcp
        headers:
          Authorization: !!js '\`Bearer \${process.env.MCP_TOKEN}\`'
          X-Team: core
`

const stanza = {
  command: '/Applications/Bridge.app/Contents/MacOS/Bridge',
  args: ['/x/out/main/proxy.js', '--id', 'srv_1', '--name', 'github'],
  env: { ELECTRON_RUN_AS_NODE: '1', BRIDGE_HOME: '/b' }
}
const ours = (args: string[]): boolean => args.some((a) => a.endsWith('proxy.js'))

describe('dsh patch file', () => {
  it('lists servers with literal values and leaves computed ones to dsh', () => {
    const servers = dshServers(PATCH)
    expect(Object.keys(servers)).toEqual(['github', 'web'])
    expect(servers.github).toMatchObject({ command: 'npx', env: { LOG_LEVEL: 'warn' } })
    expect(servers.github?.env).not.toHaveProperty('GITHUB_TOKEN')
    expect(servers.github?.computed).toEqual(['env.GITHUB_TOKEN', 'cwd'])
    expect(servers.web).toMatchObject({ url: 'http://localhost:3000/mcp', headers: { 'X-Team': 'core' } })
  })

  it('wraps a stdio row in place, keeping comments, other rows and !!js values', () => {
    const { text, original } = wrapDshServer(PATCH, 'github', stanza, ours)
    expect(text).toContain('# my own notes')
    expect(text).toContain('preference: dark')
    expect(text).toContain('GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN')
    expect(text).toContain('cwd: !!js process.cwd()')
    const github = dshServers(text).github
    expect(github).toMatchObject({ command: stanza.command, args: stanza.args })
    expect(dshEntryCurrent(github, stanza)).toBe(true)
    expect(original).toContain('command: npx')
  })

  it('moves remote headers into env so computed ones stay computed', () => {
    const { text } = wrapDshServer(PATCH, 'web', { ...stanza, args: [...stanza.args.slice(0, 4), 'web'] }, ours)
    const web = dshServers(text).web
    expect(web?.url).toBeUndefined()
    expect(web?.env).toMatchObject({ 'BRIDGE_HEADER__X-Team': 'core' })
    expect(text).toContain("BRIDGE_HEADER__Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'")
  })

  it('restores the original row exactly, tags included', () => {
    const { text, original } = wrapDshServer(PATCH, 'web', stanza, ours)
    const back = restoreDshServer(text, 'web', original, {})
    expect(dshServers(back).web).toEqual(dshServers(PATCH).web)
    expect(back).toContain("Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'")
  })

  it('does not overwrite the saved original when the row is already ours', () => {
    const first = wrapDshServer(PATCH, 'github', stanza, ours)
    const second = wrapDshServer(first.text, 'github', stanza, ours)
    expect(second.original).toBeNull()
  })

  it('creates a row in the insert list when dsh does not have the server', () => {
    const { text, original } = wrapDshServer(PATCH, 'linear', stanza, ours)
    expect(original).toBeNull()
    expect(Object.keys(dshServers(text))).toEqual(['github', 'web', 'linear'])
    expect(text).toContain('id: bridge-linear')
  })

  it('starts a file from nothing', () => {
    const { text } = wrapDshServer('', 'linear', stanza, ours)
    expect(dshServers(text).linear?.command).toBe(stanza.command)
  })

  it('refuses a name dsh would reject instead of writing a broken row', () => {
    expect(() => wrapDshServer(PATCH, 'my.server', stanza, ours)).toThrow(/letters, digits/)
  })

  it('refuses a file that is not a patch list', () => {
    expect(() => dshServers('a: 1')).toThrow(/top-level YAML list/)
    expect(() => dshServers('- [unclosed')).toThrow(/invalid YAML/)
  })

  it('reads forwarded headers back out of the environment', () => {
    expect(headersFromEnv({ BRIDGE_HEADER__Authorization: 'Bearer x', PATH: '/bin' })).toEqual({ Authorization: 'Bearer x' })
  })
})
