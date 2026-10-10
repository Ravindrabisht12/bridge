/**
 * An AI client reads its MCP config once, at launch. If Bridge rewrote that
 * file afterwards, the client is still running the old commands and will report
 * a server as failed regardless of what Bridge does — the single most
 * confusing failure in the whole product, because everything on disk looks
 * correct.
 *
 * A live session proves the client had already started, so a config written
 * after the oldest live session means the running client predates the change.
 */
export interface ClientConfigState {
  id: string
  configPresent: boolean
  configModifiedAt: number | null
}

export interface SessionStart {
  client: string
  startedAt: number
}

export function needsRestart(
  client: ClientConfigState,
  sessions: readonly SessionStart[]
): boolean {
  if (!client.configPresent || client.configModifiedAt === null) return false
  const starts = sessions.filter((s) => s.client === client.id).map((s) => s.startedAt)
  // No live session means nothing is running to be stale.
  if (starts.length === 0) return false
  return client.configModifiedAt > Math.min(...starts)
}

export function clientsNeedingRestart<T extends ClientConfigState>(
  clients: readonly T[],
  sessions: readonly SessionStart[]
): T[] {
  return clients.filter((c) => needsRestart(c, sessions))
}
