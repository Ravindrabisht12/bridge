import type { ManagedServer, SessionRecord } from './types'

export type CoverageState = 'active' | 'configured' | 'direct' | 'broken'
export interface CoverageConnection {
  client: ManagedServer['client']
  name: string
  wrapped: boolean
  wrappedServerId: string | null
  /** The current config matches this build's expected proxy command. */
  current: boolean
}
export interface CoverageRow {
  client: ManagedServer['client']
  name: string
  state: CoverageState
  detail: string
}
export interface CoverageReport {
  integrations?: IntegrationEvidence[]
  checkedAt: number
  rows: CoverageRow[]
  unreadableClients: string[]
}

/** Config files show intended routing; only an observed proxy session shows activity. */
export function describeCoverage(
  connections: CoverageConnection[], servers: Pick<ManagedServer, 'id'>[],
  sessions: Pick<SessionRecord, 'serverId' | 'client' | 'endedAt'>[]
): CoverageRow[] {
  const ids = new Set(servers.map((server) => server.id))
  return connections.map((connection) => {
    const { client, name } = connection
    if (!connection.wrapped) return { client, name, state: 'direct', detail: 'Configured to connect without Bridge. Restart the client after changing routing.' }
    if (!connection.wrappedServerId || !ids.has(connection.wrappedServerId) || !connection.current) {
      return { client, name, state: 'broken', detail: 'Proxy configuration needs repair; monitoring is not confirmed.' }
    }
    const active = sessions.some((session) => session.serverId === connection.wrappedServerId && session.client === client && session.endedAt === null)
    return active
      ? { client, name, state: 'active', detail: 'A live proxy session is recorded for this server and configured client.' }
      : { client, name, state: 'configured', detail: 'Configured through Bridge, but no matching live proxy session is recorded.' }
  })
}

export interface IntegrationEvidence {
  serverId: string
  name: string
  credentialFields: string[]
  transport: 'Local process' | 'HTTPS' | 'Unencrypted HTTP' | 'Invalid endpoint'
  concerns: string[]
}

/** Configuration evidence only: never return credential values, URLs or command arguments. */
export function describeIntegration(server: ManagedServer): IntegrationEvidence {
  const target = server.target
  const fields = Object.keys(target.kind === 'stdio' ? target.env ?? {} : target.headers ?? {})
  const credentialFields = fields.filter((key) => /token|secret|password|passwd|authorization|cookie|api.?key|credential/i.test(key))
  const concerns: string[] = []
  let transport: IntegrationEvidence['transport'] = 'Local process'
  if (target.kind === 'http') {
    try {
      const url = new URL(target.url)
      transport = url.protocol === 'https:' ? 'HTTPS' : url.protocol === 'http:' ? 'Unencrypted HTTP' : 'Invalid endpoint'
      if (url.username || url.password || url.search) concerns.push('Endpoint contains user information or query parameters; inspect locally for embedded credentials.')
    } catch { transport = 'Invalid endpoint' }
    if (transport !== 'HTTPS') concerns.push('Transport does not provide confirmed HTTPS encryption.')
  } else concerns.push('Local process can access resources permitted by its operating-system account; Bridge does not sandbox it.')
  if (credentialFields.length) concerns.push('Credential-like configuration fields are present. Values are not shown here; encrypted vault storage is not implemented.')
  concerns.push('Account owner, provider scopes, expiry and actual token use are unverified. Credentials may also be loaded elsewhere.')
  return { serverId: server.id, name: server.name, credentialFields, transport, concerns }
}
