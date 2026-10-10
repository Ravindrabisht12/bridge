import type { ActionGrant, CreateActionGrant } from './action-grant'
import type { HookStatus } from './hook'
import type { CoverageReport } from './coverage'
import type {
  ApprovalRequest,
  ApprovalResult,
  CallQuery,
  CallRecord,
  ManagedServer,
  PolicyRule,
  SessionRecord,
  Settings,
  StatsSummary,
  ToolRecord
} from './types'
import type { ProxyToApp } from './control'
import type { CatalogueItem, CatalogueQuery, CustomEntry, Overlay } from './catalogue'
import type { ProbeResult } from './probe'
import type { InstallPlan } from './install'
import type { SyncProgress } from './syncprogress'

export interface DiscoveredServerDto {
  client: ManagedServer['client']
  clientLabel: string
  name: string
  target: ManagedServer['target']
  wrapped: boolean
  wrappedServerId: string | null
  /** Set when this discovery already corresponds to a Bridge-managed server. */
  managedId: string | null
}

export interface ConfigHealth {
  serverId: string
  name: string
  client: ManagedServer['client']
  configPath: string
  /** True when Bridge is running unpackaged, so the paths are build artifacts. */
  dev: boolean
  problems: string[]
}

export interface ClientStatusDto {
  id: ManagedServer['client']
  label: string
  configPath: string
  present: boolean
  serverCount: number
  /** Last write time of the config file, for staleness detection. */
  configModifiedAt: number | null
  /** Whether this client can use the single gateway entry. */
  gatewayCapable: boolean
}

/** Every renderer→main call. Keys double as the IPC channel names. */
export interface IpcApi {
  'security:grants': () => ActionGrant[]
  'security:grant': (input: CreateActionGrant) => ActionGrant
  'security:revoke': (id: string) => void
  'security:coverage': () => CoverageReport
  /** Whether Claude Code's PreToolUse hook currently points at this build. */
  'hook:status': () => HookStatus
  'hook:install': () => HookStatus
  'hook:uninstall': () => HookStatus
  /** The settings stanza to paste, for a user who would rather not be edited. */
  'hook:snippet': () => { settingsPath: string; snippet: string }
  'calls:query': (q: CallQuery) => CallRecord[]
  'calls:get': (id: string) => CallRecord | null
  'calls:stats': () => StatsSummary
  'calls:export': (q: CallQuery) => { path: string; count: number } | null
  'calls:purge': (olderThanDays: number) => number

  'servers:list': () => ManagedServer[]
  'servers:discover': () => DiscoveredServerDto[]
  'servers:import': (input: { name: string; client: ManagedServer['client']; target: ManagedServer['target'] }) => ManagedServer
  'servers:install': (id: string) => ManagedServer
  'servers:uninstall': (id: string) => ManagedServer
  'servers:remove': (id: string) => void
  'servers:sessions': () => SessionRecord[]
  'servers:tools': (serverId?: string) => ToolRecord[]
  'tools:setEnabled': (input: { serverId: string; names: string[]; enabled: boolean }) => ToolRecord[]

  'rules:list': () => PolicyRule[]
  /** How often each rule has decided a call. */
  'rules:stats': () => Array<{ ruleId: string; matches: number; lastMatchedAt: number }>
  'rules:save': (rule: PolicyRule) => PolicyRule
  'rules:delete': (id: string) => void
  'rules:reset': () => PolicyRule[]

  'settings:get': () => Settings
  'settings:set': (patch: Partial<Settings>) => Settings
  /** Moves a client to one gateway entry or back to one entry per server. */
  'gateway:set': (args: { client: ManagedServer['client']; enabled: boolean }) => Settings

  'approvals:pending': () => ApprovalRequest[]
  'approvals:resolve': (result: ApprovalResult) => boolean

  /* ---- unified catalogue: registry mirror + operator overlay + custom ---- */
  'catalogue:query': (q: CatalogueQuery) => { items: CatalogueItem[]; total: number }
  'catalogue:get': (key: string) => CatalogueItem | null
  'catalogue:facets': () => {
    total: number
    bySource: Record<string, number>
    byTier: Record<string, number>
    featured: number
    custom: number
  }
  'catalogue:tags': () => string[]
  /** Re-apply the curated front page. Never overwrites your own ranks. */
  'catalogue:reseed': () => {
    applied: boolean
    picksApplied: number
    picksMissing: string[]
    customApplied: number
    skippedByOperator: string[]
  }
  /** Plan an install from any catalogue entry, registry or custom. */
  'catalogue:plan': (input: { key: string; prefer: 'local' | 'remote' }) =>
    | { ok: true; plan: InstallPlan }
    | { ok: false; error: { reason: string } }
  'catalogue:install': (input: {
    key: string
    serverName: string
    prefer: 'local' | 'remote'
    values: Record<string, string>
    /** Value keys that should be sent as HTTP headers rather than env vars. */
    headerNames?: string[]
    clients: ManagedServer['client'][]
  }) => { serverId: string; installedInto: string[]; failed: Array<{ client: string; reason: string }> }
  'overlay:save': (patch: Partial<Overlay> & { key: string }) => Overlay
  'custom:list': () => CustomEntry[]
  'custom:save': (entry: Omit<CustomEntry, 'createdAt' | 'updatedAt'>) => CustomEntry
  'custom:delete': (id: string) => void
  /** Runs the MCP handshake against a target and reports what came back. */
  'server:probe': (input: {
    serverId?: string
    key?: string
    /** Extra headers to try, for a hosted server that needs a token. */
    headers?: Record<string, string>
  }) => ProbeResult
  /** Post-install edits: rename, change command/args/env/url. */
  'server:update': (input: {
    serverId: string
    name?: string
    target?: ManagedServer['target']
  }) => ManagedServer

  /* ---- registry sync and icons; the rest of catalog:* is superseded by
     catalogue:*, which unifies the registry with custom entries ---- */
  'catalog:sync': (full: boolean) => SyncProgress
  /** Look one term up in the registry without downloading the whole catalogue. */
  'catalogue:search': (term: string) => { found: number; error?: string }
  /** Data URIs for publisher icons, fetched and cached by the main process. */
  'catalog:icons': (urls: string[]) => Record<string, string>
  /** Vendor favicons by domain, fetched and cached by the main process. */
  'catalog:favicons': (domains: string[]) => Record<string, string>

  'servers:clients': () => Array<{ serverId: string; client: ManagedServer['client']; installed: boolean }>
  'servers:setClient': (input: {
    serverId: string
    client: ManagedServer['client']
    installed: boolean
  }) => Array<{ serverId: string; client: ManagedServer['client']; installed: boolean }>

  'clients:status': () => ClientStatusDto[]
  'clients:manual': () => Array<{ id: string; label: string; reason: string }>
  'config:health': () => ConfigHealth[]
  'app:info': () => {
    version: string
    home: string
    socket: string
    proxyPath: string
    online: number
    packaged: boolean
  }
  'app:revealLogs': () => void
}

export type IpcChannel = keyof IpcApi

/** main→renderer pushes. */
export type MainEvent =
  | { t: 'trace'; event: ProxyToApp }
  | { t: 'approval'; request: ApprovalRequest }
  | { t: 'approval.resolved'; id: string }

export const MAIN_EVENT_CHANNEL = 'bridge:event'
