/** Domain types shared by the main process, the proxy processes and the UI. */

import type { GrantSpec } from './action-grant'

export type ClientId = 'claude-desktop' | 'claude-code' | 'cursor' | 'vscode' | 'windsurf' | 'dsh' | 'other'

export interface StdioTarget {
  kind: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface HttpTarget {
  kind: 'http'
  /** Streamable-HTTP or SSE endpoint of a remote MCP server. */
  url: string
  headers?: Record<string, string>
}

export type UpstreamTarget = StdioTarget | HttpTarget

export interface ManagedServer {
  id: string
  name: string
  client: ClientId
  target: UpstreamTarget
  enabled: boolean
  /** Set once Bridge has rewritten the client config to point at the proxy. */
  installed: boolean
  /** Catalogue entry this was installed from, when it came from the Library. */
  catalogueKey: string | null
  createdAt: number
  updatedAt: number
}

export type PolicyEffect = 'allow' | 'ask' | 'deny'
export type DecidedBy = 'policy' | 'user' | 'default' | 'offline'

export interface PolicyMatch {
  /** Server id, or '*' / undefined for any. */
  serverId?: string
  /** Glob or `re:` pattern over the client's reported `clientInfo.name`. */
  clientName?: string
  /** Glob over the tool name, e.g. 'sheets_*' or '*'. */
  tool?: string
  /** JSON-RPC method, defaults to 'tools/call'. Glob. */
  method?: string
  /** Dot path into the arguments object, e.g. 'path' or 'message.body'. */
  argPath?: string
  /** Regex tested against the value at argPath, or against all args when argPath is unset. */
  argMatches?: string
}

export interface PolicyRule {
  id: string
  enabled: boolean
  /** Lower numbers are evaluated first; first match wins. */
  priority: number
  name: string
  description?: string
  match: PolicyMatch
  effect: PolicyEffect
  /** Regexes applied to tool results before they reach the model. */
  redactResult?: string[]
  createdAt: number
  updatedAt: number
}

export type CallStatus =
  | 'pending'
  | 'awaiting-approval'
  /**
   * Bridge allowed the call and does not know what happened next.
   *
   * The Claude Code hook decides at `PreToolUse`, before the tool runs, so
   * "completed" would be a claim Bridge cannot make. A record stays here until
   * `PostToolUse` reports the outcome — and stays here for good if that never
   * arrives, which is the honest end state rather than a false success.
   */
  | 'permitted'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'cancelled'

export type FindingType =
  | 'injection'
  | 'secret'
  | 'pii'
  | 'tool-changed'
  | 'oversize'
  | 'invisible-text'
  /** A live grant covered this tool but one of its conditions did not hold. */
  | 'grant-scope'

export type Severity = 'low' | 'medium' | 'high'

export interface Finding {
  type: FindingType
  severity: Severity
  label: string
  detail?: string
  side: 'args' | 'result' | 'meta'
  /** Short, already-redacted snippet showing where the match landed. */
  excerpt?: string
}

/** Changes made to a result for context rather than security (see shared/shaping). */
export interface ResultShaping {
  /** Set when the result was trimmed: its size before and after, in estimated tokens. */
  trimmedFromTokens?: number
  deliveredTokens?: number
  /** Set when a repeat note was added: how many identical calls in a row this was. */
  repeatCount?: number
}

export interface CallRecord {
  id: string
  sessionId: string
  serverId: string
  serverName: string
  client: ClientId
  method: string
  tool: string | null
  args: unknown
  result: unknown | null
  error: { code: number; message: string; data?: unknown } | null
  status: CallStatus
  decision: PolicyEffect | null
  decidedBy: DecidedBy | null
  ruleId: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  resultBytes: number | null
  /** chars/4 heuristic — an estimate, not a billed count. */
  tokenEstimate: number | null
  findings: Finding[]
  redacted: boolean
  /** What Bridge changed in the result for the model's sake; null when nothing. */
  shaping?: ResultShaping | null
  /**
   * Correlation key for the Claude Code hook, which decides a call in one
   * process and learns its outcome in another. Null for MCP calls, where a
   * single interceptor owns both ends.
   */
  hookKey?: string | null
}

export interface SessionRecord {
  id: string
  serverId: string
  serverName: string
  client: ClientId
  pid: number
  startedAt: number
  endedAt: number | null
  serverInfo: { name?: string; version?: string; protocolVersion?: string } | null
  /**
   * How the client identified itself in `initialize`. An AI client that runs
   * several surfaces (Claude Desktop's Chat and Cowork) starts one server per
   * surface, and this is the only standard place it can say which is which.
   */
  clientInfo: { name?: string; version?: string; title?: string } | null
}

export interface ToolRecord {
  serverId: string
  name: string
  /** False hides the tool from the client entirely — see ARCHITECTURE.md §6c. */
  enabled: boolean
  description: string
  schema: unknown
  /** Bumped whenever description or schema changes — a "rug pull" signal. */
  revision: number
  fingerprint: string
  firstSeenAt: number
  lastSeenAt: number
  changedAt: number | null
}

export interface ApprovalRequest {
  /** Sensitive payload exceptions cannot create reusable tool grants. */
  onceOnly?: boolean
  id: string
  sessionId: string
  serverId: string
  serverName: string
  tool: string
  args: unknown
  findings: Finding[]
  ruleId: string | null
  requestedAt: number
  /** Wall-clock ms after which the proxy stops waiting and applies the fallback. */
  timeoutMs: number
}

export type ApprovalScope = 'once' | 'session' | 'always'

export interface ApprovalResult {
  id: string
  effect: 'allow' | 'deny'
  scope: ApprovalScope
  /**
   * A bounded permission to create alongside an allow, so authorising the first
   * step of a task can authorise the rest of it. Refused for a once-only
   * prompt (a credential gate), and always validated in the main process.
   */
  grant?: GrantSpec
}

export interface Settings {
  /** Fresh approval for every tool call, irrespective of remembered grants. */
  strictActionApproval: boolean
  /**
   * Enforce on Claude Code's native tools (Bash, Edit, Write…) through its
   * PreToolUse hook. Off means the installed hook decides nothing and defers to
   * Claude Code's own settings, so enabling and disabling never requires
   * editing that file again.
   */
  claudeCodeHook: boolean
  /** Stops new routed tool calls; does not revoke provider credentials. */
  pauseToolCalls: boolean
  /** Applied when no rule matches. */
  defaultEffect: PolicyEffect
  /** Applied to an 'ask' decision when the Bridge UI is not reachable. */
  offlineAskFallback: 'allow' | 'deny'
  approvalTimeoutMs: number
  /** Ask again the first time a tool's description or schema changes. */
  askOnToolChange: boolean
  scanInjection: boolean
  scanSecrets: boolean
  /** Action for high-confidence credential-shaped values in tool arguments. */
  credentialAction: 'flag' | 'ask' | 'deny'
  /** Strip findings out of tool results instead of only flagging them. */
  redactOnFinding: boolean
  /** Days of trace history to keep. 0 = forever. */
  retentionDays: number
  /** Persist full request/response bodies. Off = metadata only. */
  storePayloads: boolean
  maxPayloadBytes: number
  launchAtLogin: boolean
  /**
   * Where the catalogue is synced from. Defaults to the public MCP registry;
   * point it at your own service to serve a curated catalogue instead. The
   * local SQLite file stays the working copy either way, so the app keeps
   * working offline.
   */
  catalogueSourceUrl: string
  /**
   * Trim tool results above this many estimated tokens before they reach the
   * model. 0 = never. The trace keeps the result as the server sent it.
   */
  maxResultTokens: number
  /** Tell the model when it repeats an identical call and gets an identical result. */
  annotateRepeats: boolean
  /**
   * Clients whose config holds one `bridge` gateway entry instead of one entry
   * per server (see proxy/gateway.ts).
   */
  gatewayClients: ClientId[]
  /** How the gateway shows its tools: all of them, or search_tools + call_tool. */
  gatewayToolMode: 'auto' | 'all' | 'search'
}

export const DEFAULT_SETTINGS: Settings = {
  strictActionApproval: true,
  claudeCodeHook: false,
  pauseToolCalls: false,
  defaultEffect: 'allow',
  offlineAskFallback: 'deny',
  approvalTimeoutMs: 120_000,
  askOnToolChange: true,
  scanInjection: true,
  scanSecrets: true,
  credentialAction: 'ask',
  redactOnFinding: false,
  retentionDays: 30,
  storePayloads: true,
  maxPayloadBytes: 256 * 1024,
  launchAtLogin: false,
  catalogueSourceUrl: '',
  maxResultTokens: 25_000,
  annotateRepeats: true,
  gatewayClients: [],
  gatewayToolMode: 'auto'
}

export interface CallQuery {
  limit?: number
  before?: number
  serverId?: string
  status?: CallStatus
  /** Only calls carrying at least one finding. */
  flaggedOnly?: boolean
  search?: string
}

export interface StatsSummary {
  totalCalls: number
  last24h: number
  denied: number
  /** Ended in an error, from the server or from the tool itself. */
  failed: number
  flagged: number
  avgDurationMs: number
  tokensEstimated: number
  byServer: Array<{ serverId: string; serverName: string; calls: number; flagged: number }>
  byTool: Array<{ tool: string; calls: number; avgMs: number }>
}
