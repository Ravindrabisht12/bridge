# Bridge Catalogue API

Read-only. No auth. No endpoint accepts user data, and a test enforces that
(`openapi.contract.test.ts` fails if any path gains a body or a non-GET method).

## Run it

```sh
npm run dev:api        # no database needed — serves an empty in-memory catalogue
DATABASE_URL=postgres://... npm run dev:api
```

```sh
npm run build:api      # esbuild → apps/api/dist/server.mjs (~14 kB)
node apps/api/dist/server.mjs
```

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8787` | |
| `HOST` | `0.0.0.0` | |
| `DATABASE_URL` | — | Absent means the in-memory repository, with a warning. A silent empty catalogue in production would be worse than a crash. |
| `CDN_BASE` | — | Prefix for icon assets. |
| `PG_POOL` | `8` | Small on purpose — the CDN absorbs the reads. |

## Shape

```
routes.ts              parse, clamp, delegate, set cache headers. No decisions.
cursor.ts              encode/decode/clamp. Every branch tested.
repository.ts          the data boundary — an interface, not SQL
memory-repository.ts   for tests and for dev without a database
postgres-repository.ts the real one, reading only the catalogue_entries view
```

Routes talk to `CatalogueRepository`, never to SQL. That is why the full route
contract — status codes, error shapes, clamping, the delta rules — is tested
with no database anywhere near CI, and why moving off Supabase later touches one
file.

## Caching is the capacity plan

There is no user in any request, so every response is identical for every
caller and a shared cache can serve almost all traffic. `Cache-Control` carries
`s-maxage` and `stale-while-revalidate` on every catalogue route; the origin
stays one small process.

## Three rules worth not breaking

1. **`removed` is an explicit list, never an absence.** An entry missing from a
   delta page must never be read as deleted — that is how a truncated response
   empties a user's catalogue. Removals are withheld while `hasMore` is true, so
   a client that stops paging never records a cursor past a removal it has not
   applied.
2. **A malformed cursor is a 400, not a full resync.** Treating junk as "send
   everything" hides a client bug behind a 27,000-row response.
3. **Errors never carry an internal message.** A relation name in a public JSON
   body is how a schema gets mapped. There is a test for it.

## Contract

`openapi.yaml` is load-bearing, not documentation. Four tests keep it honest:
every route documented, every documented route served, `CatalogueEntry`'s
required fields identical to the TypeScript type in both directions, and no path
accepting a request body. All four have been observed failing on purpose.

## Runtime note

Imports use `.ts` specifiers and there are **no constructor parameter
properties, enums, namespaces or decorators** anywhere in this package. Node's
`--experimental-strip-types` erases types; it does not transform code. The
deployed artifact is an esbuild bundle, so this is a dev-ergonomics constraint
rather than a production one — but keeping to it means `node src/server.ts`
always just works.
