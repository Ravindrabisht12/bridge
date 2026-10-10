# Bridge — Architecture

*The center of your AI stack.*

Bridge makes MCP tool calls visible and governable. It sits between an AI
client (Claude Desktop, Cursor, VS Code, Windsurf) and the MCP servers that
client talks to, so that every tool call is recorded, policed, and inspectable
after the fact.

The problem it solves: today, when a model answers "what's the weather in
Almora?", a tool ran somewhere. You don't know which server handled it, what
arguments left your machine, what came back, or whether what came back tried to
manipulate the model. You approved a permission prompt once, months ago, and
have been flying blind since.

---

## 1. Design principles

**Be in the path, not beside it.** Observability that samples or reconstructs
after the fact will miss exactly the calls that matter. Bridge is a real proxy;
every byte of JSON-RPC passes through it.

**Infrastructure fails open, policy fails closed.** If the database is
unreadable, the control socket is gone, or a scanner throws, traffic still
flows — Bridge just records less. But if a rule says *ask* and no human can be
asked, the call is refused. Breaking someone's tooling because our SQLite file
was locked is unacceptable; silently allowing an unreviewed `delete_all` because
our UI was closed is worse.

**The client must never notice.** stdout carries JSON-RPC and nothing else.
Diagnostics go to a log file. An unrecognised message is forwarded verbatim
rather than parsed-and-rebuilt, so protocol features Bridge doesn't know about
keep working.

**Local by default.** The database, logs, and socket live on the user's machine.
Bridge makes no network calls of its own. The only remote traffic is the
upstream MCP servers the user already configured.

---

## 2. Process model

The critical constraint: **Bridge does not launch the proxies.** The AI client
does. Claude Desktop reads its config, sees a command, and spawns it. So each
proxy is an independent process with no parent relationship to the Bridge app,
and the two must find each other at runtime.

```
┌──────────────────────┐         ┌──────────────────────┐
│   Claude Desktop     │         │   Bridge.app        │
│   (or Cursor, …)     │         │   (Electron)         │
│                      │         │                      │
│  spawns per server   │         │  main process        │
└──────────┬───────────┘         │   ├── ControlServer  │
           │ stdio               │   ├── IPC handlers   │
           │ (JSON-RPC)          │   └── SQLite (reads) │
           ▼                     │  renderer (React)    │
┌──────────────────────┐         └──────────┬───────────┘
│  bridge proxy #1    │                    │
│  ├── LineDecoder     │   control socket   │
│  ├── Interceptor  ───┼────────────────────┤  live events
│  ├── PolicyEngine    │   (UDS / pipe)     │  approval req/resp
│  ├── Scanners        │                    │  config push
│  └── SQLite (writes) ├────────────────────┘
└──────────┬───────────┘         ▲
           │ stdio or HTTP       │
           ▼                     │
┌──────────────────────┐  ┌──────┴───────────┐
│  real MCP server #1  │  │ bridge proxy #2 │  … one per server
└──────────────────────┘  └──────────────────┘
```

Two channels connect a proxy to the app, and they carry different guarantees:

| Channel | Direction | Guarantee | Carries |
|---|---|---|---|
| SQLite (WAL) | proxy writes, app reads | Durable. Survives app being closed. | Traces, sessions, tool inventory |
| Control socket | bidirectional | Best-effort. Absent when app is closed. | Live UI updates, approval prompts, config pushes |

Recording never depends on the app being open. Only *interactive* approval does.

---

## 3. The path of one tool call

```
client                proxy                                       server
  │  tools/call ───────▶│
  │                     │ 1. scan arguments for secrets / PII
  │                     │ 2. evaluate policy rules → allow | ask | deny
  │                     │ 3. if the tool definition changed, escalate to ask
  │                     │ 4. if ask → control socket → user clicks
  │                     │
  │                     │─── deny ──▶ record, synthesise JSON-RPC error
  │  ◀── error ─────────│            (the model is told, in words, that the
  │                     │             user did not authorise the call)
  │                     │
  │                     │─── allow ─────── tools/call ──────────────▶│
  │                     │◀────────────────── result ─────────────────│
  │                     │ 5. scan result for injection & credentials
  │                     │ 6. strip invisible characters, apply redaction
  │                     │ 7. record: latency, bytes, token estimate, findings
  │  ◀── result ────────│
```

Steps 1–3 are synchronous and sub-millisecond. Step 4 is the only one that
blocks, and it blocks *that call only* — `handleFromClient` is async and is not
awaited by the read loop, so other requests continue to flow while a prompt is
open. Correlation is by JSON-RPC `id`, so out-of-order completion is fine.

### Why the deny path synthesises an error rather than dropping the message

A dropped request hangs the client forever. A JSON-RPC error with a
human-readable message lets the model tell the user "I tried to delete that row
and wasn't allowed", which is the behaviour you want. The error code is
`-32001` (Bridge-specific) so a client can distinguish policy refusal from a
server fault.

---

## 4. Components

| Path | Role |
|---|---|
| `src/shared/jsonrpc.ts` | JSON-RPC types, `LineDecoder` for newline-delimited stdio framing |
| `src/shared/control.ts` | Proxy↔app wire protocol, platform paths (home, socket, database) |
| `src/shared/types.ts` | Domain model shared by all three process kinds |
| `src/policy/engine.ts` | Rule evaluation — first match by priority wins |
| `src/policy/matcher.ts` | Glob / `re:` pattern matching, dot-path argument lookup |
| `src/policy/defaults.ts` | The seeded starter policy |
| `src/scanners/injection.ts` | Prompt-injection and invisible-text detection |
| `src/scanners/secrets.ts` | Credential and PII detection, Luhn validation, masking |
| `src/scanners/index.ts` | Content-block text extraction, redaction, severity ranking |
| `src/db/schema.ts` | Forward-only migrations |
| `src/db/repo.ts` | All SQL. Nothing else in the codebase writes queries |
| `src/proxy/cli.ts` | Proxy entry point, lifecycle, signal handling |
| `src/proxy/interceptor.ts` | The decision core — policy, scanning, recording, correlation |
| `src/proxy/transports/` | `stdio` (child process) and `http` (Streamable HTTP + SSE) upstreams |
| `src/proxy/control-client.ts` | Reconnecting link to the app; approvals |
| `src/main/control/server.ts` | Socket server, approval routing, config broadcast |
| `src/main/services/clients.ts` | Config discovery, install/uninstall, atomic writes with backups |
| `src/main/ipc/handlers.ts` | The complete renderer→main surface |
| `src/shared/toolrisk.ts` | Tool capability classification and context-cost estimation |
| `src/renderer/` | React UI: overview, trace, tools, servers, policy, settings |
| `src/renderer/styles.css` | Design tokens; light default with a `[data-theme="dark"]` layer |

---

## 4b. Two enforcement surfaces, one decision

Bridge decides on two kinds of activity, and the decision itself lives in
exactly one place — `policy/decide.ts`.

| Surface | Entry | Covers |
|---|---|---|
| MCP proxy | `out/main/proxy.js` | tool calls from any configured client to a routed server |
| Claude Code hook | `out/main/hook.js` | `Bash`, `Edit`, `Write`, `Read`, `WebFetch`… via `PreToolUse` + `PostToolUse` |

The hook exists because the most dangerous thing an agent in Claude Code can do
is run a shell command, and that never touches MCP. A product that only watched
MCP would be watching the safer half.

