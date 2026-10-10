import { listActionGrants, pruneActionGrants, revokeActionGrant } from '../../db/action-grants'
import { createGrantFromCall, createGrantFromSpec } from '../services/grants'
import { claudeCodeSettingsPath, hookCommand, hookStatus, installHook, uninstallHook } from '../services/hook-install'
import { hookSettingsSnippet } from '@shared/hook'
import { describeCoverage, describeIntegration } from '@shared/coverage'
import { writePrivateFile } from '@shared/private-fs'
import { join } from 'node:path'
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { controlSocketPath, bridgeHome } from '@shared/control'
import type { ClientStatusDto, DiscoveredServerDto, IpcApi, IpcChannel } from '@shared/ipc'
import type { ClientId, ManagedServer, PolicyRule } from '@shared/types'
import { applyInputs, planCustom, planInstall } from '@shared/install'
import { RegistrySync } from '../services/registry-sync'
import type { IconCache } from '../services/icons'
import { probeTarget } from '../services/probe'
import { applyOfficial, applySeed } from '../services/seeding'
import { FileLogger } from '@shared/logger'
import { getDatabase } from '../../db'
import * as catalog from '../../db/catalog'
import * as catalogue from '../../db/catalogue'
import * as repo from '../../db/repo'
import { defaultRules } from '../../policy/defaults'
import { safeRegExp } from '../../policy/matcher'
import type { ControlServer } from '../control/server'
import {
  MANUAL_ONLY_CLIENTS,
  clientStatus,
  configHealth,
  discoverServers,
  configEntryCurrent,
  unreadableClientConfigs,
  installServer,
  proxyScriptPath,
  uninstallServer,
  gatewayEntryCurrent,
  knownClients,
  setGateway,
  setGatewayClients
} from '../services/clients'

// Handlers may be async; the invoke wrapper awaits before replying.
type Handlers = {
  [C in IpcChannel]: (...args: Parameters<IpcApi[C]>) => ReturnType<IpcApi[C]> | Promise<ReturnType<IpcApi[C]>>
}

