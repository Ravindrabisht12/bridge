# Architecture docs

| Document | Covers |
|---|---|
| [`../setup/`](../setup/README.md) | running it locally, and deploying it |
| [`repo-layout.md`](repo-layout.md) | where everything lives, and where dependencies are declared |
| [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) | the desktop app — proxy, policy, scanners, storage |
| [`../../SERVICE-ARCHITECTURE.md`](../../SERVICE-ARCHITECTURE.md) | everything server-side, and the reasoning behind it |
| [`../../infrastructure/supabase/README.md`](../../infrastructure/supabase/README.md) | the catalogue schema, with an ER diagram |
| [`../../apps/api/README.md`](../../apps/api/README.md) | running the API, and the three rules not to break |
| [`../../apps/api/openapi.yaml`](../../apps/api/openapi.yaml) | the API contract — tested, not decorative |
| [`../../workers/catalogue-sync/README.md`](../../workers/catalogue-sync/README.md) | the weekly job and the publish guard |

There is deliberately no separate HLD or LLD document. `SERVICE-ARCHITECTURE.md`
§0–§3 is the high-level design; the schema and the OpenAPI document are the
low-level design. A third description of the same thing is a fourth thing to
keep in sync, and prose about a schema goes stale the first time a column
changes.

## The one rule

> **Catalogue data flows down. User data never flows up.**

The catalogue database holds public information about third-party MCP servers
plus our own editorial judgements. Traces, policies, tokens and the list of what
anyone installed stay in local SQLite, on the user's machine, permanently. Two
things enforce it rather than merely documenting it: the OpenAPI contract test
that fails if any endpoint gains a request body, and the absence of any table
here that names a person.
