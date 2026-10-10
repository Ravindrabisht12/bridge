import { describe, expect, it } from 'vitest'
import { rankTools, tokenize } from '@shared/tool-search'
import { AUTO_SEARCH_ABOVE, Gateway, aliasFor, type GatewayToolMode, type MemberLink } from '../proxy/gateway'
import type { JsonRpcMessage } from '@shared/jsonrpc'

describe('tool search ranking', () => {
  const tools = [
    { server: 'github', name: 'create_issue', description: 'Create a new issue in a repository' },
    { server: 'github', name: 'list_pull_requests', description: 'List pull requests' },
    { server: 'linear', name: 'createIssue', description: 'Create a Linear issue' },
    { server: 'fs', name: 'read_file', description: 'Read a file from disk' }
  ]

  it('splits camelCase and snake_case and folds plurals', () => {
    expect(tokenize('listPullRequests')).toEqual(['list', 'pull', 'request'])
    expect(tokenize('create_issues')).toEqual(['create', 'issue'])
  })

  it('ranks name and server matches first', () => {
    const hits = rankTools(tools, 'create github issue', 5).map((h) => `${h.tool.server}/${h.tool.name}`)
    expect(hits[0]).toBe('github/create_issue')
    expect(hits).toContain('linear/createIssue')
    expect(hits).not.toContain('fs/read_file')
  })

  it('returns nothing for a query with no overlap', () => {
    expect(rankTools(tools, 'send an email', 5)).toEqual([])
  })
})

describe('aliases', () => {
  it('makes server names safe and unique', () => {
    const taken = new Set<string>()
    expect(aliasFor('my.server', taken)).toBe('my-server')
    expect(aliasFor('my server', taken)).toBe('my-server-2')
  })
})

/** A fake upstream that answers the way an Interceptor-fronted server would. */
function fakeServer(name: string, tools: Array<{ name: string; description?: string }>, opts: { fail?: boolean; deny?: string } = {}) {
  let out: (msg: JsonRpcMessage) => void = () => {}
  const calls: unknown[] = []
  const link: MemberLink = {
    name,
    start: async () => { if (opts.fail) throw new Error('spawn ENOENT') },
    onMessage: (cb) => { out = cb },
    send: (msg) => {
      if (!('id' in msg) || !('method' in msg)) return
      const reply = (body: object) => queueMicrotask(() => out({ jsonrpc: '2.0', id: msg.id, ...body } as JsonRpcMessage))
      if (msg.method === 'initialize') reply({ result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name } } })
      else if (msg.method === 'tools/list') reply({ result: { tools: tools.map((t) => ({ ...t, inputSchema: { type: 'object' } })) } })
      else if (msg.method === 'tools/call') {
        calls.push(msg.params)
        if (msg.params.name === opts.deny) reply({ error: { code: -32001, message: 'Blocked by Bridge.' } })
        else reply({ result: { content: [{ type: 'text', text: `${name}:${msg.params.name}` }] } })
      }
    }
  }
  return { link, calls, emit: (msg: JsonRpcMessage) => out(msg) }
}

function setup(mode: GatewayToolMode, servers: ReturnType<typeof fakeServer>[]) {
  const sent: any[] = []
  const gateway = new Gateway({ members: servers.map((s) => s.link), toClient: (m) => sent.push(m), log() {}, mode: () => mode, version: 'test' })
  let id = 0
  const request = async (method: string, params?: unknown) => {
    const rid = ++id
    await gateway.handleFromClient({ jsonrpc: '2.0', id: rid, method, params })
    await new Promise((r) => setTimeout(r, 0))
    return sent.find((m) => m.id === rid)
  }
  return { gateway, sent, request }
}

