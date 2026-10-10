# @bridge/registry

The MCP registry's response types and the pure transforms over them. Shared by
the desktop app and the weekly catalogue worker.

Nothing here touches a database, a filesystem or Electron. It is pure over
`fetch`, which is what makes it both testable and shareable.

## Why this is a package and not a copy

The worker needs exactly the same parsing the app already does, and two copies
drift. Three things in here were expensive to get right and would be
reintroduced by a clean-room rewrite:

**`MAX_PAGES` is a runaway guard, not a budget.** The registry pages
alphabetically, so a cap reached quietly does not give you "most of the
catalogue" — it gives you A through however-far-you-got, with whole namespaces
absent. `io.github.*` is most of the real servers and sorts late. So `crawl()`
**throws `RegistryTruncatedError`** when a cursor is still in hand at the cap,
rather than returning what it has. A truncated catalogue that looks successful
is the worst available outcome.

**`categorize` reads the local name only.** Every `io.github.*` entry contains
the word "github". Including the namespace put 18,528 of 27,213 entries into
"developer tools".

**`displayTitle` reads the vendor from the namespace.** Notion, Stripe, PayPal,
Wix and Cloudflare all publish `<vendor>/mcp` with no title, so using the path
segment renders a front page of rows all called "mcp". The boilerplate match is
anchored and exact — 12 real entries are titled "MCP Server for *X*" and
widening it to catch "MCP Server" with a space would eat all of them.

## Seam with the app

`CatalogEntry` — the app's SQLite row — and `toCatalogEntry`, which maps into
it, deliberately **stayed** in `src/shared/registry.ts`. A storage shape has no
business in a shared package; an opinion about the registry belongs to both
sides. `@shared/registry` re-exports everything from here, so all 116 existing
import sites in the app were untouched by the extraction.

The worker maps registry entries to its own Postgres shape and shares the
parsing, not the row.

## Tests

```sh
npm run test:registry
```

20 tests. `crawl` is exercised against a fake registry that pages like the real
one, including the case that matters most: a cap reached with data still behind
it must throw, and a cap reached with nothing behind it must not.