`decide()` is shared deliberately. A security decision implemented twice
eventually differs in one of them; each surface keeps only its own recording and
prompting. The hook is a proxy with no upstream: same rules, same grants, same
`calls` table (`method = 'hook/PreToolUse'`), and Claude Code's decision shape
on stdout instead of a forwarded JSON-RPC message.

### Two things the hook got wrong first

Both were found by running it, not by reading it.

1. **It exited 0 with no output.** stdin is consumed and every timer in the
   control client is unref'd — correct for the proxy, whose stdin holds it open,
   and fatal here. Node found nothing left to do and exited *mid-wait*, so
   Claude Code received an empty response and quietly applied its own settings
   to the calls Bridge was meant to decide. A referenced keep-alive handle spans
   the wait.
2. **stdout was truncated.** A pipe write is asynchronous and `process.exit`
   discards it. Every decision is now awaited to drain before exit.

Both failures were silent and both defeated the point of the hook, which is why
`e2e/hook.js` drives the built binary rather than the source.

### Permitted is not completed

`PreToolUse` fires *before* the tool runs, so the record it writes cannot claim
a result. It is stored as `permitted` — Bridge allowed this, and does not know
what happened next — and only `PostToolUse` moves it to `completed` or `failed`.

This started as a labelling bug. The decision hook wrote `completed`, so a
`bash:mysql` row read as a success when all it meant was "Bridge let this run".
For the question the hook exists to answer — *an agent broke my site, what did
it do?* — that is the wrong answer, confidently phrased.

A record that never receives its outcome stays `permitted` for good. That is the
honest end state: the hook may be half-registered, or Claude Code may have been
killed mid-command. Both events are therefore registered and removed together,
and `installed` is false unless both point at this build — a `PreToolUse`-only
install decides calls but never explains them, which the UI reports as *partly
installed* rather than hiding behind "not installed".

### Correlating the two halves

The two events arrive in separate processes with no shared id, so both derive
the same `hook_key` from what they both see: session, tool name, and canonical
arguments. `PostToolUse` claims the newest record with that key still in
`permitted`, which means:

- a second outcome for the same call cannot reopen a finished record;
- an outcome for a call Bridge never decided creates nothing, rather than
  putting activity in the trace it cannot vouch for;
- only two genuinely identical parallel calls can collide, and either row is
  then equally correct.

Failure is read conservatively from the response — `is_error`, `interrupted`, a
non-zero exit code — because `PostToolUse` firing at all only proves the tool
ran. Absence of an error marker means "nothing said otherwise", not "verified
successful", and the raw response is stored either way since that is what a
post-mortem actually reads.

The output is scanned for credentials like any other result, but the hook
**cannot redact it**: the command has already run and Claude Code already has
the text. The finding is evidence that something leaked, not prevention.

### Naming a shell command

`Bash` alone is useless in a rule or a trace: every shell command would share
one name. `hookToolName` renames it after its program — `bash:rm`, `bash:git` —
so a rule can target one, and falls back to plain `bash` rather than inventing a
name it cannot trust. The full command still lands in the arguments.

### Enforcement is a setting, not an install

`claudeCodeHook` defaults **off**. An installed hook that decides nothing and
defers to Claude Code is a valid state, so enabling and disabling never means
editing that file again. The install itself is surgical: Bridge's entry is
recognised by the hook script path, only that entry is added or removed, other
tools' hooks survive, the file is never rewritten if it cannot be parsed, and a
backup is kept the first time. The transformation lives in
`shared/hook-settings.ts` with no filesystem access, because the code that can
destroy somebody's configuration is the code that has to be directly testable.

---

## 5. Transports

**stdio** — the common case. The proxy spawns the real server as a child,
forwards stdin/stdout, and routes the child's *stderr* to a log file. That last
part matters: many MCP servers log freely to stderr, and anything that reaches
the client's stdout channel corrupts the protocol stream.

**HTTP** — remote servers. Each message is POSTed; the reply is either
`application/json` or an SSE stream, and a background `GET` stream carries
server-initiated messages. The `Mcp-Session-Id` header is captured from the
first response and replayed on subsequent requests, and `DELETE` ends the
session on shutdown. POSTs are serialised through a promise chain so the session
id from the first exchange applies to everything after it.

Both implement one interface (`UpstreamTransport`), so the interceptor is
transport-agnostic.

---

## 6. Policy engine

A rule is a match plus an effect:

```ts
{
  priority: 10,
  match: { serverId?, tool?, method?, argPath?, argMatches? },
  effect: 'allow' | 'ask' | 'deny',
  redactResult?: string[]
}
```

Evaluation is deterministic: sort by `priority`, then `createdAt`; the first
match wins; no match falls through to `settings.defaultEffect`. Tool patterns
are `*`/`?` globs unless prefixed with `re:`, which switches to a regex — the
prefix exists because alternation (`re:(delete|drop)`) is genuinely needed and
silently escaping `|` inside a glob would be a trap.

`argPath` + `argMatches` test one argument rather than the whole blob, so
`{ argPath: 'path', argMatches: '\\.env$' }` matches a file argument and not an
unrelated sibling field that happens to mention `.env`. An invalid user-supplied
regex never matches and never throws.

Two things escalate a decision independently of the rules:

- **Tool-definition drift.** Every `tools/list` response is fingerprinted
  (`sha256(name, description, inputSchema)`). If a fingerprint changes, that
  tool's next call is forced to `ask`. This is the "rug pull" case: a server
  ships a benign tool, waits for approval, then quietly rewrites its description
  to carry instructions.
- **Session grants.** An approval answered with *this session* or *always* is
  remembered — in memory for the former, as a generated priority-5 rule for the
  latter, visible and deletable in the Policy tab like any other rule.

---

## 6a. Scoped permissions (grants)

A rule is permanent and a prompt is per-call. Neither fits the shape of real
work, which is "let the agent finish *this task* on *this target*". A grant is
the third thing: a bounded permission checked at the dispatch boundary.

```ts
{
  tools: ['wp_get_post', 'wp_update_post'],   // exact names, never globs
  constraints: [
    { path: 'site',    op: 'eq',  values: ['blog.example.com'] },
    { path: 'content', op: 'any', values: [] }   // payload, deliberately free
  ],
  expiresAt, remaining, sessionId: null         // null = survives a restart
}
```

### Why constraints, not a digest

The first implementation matched a SHA-256 of every argument. It was safe and
useless: real work never repeats identical arguments, so it only ever matched a
literal retry and reduced approval fatigue by exactly zero. Constraints cover
the work the user authorised while still blocking the work they did not.

The design rests on one distinction — an argument that *identifies the target*
(a host, an id, a status, a path) versus one that *carries the payload* (a body,
a message, a diff). `proposeConstraints` pins the first kind and leaves the
second free, using `looksLikeIdentifier`: short, single-line, mostly unspaced.
Pin a payload and you are back to the digest.

### Where a grant may and may not win

A grant replaces *only* the strict-mode prompt. It is consulted when, and only
when, the rules said `allow` and strict mode escalated that to `ask`. So an
explicit `ask`/`deny` rule, a credential gate, tool drift and pause all stay
authoritative — a grant can never widen a permission narrowed elsewhere. A
grant lookup that throws leaves the call needing approval.

### Claiming a use

Several proxies share one SQLite file, so a use is claimed with a conditional
decrement inside an immediate transaction keyed on the row id. Constraint
evaluation cannot be expressed in SQL, so candidates are narrowed in SQL and
matched in JS; losing the race falls through to the next candidate. A use counts
a *dispatch attempt*, not a business success — an upstream error still spends
one, because the request left the boundary.

