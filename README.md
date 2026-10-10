# Bridge

**See and control what your AI apps do with their MCP tools.**

Bridge sits between supported AI clients and MCP servers. It shows observed tool
activity, applies local policies and flags possible credential exposure. It does
not monitor shell commands, browsers, direct API calls or integrations that bypass
its proxy. Client attribution is not authenticated human identity, and findings
are not proof of a breach.

> **Status: early development.** Bridge works and is tested, but it has not had
> an external security review, and server credentials are not yet kept in the
> OS keychain. Read [what it does not protect against](docs/limitations.md)
> before relying on it.

Bridge runs entirely on your machine. It needs no account and no API key: it
never calls an AI model itself, it only sits between your AI app and the MCP
servers you already use.

---

## What it does

- **Library** — a bundled curated set, catalogue-service search and cached entries,
  plus any you add yourself (a local command, a self-hosted
  URL, a git checkout). Filter by pricing, source, where it runs, whether it
  needs an account, category or your own tags. Mark favourites, rate them, and
  feature the ones your team should use — annotations survive every sync.
- **Install once, connect anywhere** — one action wires a server into Claude
  Desktop, Claude Code, Cursor, VS Code, Windsurf and DeepSeek Harness. Test
  the connection before you commit, and manage every client from one place.
- **Overview** — your servers, which are live, calls in the last day, what was
  blocked or failed, and the most used tools.
- **Calls** — every tool call as a call stack, grouped by AI app and server:
  tool, arguments, result, status and time, live as it happens.
- **One entry per client (optional)** — replace a client's list of servers
  with a single Bridge entry. With many servers, the model gets two tools,
  `search_tools` and `call_tool`, instead of hundreds of tool schemas.
- **Context control** — oversized tool results are trimmed before they reach
  the model (the trace keeps the full result), and a model repeating the same
  call with the same result is told so.
- **Approve before it runs** — rules decide what runs silently, what asks first,
  and what is blocked outright. A blocked call returns a real error, so the
  model tells you it wasn't allowed.
- **Injection detection** — tool results are scanned before they reach the model
  for instruction overrides, exfiltration requests, and text made invisible to
  humans but readable by the model.
- **Credential detection** — arguments are checked for API keys, tokens and card
  numbers on their way out. High-confidence secret findings ask for approval
  for each call by default; Settings also offers Block or Flag only. No response
  to a credential prompt blocks the call, even if the ordinary offline fallback allows.
- **Tool-definition drift** — every tool's definition is fingerprinted, so a
  server that quietly rewrites a tool you already approved has to ask again.
- **One-click connect** — Bridge finds the servers already in your Claude
  Desktop / Cursor / VS Code / Windsurf config and wraps them. No manual MCP
  setup, no config editing.

Light and dark themes; light by default.

Traces and policies stay local. Catalogue requests and search terms reach your
configured catalogue service; connected MCP calls reach their upstream servers.
Detected secrets are masked in retained trace payloads and live approval events.
Detection is heuristic, and existing historical records are not retroactively scrubbed.

---

## Getting started

Requires **Node.js 22.14 or newer** (`nvm use` picks the version in `.nvmrc`)
on macOS, Windows or Linux.

```bash
npm install     # no native rebuild needed: the SQLite driver is Node-API
npm run dev     # development
npm test        # unit tests
npm run test:e2e # drives the real proxy against a stub MCP server
npm run build   # production bundles
npm run dist    # packaged installers into release/
```

Then, in the app:

1. Open **Servers**. Bridge lists every MCP server it found in your AI clients'
   configs. Click **Connect** on the ones you want to watch, use **Add server**
   for a new one, or browse the **Library**.
2. **Restart the AI client** — it reads its config only at startup.
3. Open **Overview** to see your servers and what is live.
4. Ask your assistant to do something that needs a tool, then open **Calls**:
   each call shows its tool, arguments and result as it happens.

A note on the empty trace: your AI client starts its MCP servers and asks each
for its tool list as soon as it launches — that is why Bridge knows the tools
right away. A row appears in the trace only when the model actually *calls* one.

Disconnecting restores the original config entry. Every config write is backed
up first to `<data dir>/backups/`.

---

## Policy

Rules are evaluated in priority order; the first match wins. The credential
action can impose a stricter decision and cannot be bypassed by a remembered tool
approval. Request-inspection failures are not forwarded or retried.

| Field | Meaning |
|---|---|
| Server | one server, or any |
| Client | which connecting app or surface the rule applies to |
| Tool pattern | `*` glob (`send_*`), or `re:` for a regex (`re:(delete\|drop)`) |
| Argument path | test one argument, e.g. `path` or `message.body` |
| Argument regex | what that argument must match |
| Effect | `allow` (silent) · `ask` (prompt) · `deny` (block) |

The seeded defaults block reads of `.env`, `id_rsa` and `~/.ssh`, ask before
anything that deletes, sends, writes or executes, and let plain reads through.

When you answer a prompt with **always**, Bridge writes it as a normal rule you
can see and delete later — approvals never become invisible state.

---

## Where things live

| | macOS | Windows | Linux |
|---|---|---|---|
| Data | `~/Library/Application Support/Bridge` | `%APPDATA%\Bridge` | `~/.config/bridge` |
| Database | `<data>/bridge.db` | | |
| Logs | `<data>/logs/` | | |
| Backups | `<data>/backups/` | | |

Override the whole tree with `BRIDGE_HOME`. Set `BRIDGE_ALLOW_MULTIPLE=1` to
run a second instance alongside `npm run dev` (only the first owns the control
socket).

### If your AI client says "Server disconnected"

The client reads its config only at startup, so **restart it** after connecting
or disconnecting anything in Bridge. If it still fails, open
`<data>/logs/proxy-*.log` — the proxy records why it could not start, and never
writes diagnostics to the protocol stream.

---

## What it is not

Bridge is a monitor, not an oracle. It cannot tell you a tool call was
*wrong* — only what happened. Injection detection is heuristic and will miss
novel phrasings; it flags by default rather than blocking, because silently
mangling a legitimate result is worse than a flagged row you can read.

See [ARCHITECTURE.md](./ARCHITECTURE.md) §11 for the full threat model,
including what is explicitly out of scope.

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for how to build, test and propose a change.

## Security

Please do not report vulnerabilities in public issues. See
[SECURITY.md](SECURITY.md) for how to report one privately.

## License

[MIT](LICENSE) © 2026 Ravindra Bisht
