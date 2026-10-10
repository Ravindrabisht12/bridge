# Bridge: what it does not do

Written for a design partner deciding whether to trust it. Linked from the pilot
brief rather than pasted into it.

## Coverage

- Bridge observes and enforces **only** activity that passes through it: MCP
  servers routed via its proxy, and Claude Code's native tools via its hook.
- A browser session, a direct HTTP call inside a script, a cloud-hosted
  connector the client reaches server-side, and any client not pointed at Bridge
  are all invisible to it.
- Seeing an MCP server receive data does not show what that server does with it
  downstream.

## Attribution

- Client-reported identity (`clientInfo`) is attribution, not authenticated
  human identity. A client can say whatever it likes.
- Bridge records a proxy session, not a chat. It cannot tell you which
  conversation caused a call.
- Agent and skill identity is recorded only when the client supplies it as
  execution evidence.

## Detection

- Credential and prompt-injection detection are heuristics. A finding is a
  signal to look, not proof of a breach.
- No promise to catch every secret in a payload, or to prevent exfiltration by a
  server that already has the data.
- Signals over recent records are triage, not a verdict. Repeated denials are as
  likely to be a client retry loop as an attack.

## What a record does and does not prove

- A hook record marked **permitted** means Bridge allowed the call and never
  received its result. It is not a success.
- **completed** means the tool ran and nothing in its response reported an
  error. It is not a verification that the command did what was intended.
- Bridge records what was attempted, what was permitted, and what the tool
  returned. It does **not** record what changed on a server, in a database or
  on disk, and it cannot reconstruct prior state.
- Nothing is retroactive. If the hook was not installed when something
  happened, there is no record of it and none can be recovered.
- The reasoning behind a call is not captured. There is no conversation capture.
- A command's output is scanned for credentials, but by then it has already run
  and the client already has the text: the finding is evidence of a leak, not
  prevention of one.

## Enforcement

- A grant applies at the dispatch boundary. Revoking it stops the next call; it
  cannot recall a request already sent or undo a write already made.
- Pause stops new routed calls. It does **not** revoke provider credentials.
- Bridge fails closed: if it cannot evaluate a call, the call is blocked and the
  agent's task stops. That is a deliberate trade: an interrupted task is
  recoverable, an unapproved action may not be.

## Storage and tamper resistance

- History lives in local SQLite. It is a record, not a tamper-proof audit log.
- Same-user malware and a compromised OS are outside the prevention boundary.
  An attacker holding the local account can edit the database.
- Retention defaults to 30 days and is configurable, including keep-forever.
  Payload storage can be reduced to metadata only.

## Network

- Catalogue search terms and ordinary request metadata reach the configured
  catalogue service.
- Traces, policy content and access tokens are never uploaded.
- No install UUID, no mandatory login, no hidden telemetry.

## Not certified

No compliance certification, no third-party audit, and no security guarantee is
claimed. An independent review of the high-risk paths is a release gate, not a
completed step.