A call that misses is explained: `explainGrantMiss` finds a live grant covering
that tool and names the condition that failed, so stepping outside a scope is
distinguishable from having no scope at all.

Bounds live in `validateGrantSpec` and are enforced in the **main** process, so
a compromised renderer cannot widen a grant. A credential-shaped value is
refused outright: a permission record is long-lived and shown in the UI.

---

## 6b. Reading the surface before anything runs

The most common state of a monitoring tool is "nothing has happened yet", and an
empty trace makes the product look broken when it is in fact working. Two things
are true the moment a server connects, and both are worth showing:

- The client asks every server for its tool list at startup, so the **full tool
  inventory** is known before any call. `src/shared/toolrisk.ts` classifies each
  tool as read / write / destructive / execute from its name, falling back to the
  description only when the name is uninformative — descriptions routinely
  mention verbs they do not perform ("list the cards you *created*").
- Every one of those definitions is serialised into the model's context on every
  request whether or not it is ever called, so `estimateToolTokens` puts a number
  on tool sprawl. A single 49-tool server measured ~4,500 tokens per
  conversation — spent before the user types a word.

Classification matches on a **tokenized** name: `\b` treats `_` as a word
character, so `\bshell\b` never matches `run_shell_command` without splitting
identifiers on `_`, `-` and camelCase boundaries first. Rules are ordered most-
to least-dangerous so `get_shell_output` reads as *execute*, not *read*.

This is triage, not a capability proof. MCP exposes no machine-readable "this
tool writes" signal, and a hostile server may name a destructive tool
`get_things` — which is exactly why the policy engine matches on arguments too,
and why tool-definition drift is tracked separately.

## 6c. Tool visibility

A client's own permission UI can only gate whether a tool is *called*. Sitting in
the path lets Bridge go further: a tool switched off in the Tools page is
**removed from the `tools/list` response** before the client ever sees it. From
the model's point of view it does not exist, which means it also stops consuming
context — hiding the 12 destructive tools on a 49-tool server reclaims roughly
900 tokens from every conversation.

Enforcement is in two places, because advertising and calling are separate steps:

1. `tools/list` responses are filtered against the per-server disabled set. The
   **full** inventory is still recorded first, so the Tools page can show what
   the server offers even while hiding most of it from the model.
2. `tools/call` for a disabled tool is refused with `-32001`. A client may be
   working from a cached list, and trusting step 1 alone would be a gap.

Toggling takes effect without restarting the AI client where possible. The app
pushes a `tools.prefs` message down the control socket; the proxy swaps its
disabled set and emits `notifications/tools/list_changed`, which prompts a
well-behaved client to re-request the list. Because the upstream server may not
declare that capability itself, the proxy rewrites the `initialize` response to
advertise `capabilities.tools.listChanged: true` — accurate, since Bridge
genuinely can change the list mid-session. Clients that ignore the notification
pick the change up on their next restart.

Preferences live in `tool_prefs` (schema v2) keyed by `(server_id, name)`, and a
missing row means enabled. Both the repository and the UI treat absence as
enabled rather than disabled: defaulting the other way would make any future
field mismatch silently hide every tool.

## 6c2. Shaping results for the model

Two changes are made for the model's sake rather than for security, in
`shared/shaping.ts`, after scanning and redaction:

1. **Trimming.** A result whose text exceeds `maxResultTokens` (default ~25k,
   0 = off) is cut on a line break near the limit, and a closing note tells the
   model to narrow the query. Only `content` text is cut. `structuredContent`
   passes through: a tool with an `outputSchema` must return it and a client may
   validate it, so dropping it would turn a long answer into an error.
2. **Repeat notes.** The third identical call in a row (same tool, same
   arguments with key order ignored) that returns an identical result gets a note
   appended. Arguments alone are not enough, because polling is legitimate; the
   count resets the moment the result changes. Nothing is blocked.

Errors are never shaped. The trace stores the result as the server sent it, and
`calls.shaping` (schema v12) records what the model received instead, so the
two never disagree silently.

## 6c3. DeepSeek Harness as a client

dsh has no `mcpServers` map. Each server is a Cordis row naming
`@deepseek-ai/dsh-mcp-client`, usually inside an `- insert:` list, and its
values may be `!!js` expressions that dsh evaluates at boot. Bridge reads and
writes only `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`), which applies to
every profile; per-profile patch files are not read.

Bridge cannot evaluate `!!js`, so it never copies those values out. Wrapping a
row swaps `transport`, `command` and `args` and leaves `env` and `cwd` in place:
dsh computes them and hands them to the proxy, whose child inherits both.
Remote headers are the exception, because the proxy needs them by name: they
move into `env` as `BRIDGE_HEADER__<name>`, and the proxy merges those over the
recorded headers. The original config node is saved as YAML under
`dsh-originals/` and restored verbatim on uninstall, tags included. The file
is edited through the YAML Document API, so comments and unrelated rows
survive.

## 6c4. One entry per client: the gateway

By default each server gets its own entry in a client's config. With the
gateway switched on for a client (Settings → Advanced), that client gets a
single `bridge` entry running `proxy.js --gateway --client <id>`, which starts
every server Bridge has wired to that client, each behind its own Interceptor.
Policy, approvals, the trace and result shaping are therefore identical to
direct wrapping; each upstream still gets its own session row.

The gateway shows the tools one of two ways. **All** lists every tool as
`<server>__<tool>`. **Search** lists two, `search_tools` (lexical BM25 over
tool name, server name and description, in `shared/tool-search.ts`) and
`call_tool`, so forty servers cost the context of two tool schemas. `auto`
switches to search above 40 tools. Through `call_tool`, a refusal or failure
comes back as an `isError` result the model can read, not a protocol error.

Which servers it runs: a `server_clients` row for that client decides; without
one, a server installed with that client as its home client counts. Install,
uninstall and the launch-time repair go through `clients.ts`, which knows the
gateway clients (`setGatewayClients`), so connecting a server to a gateway
client writes nothing but the gateway entry, and uninstalling writes the server
back as a direct entry.

What it does not do: resources and prompts are answered with empty lists, and
server-initiated requests (sampling, elicitation, roots) are refused. Servers
that need those should stay as separate entries. dsh is excluded, because its
rows can carry `!!js` values that would be lost if the row were removed. A
server connected while the client is running appears at the client's next
start.

## 6d. The Library: mirroring the registry

The official MCP Registry (`registry.modelcontextprotocol.io`) is the
npm-equivalent for MCP servers — namespaced, versioned, with publisher
ownership verified by GitHub or DNS. Bridge mirrors it locally rather than
querying it live, for two measured reasons:

- Remote search takes **~15 seconds** per query. Unusable while typing.
- The catalogue is **~27,500 servers over 276 pages**. It cannot be fetched
  per-search.

So the sync runs once (a few minutes), then incrementally via `updated_since`,
which moves only what changed. A stale catalogue (>24h) refreshes in the
background on launch; an empty one triggers a full pass. Search then runs in
SQLite and works offline.

`SHAPE_VERSION` guards a subtler failure: an incremental sync only touches
entries the registry reports as changed, so a build that starts capturing a new
field (icons, say) would leave it null forever on everything already stored. A
shape mismatch forces one full backfill pass.

### What the registry does and does not publish