export function registerIpc(
  control: ControlServer,
  onConfigChanged: () => void,
  sync: RegistrySync,
  icons: IconCache,
  /**
   * Whether a message really came from Bridge's own renderer.
   *
   * Every channel here is privileged — it can revoke a permission, widen a
   * scope, read the trace. Electron delivers `invoke` from any frame in any of
   * the app's WebContents, so without this an embedded or injected frame would
   * inherit the whole API. The caller owns the window, so it owns this test.
   */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): void {
  const db = () => getDatabase()
  const log = new FileLogger('main')

  /**
   * Plans an install from a catalogue key, whichever half of the catalogue it
   * lives in. Registry entries need their package/remote mapped to a command;
   * custom entries already say exactly how to run.
   */
  const planFor = (key: string, prefer: 'local' | 'remote') => {
    const item = catalogue.getCatalogueItem(db(), key)
    if (!item) return { ok: false as const, error: { reason: `"${key}" is not in the catalogue.` } }

    if (item.custom) return planCustom(item.custom)

    return planInstall(
      {
        name: item.key,
        title: item.title,
        description: item.description,
        version: item.version,
        namespace: item.namespace ?? '',
        repositoryUrl: item.repositoryUrl,
        websiteUrl: item.websiteUrl,
        status: item.status,
        publishedAt: item.publishedAt,
        updatedAt: item.updatedAt,
        kind:
          item.packages.length && item.remotes.length
            ? 'both'
            : item.packages.length
              ? 'stdio'
              : item.remotes.length
                ? 'remote'
                : 'none',
        packages: item.packages,
        remotes: item.remotes,
        iconUrl: item.iconUrl,
        downloads: item.downloads,
        downloadsSource: item.downloadsSource,
        categories: item.categories,
        syncedAt: Date.now()
      },
      prefer
    )
  }

  /** Writes a server into one client's config, recording the outcome. */
  const wireInto = (server: ManagedServer, client: ClientId): void => {
    installServer({ ...server, client })
    catalog.setServerClient(db(), server.id, client, true)
  }

  const handlers: Handlers = {
    'security:grants': () => {
      pruneActionGrants(db())
      return listActionGrants(db())
    },
    'security:revoke': (id) => {
      if (typeof id !== 'string' || !id || id.length > 100) throw new Error('Invalid permission ID')
      if (!revokeActionGrant(db(), id)) throw new Error('That permission was already revoked or is gone.')
    },
    'security:grant': ({ callId, ...spec }) => createGrantFromCall(db(), callId, spec),
    'hook:status': () => hookStatus(),
    'hook:install': () => installHook(),
    'hook:uninstall': () => uninstallHook(),
    'hook:snippet': () => ({ settingsPath: claudeCodeSettingsPath(), snippet: hookSettingsSnippet(hookCommand()) }),

    'security:coverage': () => {
      repo.reapDeadSessions(db())
      const servers = repo.listServers(db())
      const connections = discoverServers().map((connection) => {
        const server = servers.find((candidate) => candidate.id === connection.wrappedServerId)
        return { ...connection, current: !!server && configEntryCurrent({ ...server, client: connection.client, name: connection.name }) }
      })
      // A gateway entry stands for every server installed for its client.
      const links = catalog.listServerClients(db())
      for (const client of repo.readSettings(db()).gatewayClients) {
        const current = gatewayEntryCurrent(client)
        for (const server of servers) {
          const link = links.find((l) => l.serverId === server.id && l.client === client)
          const wired = link ? link.installed : server.installed && server.client === client
          if (wired) connections.push({ client, name: server.name, target: server.target, clientLabel: client, wrapped: true, wrappedServerId: server.id, current })
        }
      }
      return { integrations: servers.map(describeIntegration), checkedAt: Date.now(), rows: describeCoverage(connections, servers, repo.listActiveSessions(db())), unreadableClients: unreadableClientConfigs() }
    },
    'calls:query': (q) => repo.queryCalls(db(), q ?? {}),
    'calls:get': (id) => repo.getCall(db(), id),
    'calls:stats': () => repo.stats(db()),

    'calls:export': (q) => {
      const rows = repo.queryCalls(db(), { ...(q ?? {}), limit: 10_000 })
      const target = dialog.showSaveDialogSync({
        title: 'Export trace',
        defaultPath: join(app.getPath('downloads'), `bridge-trace-${Date.now()}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (!target) return null
      writePrivateFile(target, JSON.stringify({ exportedAt: Date.now(), calls: rows }, null, 2))
      return { path: target, count: rows.length }
    },

    'calls:purge': (days) => repo.purgeOlderThan(db(), Date.now() - days * 86_400_000),

    'servers:list': () => repo.listServers(db()),

    'servers:discover': (): DiscoveredServerDto[] => {
      const managed = repo.listServers(db())
      return discoverServers().map((d) => {
        const match =
          managed.find((m) => m.id === d.wrappedServerId) ??
          managed.find((m) => m.name === d.name && m.client === d.client)
        return { ...d, managedId: match?.id ?? null }
      })
    },

    'servers:import': ({ name, client, target }) => {
      // Keep an existing row's id so upgrades never orphan a live config.
      const existing = repo.listServers(db()).find((s) => s.name === name && s.client === client)
      const server: ManagedServer = {
        id: existing?.id ?? repo.serverIdFor(client, name),
        name,
        client,
        target,
        enabled: true,
        installed: existing?.installed ?? false,
        catalogueKey: existing?.catalogueKey ?? null,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      }
      return repo.upsertServer(db(), server)
    },

    'servers:install': (id) => {
      const server = repo.getServer(db(), id)
      if (!server) throw new Error(`No such server: ${id}`)
      // Always write: re-connecting is how a user repairs a stale stanza.
      installServer(server)
      return repo.upsertServer(db(), { ...server, installed: true })
    },

    'servers:uninstall': (id) => {
      const server = repo.getServer(db(), id)
      if (!server) throw new Error(`No such server: ${id}`)
      uninstallServer(server)
      return repo.upsertServer(db(), { ...server, installed: false })
    },

    'servers:remove': (id) => {
      const server = repo.getServer(db(), id)
      if (server) {
        for (const link of catalog.listServerClients(db(), id)) {
          if (!link.installed) continue
          try {
            uninstallServer({ ...server, client: link.client })
          } catch {
            // A config we can no longer write is not a reason to keep the row.
          }
        }
        catalog.deleteServerClients(db(), id)
      }
      repo.deleteServer(db(), id)
    },

    'servers:sessions': () => {
      repo.reapDeadSessions(db())
      return repo.listActiveSessions(db())
    },
    'servers:tools': (serverId) => repo.listTools(db(), serverId),

    'tools:setEnabled': ({ serverId, names, enabled }) => {
      repo.setToolsEnabled(db(), serverId, names, enabled)
      // Live proxies re-filter immediately and tell the client to re-read.
      control.broadcastToolPrefs(serverId, repo.disabledTools(db(), serverId))
      return repo.listTools(db(), serverId)
    },

    'rules:list': () => repo.listRules(db()),
    'rules:stats': () => repo.ruleStats(db()),
    'rules:save': (rule: PolicyRule) => {
      // Refuse a pattern that cannot compile, rather than store a rule that
      // could never behave the way its author meant.
      const m = rule?.match ?? {}
      for (const [field, pattern, isRegex] of [
        ['tool', m.tool, false], ['method', m.method, false], ['client', m.clientName, false], ['argument', m.argMatches, true]
      ] as const) {
        if (typeof pattern !== 'string' || !(isRegex || pattern.startsWith('re:'))) continue
        if (!safeRegExp(isRegex ? pattern : pattern.slice(3))) throw new Error(`The ${field} pattern is not a valid regular expression.`)
      }
      const saved = repo.upsertRule(db(), { ...rule, id: rule.id || repo.newId('rule') })
      onConfigChanged()
      return saved
    },
    'rules:delete': (id) => {
      repo.deleteRule(db(), id)
      onConfigChanged()
    },
    'rules:reset': () => {
      for (const rule of repo.listRules(db())) {
        if (rule.id.startsWith('builtin_')) repo.deleteRule(db(), rule.id)
      }
      for (const rule of defaultRules()) repo.upsertRule(db(), rule)
      onConfigChanged()
      return repo.listRules(db())
    },

    'settings:get': () => repo.readSettings(db()),
    'settings:set': (patch) => {
      // Gateway membership changes config files; it goes through gateway:set only.
      const { gatewayClients: _ignored, ...rest } = patch ?? {}
      const next = repo.writeSettings(db(), rest)
      if (typeof patch.launchAtLogin === 'boolean' && app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin })
      }
      onConfigChanged()
      return next
    },

    'gateway:set': ({ client, enabled }) => {
      if (!knownClients().some((c) => c.id === client)) throw new Error(`Unknown client: ${String(client)}`)
      const links = new Map(catalog.listServerClients(db()).filter((l) => l.client === client).map((l) => [l.serverId, l.installed]))
      const servers = repo.listServers(db()).filter((s) => links.get(s.id) ?? (s.installed && s.client === client))
      setGateway(client, enabled, servers)
      const current = repo.readSettings(db()).gatewayClients
      const gatewayClients = enabled ? [...new Set([...current, client])] : current.filter((c) => c !== client)
      setGatewayClients(gatewayClients)
      const next = repo.writeSettings(db(), { gatewayClients })
      onConfigChanged()
      return next
    },

    'approvals:pending': () => control.pending,
    'approvals:resolve': (result) => {
      if (!result || typeof result.id !== 'string' || (result.effect !== 'allow' && result.effect !== 'deny')) {
        throw new Error('Invalid approval decision')
      }
      // The grant is created before the decision is sent back, so it is already
      // in place when the agent's next call arrives. An invalid scope leaves the
      // call waiting rather than allowing it under a permission that failed to
      // save — the user can correct the scope and decide again.
      if (result.grant && result.effect === 'allow') {
        const request = control.pendingRequest(result.id)
        if (!request) throw new Error('That approval is no longer pending.')
        if (request.onceOnly) {
          throw new Error('This call needs an individual decision and cannot create a reusable permission.')
        }
        createGrantFromSpec(
          db(),
          { serverId: request.serverId, sessionId: request.sessionId, tool: request.tool },
          result.grant
        )
      }
      return control.resolveApproval({ id: result.id, effect: result.effect, scope: result.scope })
    },

    'catalogue:query': (q) => catalogue.queryCatalogue(db(), q ?? {}),
    'catalogue:get': (key) => catalogue.getCatalogueItem(db(), key),
    'catalogue:facets': () => catalogue.catalogueFacetCounts(db()),
    'catalogue:tags': () => catalogue.listTags(db()),
    'catalogue:reseed': () => {
      applyOfficial(db(), log, true)
      return applySeed(db(), log, true)
    },

    'catalogue:plan': ({ key, prefer }) => planFor(key, prefer ?? 'local'),

    'catalogue:install': ({ key, serverName, prefer, values, headerNames, clients }) => {
      const planned = planFor(key, prefer ?? 'local')
      if (!planned.ok) throw new Error(planned.error.reason)

      // Headers the operator typed are not in the plan's declared inputs, so
      // register them before applying values.
      const plan = {
        ...planned.plan,
        required: [
          ...planned.plan.required,
          ...(headerNames ?? [])
            .filter((n) => !planned.plan.required.some((r) => r.name === n))
            .map((name) => ({ name, description: '', isSecret: true, kind: 'header' as const }))
        ]
      }
      const target = applyInputs(plan, values ?? {})
      const finalName = (serverName || plan.suggestedName).trim()
      if (!finalName) throw new Error('Give the server a name.')

      const existing = repo.listServers(db()).find((s) => s.name === finalName)
      const server = repo.upsertServer(db(), {
        id: existing?.id ?? repo.serverIdFor('shared', finalName),
        name: finalName,
        client: clients[0] ?? 'claude-desktop',
        target,
        enabled: true,
        installed: true,
        catalogueKey: key,
        createdAt: existing?.createdAt ?? Date.now()
      })

      const installedInto: string[] = []
      const failed: Array<{ client: string; reason: string }> = []
      for (const client of clients ?? []) {
        try {
          wireInto(server, client)
          installedInto.push(client)
        } catch (err) {
          failed.push({ client, reason: (err as Error).message })
        }
      }
      return { serverId: server.id, installedInto, failed }
    },
    'overlay:save': (patch) => catalogue.saveOverlay(db(), patch),

    'custom:list': () => catalogue.listCustomEntries(db()),
    'custom:save': (entry) => {
      const title = entry.title?.trim()
      if (!title) throw new Error('Give the server a name.')
      if (entry.source === 'custom-local' && !entry.command?.trim()) {
        throw new Error('A local server needs a command to run.')
      }
      if (entry.source !== 'custom-local' && !entry.url?.trim()) {
        throw new Error(entry.source === 'custom-git' ? 'Give the repository URL.' : 'Give the server URL.')
      }
      return catalogue.saveCustomEntry(db(), { ...entry, id: entry.id || catalogue.newCustomId(), title })
    },
    'custom:delete': (id) => catalogue.deleteCustomEntry(db(), id),

    'server:probe': async ({ serverId, key, headers }) => {
      /** Applies any headers the operator typed, for hosted targets. */
      const withHeaders = (target: ManagedServer['target']): ManagedServer['target'] =>
        target.kind === 'http' && headers && Object.keys(headers).length > 0
          ? { ...target, headers: { ...target.headers, ...headers } }
          : target

      // Either an installed server, or a catalogue entry not yet installed.
      if (serverId) {
        const server = repo.getServer(db(), serverId)
        if (!server) throw new Error(`No such server: ${serverId}`)
        return probeTarget(withHeaders(server.target))
      }
      if (!key) throw new Error('Give either a server id or a catalogue key to test.')
      const planned = planFor(key, 'local')
      if (!planned.ok) throw new Error(planned.error.reason)

      const result = await probeTarget(withHeaders(planned.plan.target))

      /*
       * Record what the test observed. A publisher's declaration is empty for
       * every OAuth-protected server, so a 401 seen here is better evidence
       * than anything the registry carries — and it stops the page claiming
       * "sign-in not required" about a server that just refused us.
       */
      const observed = result.ok ? 'open' : /\b(401|403)\b/.test(result.error ?? '') ? 'required' : null
      if (observed) {
        try {
          catalogue.saveOverlay(db(), { key, authObserved: observed })
        } catch {
          // A failed note must never fail the test itself.
        }
      }
      return result
    },

    'server:update': ({ serverId, name, target }) => {
      const server = repo.getServer(db(), serverId)
      if (!server) throw new Error(`No such server: ${serverId}`)
      const next = {
        ...server,
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(target ? { target } : {})
      }
      const saved = repo.upsertServer(db(), next)
      // A changed name or command has to reach every client that has it wired.
      for (const link of catalog.listServerClients(db(), serverId)) {
        if (link.installed) installServer({ ...saved, client: link.client })
      }
      return saved
    },

    'catalog:sync': (full) => sync.sync(!!full),
    'catalogue:search': (term) => sync.searchRemote(term),

    'catalog:favicons': async () => ({}),

    'catalog:icons': async (urls) => {
      const out: Record<string, string> = {}
      // Bounded: only what a page of results actually shows.
      const assetOrigin = catalog.readSyncState(db(), 'service.assetOrigin')
      const wanted = (urls ?? []).slice(0, 60).filter((url) => {
        try { return !!assetOrigin && new URL(url).origin === assetOrigin } catch { return false }
      })
      const results = await Promise.all(wanted.map(async (u) => [u, await icons.get(u)] as const))
      for (const [url, data] of results) if (data) out[url] = data
      return out
    },

    'servers:clients': () => catalog.listServerClients(db()),

    'servers:setClient': ({ serverId, client, installed }) => {
      const server = repo.getServer(db(), serverId)
      if (!server) throw new Error(`No such server: ${serverId}`)
      if (installed) {
        wireInto(server, client)
      } else {
        uninstallServer({ ...server, client })
        catalog.setServerClient(db(), serverId, client, false)
      }
      // `servers.installed` stays true while any client still has it wired.
      const links = catalog.listServerClients(db(), serverId)
      repo.upsertServer(db(), { ...server, installed: links.some((l) => l.installed) })
      return catalog.listServerClients(db())
    },

    'clients:manual': () => MANUAL_ONLY_CLIENTS,

    'clients:status': (): ClientStatusDto[] =>
      clientStatus().map((c) => ({
        id: c.id,
        label: c.label,
        configPath: c.configPath,
        present: c.present,
        serverCount: c.serverCount,
        configModifiedAt: c.configModifiedAt,
        gatewayCapable: c.format === 'json'
      })),

    'config:health': () => configHealth(repo.listServers(db())),

    'app:info': () => ({
      version: app.getVersion(),
      home: bridgeHome(),
      socket: controlSocketPath(),
      proxyPath: proxyScriptPath(),
      online: control.connectionCount,
      packaged: app.isPackaged
    }),

    'app:revealLogs': () => {
      void shell.openPath(join(bridgeHome(), 'logs'))
    }
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event)) {
        log.warn(`rejected "${channel}" from an untrusted frame: ${event.senderFrame?.url ?? 'unknown'}`)
        throw new Error('This request did not come from Bridge.')
      }
      try {
        return await (handler as (...a: unknown[]) => unknown)(...args)
      } catch (err) {
        // Surface a clean message; the stack stays in the main-process log.
        throw new Error((err as Error).message)
      }
    })
  }
}