describe('gateway', () => {
  const github = () => fakeServer('github', [{ name: 'create_issue', description: 'Create an issue' }, { name: 'delete_repo' }], { deny: 'delete_repo' })
  const files = () => fakeServer('files', [{ name: 'read_file', description: 'Read a file' }])

  it('answers initialize without waiting for servers', async () => {
    const { request } = setup('all', [github()])
    const init = await request('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } })
    expect(init.result.capabilities.tools.listChanged).toBe(true)
    expect(init.result.serverInfo.name).toBe('bridge')
  })

  it('in all mode, namespaces every tool and routes calls back', async () => {
    const gh = github()
    const { request } = setup('all', [gh, files()])
    await request('initialize', {})
    const list = await request('tools/list')
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['github__create_issue', 'github__delete_repo', 'files__read_file'])
    const res = await request('tools/call', { name: 'github__create_issue', arguments: { title: 'x' } })
    expect(res.result.content[0].text).toBe('github:create_issue')
    expect(gh.calls).toEqual([{ name: 'create_issue', arguments: { title: 'x' } }])
  })

  it('passes a policy refusal through as a protocol error in all mode', async () => {
    const { request } = setup('all', [github()])
    await request('initialize', {})
    await request('tools/list')
    const res = await request('tools/call', { name: 'github__delete_repo', arguments: {} })
    expect(res.error.message).toBe('Blocked by Bridge.')
  })

  it('in search mode, offers two tools, finds by description and calls through', async () => {
    const gh = github()
    const { request } = setup('search', [gh, files()])
    await request('initialize', {})
    const list = await request('tools/list')
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['search_tools', 'call_tool'])
    expect(list.result.tools[0].description).toMatch(/2 connected MCP servers with 3 tools/)

    const found = await request('tools/call', { name: 'search_tools', arguments: { query: 'open an issue' } })
    const hits = JSON.parse(found.result.content[0].text.split('\nRun one')[0])
    expect(hits[0]).toMatchObject({ server: 'github', tool: 'create_issue', inputSchema: { type: 'object' } })

    const ran = await request('tools/call', { name: 'call_tool', arguments: { server: 'github', tool: 'create_issue', arguments: { title: 'y' } } })
    expect(ran.result.content[0].text).toBe('github:create_issue')
    expect(gh.calls).toEqual([{ name: 'create_issue', arguments: { title: 'y' } }])
  })

  it('turns refusals and unknown names into tool errors the model can read', async () => {
    const { request } = setup('search', [github()])
    await request('initialize', {})
    const denied = await request('tools/call', { name: 'call_tool', arguments: { server: 'github', tool: 'delete_repo' } })
    expect(denied.result).toMatchObject({ isError: true, content: [{ text: 'Blocked by Bridge.' }] })
    const unknown = await request('tools/call', { name: 'call_tool', arguments: { server: 'github', tool: 'nope' } })
    expect(unknown.result.content[0].text).toMatch(/no tool named "nope"/)
    const noServer = await request('tools/call', { name: 'call_tool', arguments: { server: 'jira', tool: 'x' } })
    expect(noServer.result.content[0].text).toMatch(/No server named "jira"/)
  })

  it('auto switches to search above the threshold', async () => {
    const many = fakeServer('big', Array.from({ length: AUTO_SEARCH_ABOVE + 1 }, (_, i) => ({ name: `tool_${i}` })))
    const { request } = setup('auto', [many])
    await request('initialize', {})
    expect((await request('tools/list')).result.tools).toHaveLength(2)

    const few = setup('auto', [files()])
    await few.request('initialize', {})
    expect((await few.request('tools/list')).result.tools).toHaveLength(1)
  })

  it('keeps going when one server fails to start, and says which', async () => {
    const { request } = setup('search', [github(), fakeServer('broken', [], { fail: true })])
    await request('initialize', {})
    const found = await request('tools/call', { name: 'search_tools', arguments: { query: 'issue' } })
    expect(found.result.content[0].text).toMatch(/Not searched, unavailable: broken \(spawn ENOENT\)/)
    const call = await request('tools/call', { name: 'call_tool', arguments: { server: 'broken', tool: 'x' } })
    expect(call.result.content[0].text).toMatch(/"broken" is unavailable: spawn ENOENT/)
  })

  it('refreshes a server whose tools change and tells the client in all mode', async () => {
    const tools = [{ name: 'read_file' }]
    const fs = fakeServer('files', tools)
    const { request, sent } = setup('all', [fs])
    await request('initialize', {})
    await request('tools/list')
    tools.push({ name: 'write_file' })
    fs.emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.some((m) => m.method === 'notifications/tools/list_changed')).toBe(true)
    expect((await request('tools/list')).result.tools).toHaveLength(2)
  })

  it('answers resources and prompts with empty lists', async () => {
    const { request } = setup('all', [])
    expect((await request('resources/list')).result).toEqual({ resources: [] })
    expect((await request('prompts/list')).result).toEqual({ prompts: [] })
    expect((await request('sampling/createMessage')).error.code).toBe(-32601)
  })
})