| Wanted | Available? | How Bridge handles it |
|---|---|---|
| Hosted vs local | **Yes** — `packages` vs `remotes` | 14,058 hosted · 11,338 local · 1,423 either |
| Publisher identity | **Yes** — verified namespace | Trust badge, from `io.github.*` / DNS |
| Icons | **Yes** — `icons[]`, on ~7% of entries | Fetched and cached by the main process |
| Paid vs free | **No such field** | Not claimed. Replaced by a derivable facet |
| Popularity / trending | **No such field** | Real npm + PyPI weekly downloads instead |
| Categories | **No such field** | Inferred from name + description, labelled as such |

There is no price, licence, tier or cost field anywhere in the 2025-12-11
schema. A Paid/Free badge would therefore be a guess wearing the costume of a
fact — precisely what this app exists to argue against. What *is* derivable, and
is usually the real question, is whether a server needs an account at all:
`facetsOf` reports **needs an account** when the publisher declares required
credentials (5,536 servers) and **no sign-up** when it declares none (21,680).
The copy says outright that cost is unknown, and a test asserts it never claims
otherwise.

### Finding an icon that is not blurry

Asking for `/favicon.ico` and stopping there produced two visible failures: the
file is typically 16 or 32 pixels and the Library draws it at 30 CSS pixels — 60
physical on a retina display — so GitHub, ClickUp and PayPal looked smeared; and
several vendors publish nothing at the conventional paths at all, so Notion and
Figma rendered as a blank monogram and read as untrustworthy.

`favicon.ts` therefore does roughly what a browser does. It gathers candidates
from the conventional paths *and* from `<link rel="icon">` tags and the web app
manifest, ranks them largest-first, and measures the winner's real width from
the PNG IHDR header rather than trusting the declared `sizes` (ClickUp
advertises a 16×16 as its primary icon while shipping a 512×512 in its
manifest). Results per domain:

| | before | after |
|---|---|---|
| Notion | none | 512px |
| Figma | none | vector |
| GitHub | 16px ico | vector |
| ClickUp | 16px | 512px |
| PayPal | 16px ico | 258px |

SVG is accepted because these render in an `<img>`, which has no scripting
context — unlike inline `<svg>`, `<object>` or `<embed>`.

Two details that only showed up in testing. `.ico` is ranked last but held back
as an explicit fallback rather than truncated away: capping the attempt list
lost Canva, MongoDB and Asana entirely, because a 16-pixel `.ico` is genuinely
all they publish. And the rendered `<img>` is constrained with `max-width`
rather than sized with `width`, so a small icon draws at its natural size
instead of being upscaled into a blur.

Resolution is cached per domain, since parsing a homepage is far too expensive
to repeat per render.

### Icons without a tracking beacon

Registry icons are URLs on each publisher's own domain. Loading them from the
renderer would mean every publisher whose row scrolls into view learns the
viewer's IP and the time they looked — a beacon per entry, in an app whose
premise is showing what leaves your machine — and would require loosening the
renderer's CSP to permit remote images.

Instead `IconCache` fetches in the main process, over https only, restricted to
the five MIME types the spec allows, capped at 256 KB, cached on disk by URL
hash, and handed to the renderer as a `data:` URI. One fetch per icon ever, no
per-view beacon, CSP untouched. Raster is preferred over SVG so the cache never
has to reason about executable markup. The ~93% of entries with no icon get a
deterministic coloured monogram.

## 6e. The catalogue: three layers, one list

The Library is not a view of the registry. It is a view of *your* catalogue,
which has three layers with different owners and different trust:

```
  registry   mirrored from registry.modelcontextprotocol.io. Read-only.
             Replaced wholesale on sync. ~27,500 entries.
      +
  overlay    your annotations on an entry: pricing tier, featured rank, tags,
             rating, notes, hidden. Stored beside the entry, never inside it.
      +
  custom     entries the registry has never heard of: a local command, a
             self-hosted URL, a git checkout. First-class, not a second list.
```

Keeping the first two apart is the entire point. A sync must be free to replace
a registry row without destroying curation, and the UI must be able to say *who*
asserted a fact. `catalog_overlay` is keyed by the same key as the entry, so an
`INSERT OR REPLACE` on `catalog` cannot touch it — there is an e2e check named
"a registry update does not clear the operator overlay" that exists solely to
keep that true.

The union happens in **SQL**, not in the renderer:

```sql
SELECT … FROM catalog          -- registry half
UNION ALL
SELECT … FROM custom_entries   -- custom half, projected to the same columns
```

…left-joined against `catalog_overlay`. Fetching two lists and stitching them in
the UI would mis-sort and mis-count the moment either half exceeded a page.

One trap worth recording: the overlay columns are **aliased** (`o.tier AS
o_tier`), never splatted with `o.*`. Both tables carry `key` and `updated_at`,
and in a duplicate-name result the later column wins — so `o.*` would overwrite
the entry's own `updated_at` and, whenever no overlay row existed, null out its
`key` entirely. Two e2e checks pin that behaviour.

### Why "top 500" does not exist, and what replaced it

The number was measured, not assumed:

| | |
|---|---|
| Active entries in the registry | 27,223 |
| First-party (verified domain == endpoint host) | 7,383 |
| …belonging to a recognisable company | **34** |

The bulk of the first-party set is MCP-hosting platforms (smithery.ai: 213
entries, wishpool.app: 125) and small startups. A list of 500 official servers
from major companies cannot be assembled from the registry, because those
servers were never published to it.

They exist anyway, just undocumented. `OFFICIAL_SERVERS` is therefore built by
probing each vendor's own domain, and an endpoint is admitted only on evidence
from the MCP spec:

- **mcp-oauth** — replied with `WWW-Authenticate: Bearer` carrying OAuth
  protected-resource metadata, which only an MCP server behind the spec's auth
  flow emits.
- **mcp-open** — answered the `initialize` handshake with JSON-RPC.

A bare 401/403 is *not* accepted: that is how `datadoghq.com` and an early
`sentry.io` guess were rejected as WAF responses rather than MCP servers. Two
vendors serve from a different domain entirely (GitHub at
`api.githubcopilot.com`, Sentry at `mcp.sentry.dev`) and were only found by
widening the patterns.

When a vendor is *already* in the registry, that row is promoted rather than
duplicated with a bundled stub: the registry row carries a real title,
description, version and icon, and two rows for one vendor is exactly what this
list exists to prevent. `findFirstPartyByDomain` does the lookup, and the
first-generation seed list was retired for the same reason — it featured
registry rows for vendors the directory now covers with verified evidence.

Titles are derived **on read**, not trusted from storage. A row synced by an
older build holds whatever the registry sent, and many first-party publishers
send the literal string `mcp`; deriving at read time means the directory is
correct immediately rather than after a multi-minute backfill.

The result is **66 first-party entries** — 50 bundled endpoints plus 11 registry
entries promoted. The Library defaults to this directory; "Everything" switches
to the full registry. Notably absent because no endpoint could be confirmed:
Google, Salesforce, Zendesk, Shopify, Twilio, Zoom.

### The connector card, and three bugs it exposed

The Library renders as a card grid — icon, name, a seal mark for first-party
entries, two-line description, facet tags, and a `+` (or a tick when installed).
Building it surfaced three defects that the table had been hiding:

- **Every card read "runs locally".** `facetsOf` took a `CatalogEntry` and read
  its `kind` field; unified catalogue items have no `kind`, and the call site
  cast the difference away with `as never`. It now takes `{ packages, remotes }`
  and derives hosting from the arrays that actually exist, so the type can no
  longer lie about it.
- **Every card read "no sign-up".** OAuth-protected servers declare no
  credential fields — the flow is interactive, so there is nothing for a
  publisher to list. The directory records how each endpoint answered, and
  `officialRequiresAuth` turns an `mcp-oauth` result into a real sign-in
  requirement.
- **Android Management API appeared among the official entries.** Promotion
  matched on *domain*, and Google publishes five products under
  googleapis.com, so an arbitrary one won. Matching is now on the exact
  endpoint host and path.

A fourth followed from fixing the third: `applyOfficial` only ever added the
`official` tag, so entries a previous version promoted by mistake kept it
forever. Re-applying now prunes any tagged entry the current list does not
cover, while leaving a rank the operator set by hand alone.

### Why the big names were invisible

Atlassian, Figma and Notion were in the catalogue all along — `com.atlassian/
atlassian-mcp-server`, `com.figma.mcp/mcp`, `com.notion/mcp`, serving
`mcp.atlassian.com`, `mcp.figma.com`, `mcp.notion.com`. They never surfaced for
a structural reason: they are **hosted**, so they ship no npm package, so they
have no download count, so a usage-ranked list put every small npm library above
them. Ranking by the only real signal available systematically buried exactly
the servers most people want.

Two fixes, one derivable and one editorial, kept apart on purpose:

**First-party (derivable).** The registry verifies namespaces by DNS, so
`com.atlassian` proves control of atlassian.com. When such an entry also serves
from a host under that same domain, the vendor is publishing its own endpoint
under its own verified name. `assessFirstParty` checks it and the UI shows an
"official" badge. Note what it does *not* mean: `app.seatcanvas` serving
seatcanvas.app is equally first-party, just smaller. Ownership and fame are
different axes and merging them would smuggle an editorial call in under a
factual label.

**Featured (editorial).** `seed.ts` is a curated front-page list, applied once
and labelled as curation. Two rules keep it honest: every endpoint in it was
probed and answered (all 401 — OAuth required, which proves the endpoint is
live rather than aspirational), and no pricing is claimed. Canva is there as a
bundled custom entry because it is in Anthropic's connector directory but was
never published to the registry, so nothing else could make it appear.

Re-seeding never overwrites operator curation: a pick is skipped if a featured
rank has already been set on it.

### Display titles

Many first-party publishers name the server itself `mcp` — Notion, Stripe,
PayPal, Wix and Cloudflare all publish `<vendor>/mcp` with no title — so the
last-path-segment fallback rendered a front page of rows all called "mcp". The
vendor identity lives in the namespace, so `displayTitle` reads it from there,
dropping the leading TLD label and trailing padding (`mcp`, `server`, `api`).

### Pricing is an assertion, and says so

`tier` is `unknown` until a human sets it, and the UI labels it "Not stated".
The registry has no pricing field, so the alternative was to guess — and a guess
in a badge is indistinguishable from a fact. Ratings are the same: yours, or
absent. Real download counts sit in a separate column and are labelled with
their source, so a curated pick and a usage number never collapse into one
score.

### Custom entries and the git line

`planCustom` maps a custom entry straight to a target — the operator already
said how to run it, so there is nothing to infer. Git entries are the deliberate
exception: a repository is not a runnable thing, and cloning and building a
stranger's repo on the user's behalf is a much bigger decision than "install
this". Bridge records the repo and asks for the command that runs the checkout.

### Local now, remote later

The catalogue lives in the same local SQLite file as everything else, which is
what makes search instant and offline. `settings.catalogueSourceUrl` is the
migration seam: point it at your own service answering `GET /v0/servers` in the
registry's shape and the sync pulls from there instead. The local database stays
the working copy either way — a served catalogue changes where entries come
from, not how the app reads them.

## 6f2. Authentication, and what the app can honestly claim

MCP splits authentication by transport:

- **stdio servers** take credentials as environment variables. There is no HTTP
  layer to challenge you, so a key is the only mechanism.
- **hosted servers** use OAuth 2.1 as specified by MCP: a `401` carrying
  `WWW-Authenticate: Bearer resource_metadata="…"`, then protected-resource
  metadata, then an authorization server offering `/authorize`, `/token`, PKCE,
  and usually dynamic client registration at `/register`. Traced live against
  Linear, Notion and Slack — Slack is the notable exception with no DCR, so it
  needs a pre-registered client id.

**Bridge does not yet run that OAuth flow.** This matters more than it sounds:
the AI client speaks stdio to the proxy, so it never sees the upstream's 401 and
never initiates a browser sign-in. Bridge is the HTTP client, so Bridge is the
party that must hold the token. Until that lands, hosted OAuth servers are
discoverable and testable through Bridge but not usable through it.

Two things stop the UI lying about this in the meantime:

- **The publisher's declaration is not trusted over evidence.** Registry entries
  for OAuth servers declare no credential fields — there is nothing to declare,
  the flow is interactive — which made the detail page say "Sign-in: Not
  required" about a server that had just refused with a 401. A connection test
  now records what it observed (`auth_observed` on the overlay) and the page
  reports that instead.
- **A hosted target accepts an operator-supplied header.** Many servers accept a
  personal access token, so there is now somewhere to put one; it is used for
  the test and carried into the install. That token is written into the client
  config in plaintext, which is the reason the keychain work is still
  outstanding.

## 6f. Connection testing

"Did it work?" is the first question after installing anything, and the only
previous way to answer it was to restart the AI client and watch for red.
`probeTarget` runs the real handshake — `initialize`, `notifications/initialized`,
`tools/list` — directly against the target and reports what came back: server
name and version, protocol version, tool count and names, elapsed time, and
whatever the process wrote to stderr.

It deliberately bypasses the proxy. The question is "does this server work", not
"does the proxy work", and mixing them makes a failure ambiguous.

Failure messages are the product here, so they name causes rather than relaying
`fetch failed`: a missing binary, a non-zero exit before the handshake, a
20-second stall, HTTP 401/403, an unresolvable host, a refused connection, an
expired certificate. undici buries the errno several levels down and sometimes
inside an `AggregateError`, so `errnoOf` walks the chain.

The same code is reachable from the shell, which is how it is tested:

```
ELECTRON_RUN_AS_NODE=1 <electron> out/main/proxy.js --probe '<target json>'
```

## 6g. Navigation

Seven destinations in one window, addressed by hash: `#/library`,
`#/library/io.github.owner%2Fname`, `#/servers`. Reloading stays put,
back/forward work, and a selected catalogue entry survives a refresh because it
lives in the URL rather than in component state.

Hash rather than the History API, deliberately: a packaged renderer loads from
`file://`, where pushing `/servers` produces a URL that cannot be reloaded —
the very problem routing is here to solve. And hand-rolled rather than React
Router, because a `hashchange` listener and two pure functions cover seven
routes without adding a dependency or a mental model.

Parsing lives in `@shared/route` with no DOM references, so it is unit-tested
directly; `useRoute` in the renderer holds only the listener and the two
navigation calls. Selecting an item uses `replaceState` so opening and closing a
detail pane does not fill the back stack.

## 6h. Making the non-Library pages carry their weight

Three problems ran across every page except the Library, and each was fixed at
the shared level rather than page by page.

**Icons lived in one page.** The Library resolved vendor icons privately, so
Servers, Tools, the trace and the Overview all fell back to coloured letters —
the same server looked like two different things depending where you were.
`VendorIcon` and `useVendorIcons` now hold both the lookup and the fallback, and
every page draws from them.

**Warnings crowded out content.** The Servers page opened with three stacked
banners filling half the viewport before a single server appeared. They collapse
into one line — "2 things to know — 1 client needs restarting · development
build" — that expands on demand.

**The policy page showed its implementation.** Every row led with its raw
matcher, `re:(exec|shell|bash|terminal|command|run_code|python|eval)`, which is
the least scannable part of a rule. `rulesummary.ts` reads a matcher back as a
sentence ("Tools mentioning exec, shell, bash and 4 more"), demotes the pattern
to a secondary line, and refers to rather than quotes a regex too long to read
inline. The page also now shows **how often each rule has actually decided a
call**, from the `rule_id` recorded on every trace row — without it, a rule that
never fires and one that blocks daily look identical.

**The Overview had no verdict.** Six identically weighted metric cards could
not answer the one question the page exists for — is anything wrong right now?
A Blocked of 0 and a Blocked of 12 rendered the same. `verdict.ts` now picks the
most severe thing that is true and says it in words ("4 calls blocked by
policy", "No client is connected right now", "All clear"), with the problems the
headline does not already name offered as chips that navigate to the page that
explains them. "All clear" is deliberately withheld when nothing is connected —
an empty install is not a healthy one. The capability mix, previously drawn
once per server row, is drawn once for everything exposed, which is the single
picture only Bridge can produce.

Two layout bugs fell out of that page. `.stack` is a flex column, and flex items
shrink by default — so a tall section inside the scroll area was squeezed and
its last row clipped rather than scrolled to. And `.split` was already the name
of the trace page's detail-pane layout, which sets `height: 100%`; reusing it
for the Overview's two columns left 700px of void under them.

One rendering bug fell out of the same review: `.table td { text-overflow:
ellipsis }` applied to every cell, so the 46-pixel checkbox column on the Tools
page rendered a stray "…" for its own clipped whitespace. Ellipsis is now opt-in
per column.

## 6i. Renames, and why they need code

The app has shipped under three names — Lantern, then Bridge. Renaming is not a
find-and-replace, because several of those strings were not words. They were
addresses.

**The data directory.** `bridgeHome()` resolves to
`~/Library/Application Support/Bridge`, and the database, icon cache and config
backups lived under the old names. The obvious guard — *migrate only if the new
home does not exist* — is wrong on macOS and Windows, because that path **is**
Electron's `userData` directory and Chromium has already created it (Cookies,
Local Storage, Preferences) before any of our code runs. Written that way it
silently skipped, and a fresh empty database appeared beside a 20 MB one. The
test is therefore whether `bridge.db` exists. `legacyHomes()` lists every past
location newest-first and the first one that actually holds a database wins, so
someone who installed at any point in that history still ends up with their
data; items move individually rather than renaming a directory over one that is
already there.

**The marker in client configs.** `isBridgeEntry()` decides whether a stanza in
`claude_desktop_config.json` is ours, and the reliable signal is the proxy
script path. A bare name match is not, and this got more dangerous with each
rename: "bridge" is an ordinary word in this domain, and `npx
home-assistant-bridge` is somebody else's server. Claiming it would rewrite a
config we do not own. So the name fallback — which exists only for entries
written by an older build under a different name — additionally requires the
`--id` flag that we always write and nobody else has a reason to.

**The environment variable.** `desiredEntry()` writes `BRIDGE_HOME`, which makes
every pre-rename entry differ from what we would write. That is exactly the
condition the stale-config check already looks for, so affected servers are
repaired on the next launch with no new machinery.

The socket path (`$TMPDIR/bridge-<uid>.sock`), the IPC channels, the preload
bridge and the `appId` all move together, so no compatibility shim is needed:
the app and the proxies that talk to it ship as one unit.

## 6j. Filters that stopped announcing themselves

The Library opened with eight controls above the results — scope, category,
pricing, source, tag, hosting, setup and sort — which reads as a form to fill in
before you are allowed to look at anything. Search and category do nearly all
the work; the rest now sit behind one **Filters** button that carries a count
when any of them are active, with a Clear inside. The bar is two controls and a
sort, and nothing was removed.

## 6k. The mark

The app icon is a suspension bridge, side-on, in white on one flat blue. It
replaced a mark with a three-stop gradient, a sheen layer, a blur filter and six
abstract strokes — the visual signature of a generated logo rather than a drawn
one, and read that way immediately.

**Size is a spec, not a taste.** Since Big Sur a macOS app icon is 824×824
artwork centred on a 1024×1024 canvas — roughly a 10% transparent margin on
every side. The system adds no padding of its own, so the first version, drawn
edge-to-edge, rendered about 20% larger than everything else in the Dock and
stood out for the wrong reason. Measured against the Electron apps already
installed on the dev machine, the icon now fills 80.9% of its canvas against
their 82.8% — their extra weight at the bottom is a baked-in drop shadow, which
this mark does not have, so its inset stays symmetrical.

**Small sizes get their own drawing.** Once the artwork is inset to that grid
there is not enough room at 64px and below for the side cables and the deck ends
to stay apart. `resources/icon-small.svg` therefore keeps only the parts that
survive — two towers, the sag between them, the deck — with every stroke
thickened so none falls below a pixel. `npm run icons` renders both sources and
assembles the iconset; it runs one Electron process per source, because a second
offscreen load in the same process fails with `ERR_FAILED`. The 18px mark in the
sidebar is a third drawing, for the same reason.

**Two attempts failed, for reasons worth recording.** An *arch* bridge with a
gap between deck and arch read as a table. Closing the gap and running the deck
to the tile edges — meant to suggest a span continuing past the frame — read as
a bag with a handle. The suspension silhouette survives being shrunk because its
parts are far apart (towers, cable, deck) rather than nested inside one another.
The side cables terminate exactly on the ends of the deck, so nothing floats.

## 6l. Why the icons were slow on every restart

The icon cache stored the bytes but not the decision. `resolveBest()` fetches a
vendor's homepage, parses `<link rel="icon">` and the web manifest, probes up to
eight candidate URLs and measures each PNG's real width to pick the largest —
and the winner it arrived at lived in an in-memory `Map`. Every launch started
with that map empty, so opening the Library re-ran the whole discovery for
around sixty domains, each fetch carrying an eight-second timeout, while the
grid sat on grey monograms. The bytes were on disk the entire time; nothing knew
which file to reach for.

`icon_resolution` (migration 8) makes the decision durable: `domain → icon_url,
resolved_at`, loaded into memory in a single query at startup. A `NULL`
`icon_url` is a real answer — "this domain has no usable icon" — worth
remembering so eight candidate probes are not repeated for it either.

Two details keep it honest. A remembered hit older than 30 days is **still
served immediately** and re-resolved in the background afterwards, because a
month-old icon beats a spinner; misses are retried after 7 days, since a vendor
adding a favicon is likelier than one changing theirs. And because the table
starts empty after this upgrade, `prewarm()` resolves the curated directory's
domains a few seconds after launch, four at a time — so the one unavoidable
cold pass happens while the user is on another page. On a warm machine it makes
no requests at all.

Measured on the dev machine, cold versus warm: 2 of 50 cards had a real icon
after 15 seconds; now 50 of 50 within 0.8 seconds, with no network.

## 6m. A modal for setting up, a drawer for reading

Choosing a connector's clients and pasting its token is a transaction — commit
or cancel — and it was a side panel, which also squeezed the results grid to 57%
of its width for as long as it stayed open. That is a poor trade for a decision
that takes ten seconds, so it is now a centred modal that closes on Escape or
on a click outside.

The Tools and Trace pages keep their drawers deliberately. Their job is the
opposite one: read the detail of a single row while the rest of the list stays
in view, and comparing rows is the point.

## 7. Scanners, and what they are worth

Two scanners run on every call: arguments are checked for credentials on the way
out, results for injection and credentials on the way in.

Injection detection is **heuristic pattern matching**, and should be understood
as a tripwire, not a filter. It reliably catches the common shapes — instruction
overrides, role reassignment, exfiltration requests, confirmation suppression,
markdown image beacons, hidden HTML — and it catches invisible-text smuggling
(Unicode tag block `U+E0000–U+E007F`, zero-width characters, bidi overrides)
essentially perfectly, because that one is a character-class check rather than a
semantic judgement. A deliberately novel phrasing will get past the rest.

This is why the default is to **flag, not block**. A false positive that
silently mangles a legitimate tool result is worse than a flagged row in a UI.
`redactOnFinding` exists for users who want enforcement and accept the tradeoff;
invisible characters are always stripped when redaction runs, since no
legitimate result needs them.

Credential detection uses anchored patterns for known key formats (AWS, GitHub,
Slack, Stripe, Anthropic, OpenAI, Google, JWT, PEM blocks) plus a generic
assignment pattern with a placeholder filter, and Luhn validation on card-shaped
digit runs. Detected values are masked to their first four characters before
being stored in an excerpt — Bridge must not become the place your secrets are
conveniently collected in plaintext.

---

## 8. Storage

One SQLite database at `<home>/bridge.db`, in WAL mode with a 5-second busy
timeout — required, because N proxy processes write to it while the app reads.

Tables: `servers`, `sessions`, `calls`, `tools`, `rules`, `settings`, `grants`.
Indexes on `calls` cover the four ways the UI reads it: by time, by server, by
flag count, by status.

Payload handling is a deliberate tradeoff. Full request and response bodies are
stored by default because they are the entire point of the product, but
`maxPayloadBytes` (256 KB) truncates outliers with a marker rather than letting
one enormous result bloat the file, `storePayloads: false` reduces the database
to metadata only, and `retentionDays` purges on launch.

Migrations are forward-only and append-only, applied in a transaction with
`user_version` as the marker. Shipped statements are never edited.

---

## 9. Control protocol

Newline-delimited JSON over a unix domain socket (`$TMPDIR/bridge-<uid>.sock`)
or a Windows named pipe (`\\.\pipe\bridge-control`). The socket lives in the
temp directory rather than under Application Support because unix socket paths
are capped near 104 bytes and macOS's Application Support path is long.

Proxy → app: `hello`, `session.info`, `session.end`, `call.start`, `call.end`,
`approval.request`, `tools.updated`, `log`.
App → proxy: `welcome` (settings + rules, sent on successful `hello`),
`config.update`, `approval.result`, `shutdown`.

### Authentication (protocol v2)

The socket carries approval decisions, so an unauthenticated connection gets
nothing — not even the configuration in `welcome`. On start the app writes a
fresh 32-byte token to `$BRIDGE_HOME/control.token` at mode 0600 and chmods the
socket to 0600; `hello` must carry it, compared in constant time. A connection
that has not authenticated within five seconds is dropped, and every message
other than `hello` from one is ignored.

This keeps another *user* on the machine off the socket. It is **not** a defence
against same-user malware, which can read the token file too — that adversary is
out of scope by design (§11).

The client re-reads the token and re-sends `hello` on **every** connection, not
once: the app can restart under a running proxy, and the token it comes back
with is different. An absent token file simply means Bridge is not running,
which is a normal state.

The client reconnects with exponential backoff up to 30s and buffers up to 500
outbound messages while disconnected. On disconnect, every in-flight approval
resolves to *deny* immediately rather than hanging until timeout.

A stale socket file from a crashed run is unlinked before binding.

---

## 10. Installation mechanism

Connecting a server rewrites the AI client's config so the entry points at
Bridge instead of the real server:

```json
{
  "command": "/Applications/Bridge.app/Contents/MacOS/Bridge",
  "args": ["…/app.asar.unpacked/out/main/proxy.js", "--id", "srv_abc123"],
  "env": { "ELECTRON_RUN_AS_NODE": "1", "BRIDGE_HOME": "…" }
}
```

**Why the Electron binary rather than `node`.** The user's system `node` may
be too old, a different version, or absent entirely. Running the app's own
Electron binary with `ELECTRON_RUN_AS_NODE=1` guarantees the runtime the proxy
was built and tested against. (`better-sqlite3` is Node-API since v13, so the
native module itself no longer ties the proxy to one ABI.)

**Why `out/main/**` is unpacked from the asar.** In `ELECTRON_RUN_AS_NODE` mode
the process is plain Node, so asar paths are not reliably resolvable and the
native module must be a real file. The whole `out/main` directory is unpacked
because Rollup extracts a chunk shared between `index.js` and `proxy.js` —
unpacking only `proxy.js` would ship a script whose import target is inside the
archive.

### Running unpackaged writes fragile paths

When Bridge is not packaged, `proxyScriptPath()` resolves into the project
tree, so the stanza written into a real client config names
`node_modules/electron/...` and `out/main/proxy.js` — both gitignored build
artifacts. A dependency reinstall, `git clean`, or moving the folder breaks the
server, and the client reports only "Server disconnected".

Bridge therefore states this rather than hiding it: the Servers page carries a
warning whenever `app.isPackaged` is false, `configHealth` reports any stanza
whose command or script has vanished (or points at a different build than the
one running), and Settings marks the version as a development build. A packaged
install writes `/Applications/Bridge.app/...`, which is stable.

### Server ids are derived, not minted

A server's id is `srv_` + `sha256(client + NUL + name)`, not a random value. The
id is baked into the AI client's config file, and a random one makes
remove-then-re-add produce a *different* id — silently invalidating a config the
client has already read. The client then reports only "Server disconnected",
which tells the user nothing. A derived id makes the operation idempotent: the
same server always resolves to the same id, a stale config keeps working, and
tool preferences survive. The NUL separator stops `('a', 'b c')` from colliding
with `('a b', 'c')`.

Two further layers guard the same failure:

- The client is told when it needs restarting. An AI client reads its MCP
  config once, at launch, so a config rewritten afterwards leaves the client
  running stale commands — everything on disk looks correct while the client
  insists the server failed. A live session proves the client had already
  started, so `configModifiedAt > min(sessionStartedAt)` means the running
  client predates the change. `src/shared/staleconfig.ts` holds that rule as a
  pure function so it is unit-tested rather than trusted.
- The config records `--name` alongside `--id`. If the id is not found, the
  proxy resolves by name instead (only when exactly one server matches) and logs
  the recovery, so a config that outlives its id still serves traffic.
- On launch the app rewrites any installed server's stanza that differs from
  what it would write now, which upgrades entries left by older builds. It
  compares first and writes only on a real difference, so an ordinary launch
  does not touch the user's config or add a backup.

The original config entry is preserved in Bridge's database, not in the config
file, so the file stays valid JSON that the client will accept. Every write
takes a timestamped backup to `<home>/backups/` and lands via
write-temp-then-rename, so a crash mid-write cannot leave a truncated config —
which would otherwise break the user's AI client entirely.

---

## 11. Security model

**Renderer.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration:
false`. Theme choice is the one piece of renderer-local state and lives in
`localStorage`, wrapped in try/catch so a storage-disabled context still renders. The preload exposes exactly two functions: a typed `invoke` over named
channels and an event subscription. A CSP blocks remote script. Navigation and
`window.open` are intercepted and handed to the system browser.

**IPC callers.** Every channel is privileged — it can revoke a permission,
widen a scope, read the trace — and Electron delivers `invoke` from any frame in
any of the app's WebContents. So each handler first checks the sender is the
main window's own top-level frame; a subframe is not the app. Without that, an
embedded or injected frame would inherit the entire API.

**Untrusted input.** Tool results are attacker-controlled. They are never
`eval`'d, never rendered as HTML — every payload view is a `<pre>` with text
content — and user-supplied regexes are compiled through `safeRegExp`.

### What Bridge does not protect against

Stating this plainly matters more than the feature list:

- **A malicious MCP server that behaves correctly.** If a tool is legitimately
  called and legitimately returns data, Bridge records it and lets it through.
  It is a monitor, not an oracle.
- **Semantically novel prompt injection.** See §7.
- **Anything outside its two surfaces.** The MCP proxy and the Claude Code hook
  are what it sees (§4b). A browser session, a direct HTTP call inside a script,
  a cloud connector the client reaches server-side, the model's own reasoning,
  and any client not pointed at Bridge are all invisible to it.
- **A user who clicks Allow.** The prompt shows the tool, the arguments, and the
  findings; it cannot make anyone read them.
- **Local attackers.** The database and socket carry the user's own file
  permissions. Anything already running as that user can read them.

---

## 12. Failure modes

| Failure | Behaviour |
|---|---|
| Database unopenable | Proxy runs with `db: null`; traffic flows, nothing is recorded |
| Control socket absent | Proxy records normally; `ask` resolves via `offlineAskFallback` (default deny) |
| App quits mid-approval | Pending approvals resolve to deny at once |
| Approval times out | Same as offline fallback, attributed as `decidedBy: 'offline'` |
| Upstream server crashes | In-flight calls marked failed, JSON-RPC errors returned, session closed |
| Upstream won't spawn | Proxy exits 4 with a message on stderr, which clients surface to the user |
| Scanner throws | Caught at the message boundary; message forwarded unmodified |
| Oversized JSON-RPC frame | Buffer discarded at 32 MB rather than growing unbounded |
| Config points at a path that no longer exists | `configHealth` compares the written stanza against disk on every Servers refresh and names the missing path |
| Client running a config older than our last write | Detected by comparing config mtime to the oldest live session; the Servers page tells the user to quit and reopen that client |
| Config names a dead server id | Resolves by `--name` when unambiguous; otherwise exits 3 naming the server and the fix |
| Server unknown to the DB | Falls back to `BRIDGE_TARGET` env, else exits 3 with a clear message |
| A server will not start | `--probe` / Test connection names the cause: missing binary, early exit, stall, 401, DNS, refused, TLS |
| Quitting before the first sync completes | Seeding runs unconditionally at launch, ahead of the sync decision, so the directory never depends on a multi-minute sync finishing |
| App quits during a catalogue sync | `RegistrySync.abort()` runs before the database closes, so a multi-minute sync cannot write into a closed handle |
| Proxy killed with SIGKILL | Session row stays open; reaped on next app start and on every session read, by checking whether the pid still exists |

---

## 12b. Why one server can show several sessions

A session is one proxy process, and an AI client may start **several copies of
the same server**. Claude Desktop launches one per surface — Chat and Cowork —
so a single configured server routinely shows two live connections, spawned a
second apart from the same parent:

```
Claude (pid 89312)
 ├── Helpers/disclaimer --pgroup -- … proxy.js --id srv_… (pid 19332)
 └── Helpers/disclaimer --pgroup -- … proxy.js --id srv_… (pid 92876)
```

This is the client's design, not a duplication bug, so the Servers page groups
sessions by server and labels the count rather than listing near-identical rows.

The genuine failure this neighbours is a **stale** session: a proxy killed with
SIGKILL never reaches its shutdown path, so `ended_at` stays NULL and the row
reads as live forever. `reapDeadSessions` closes any open session whose pid no
longer exists, on app start and on every session read. The liveness rule is a
pure function (`selectDeadSessions`) so it is unit-tested without a database. A
recycled pid only delays cleanup by a round; the check can never close a live
session, and never touches the app's own row.

## 12c. Client identity and per-surface policy

An AI client that runs several surfaces starts one server process per surface,
so "which surface is calling?" is a real question a policy engine should be able
to answer — particularly where an organisation has disabled a permission in one
surface but not another.

Nothing in the process tree distinguishes them. Both proxies are spawned by the
same parent through the same helper, and the environment carries only what
Bridge's own config entry set:

```
ELECTRON_RUN_AS_NODE  HOME  BRIDGE_HOME  LOGNAME  PATH  SHELL  USER
```

The only standard discriminator is `clientInfo` in the `initialize` **request** —
the one place the MCP protocol lets a client say who it is. The interceptor
captures `{ name, version, title }` onto the session, and logs the whole
`initialize` params blob once per session so an unfamiliar client can be
inspected rather than guessed at.

`PolicyMatch.clientName` then matches that name with the same glob / `re:`
syntax used for tools, so a rule can read "block destructive tools from
*cowork*, but keep asking in *chat*". A client-scoped rule deliberately does
**not** match a session whose client never identified itself — silently applying
a surface rule to an unknown surface would be the wrong default.

Whether two surfaces of one app are separable depends entirely on whether that
app varies `clientInfo` between them. The Servers page shows each connection's
reported identity for exactly this reason: it turns the question into something
the user can see rather than something the docs have to promise.

## 13. Performance

Per call: two regex sweeps over the result text, one policy evaluation over a
small in-memory rule array, and one SQLite upsert. The dominant cost is the
upsert, which is why WAL and `synchronous = NORMAL` are set. Everything is
streaming — `LineDecoder` holds at most one partial frame.

Added latency is on the order of a millisecond against tool calls that typically
take tens to hundreds. The approval prompt is the only intentional stall.

---

## 14. Testing

`npm test` runs 205 unit tests across the policy engine, both scanners, the tool
classifier, and the framing layer — the three places where a bug is silent rather than loud.

`npm run test:e2e` builds the app and drives the real proxy over stdio against
a stub MCP server (`e2e/`), running it the way a packaged install does — the
Electron binary in Node mode, so the native module ABI matches what ships. Its
16 checks cover both halves of the contract: what the client saw (pass-through
of `initialize` and `tools/list`, an allowed result arriving intact, a `.env`
read refused with `-32001`, an `ask` rule failing closed with no UI reachable)
and what was recorded (injection flagged at high severity, a clean result not
flagged, latency and token estimates captured, tool fingerprints stored, server
identity captured, session closed cleanly).

Each run uses a throwaway `BRIDGE_HOME`, so it never touches real data.

---

## 15. Known gaps

- Tool visibility applies to `tools/list` only; `resources` and `prompts` have
  no equivalent switch yet.
- Only `tools/call` is policed. `resources/read` and `prompts/get` are recorded
  as pass-through but have no policy path; both can carry injected content.
- Tool-definition drift is detected on `tools/list`. A server that never
  advertises a tool it later accepts is not covered.
- The `grants` table is written but session-scoped grants are held in proxy
  memory; the table is currently only used to clear state on session end.
- OAuth for remote HTTP servers is not handled — static headers only.
- No packaged code signing or notarisation config beyond entitlements.
- The renderer holds the most recent 500 calls in memory; older history is
  reachable through export rather than infinite scroll.
