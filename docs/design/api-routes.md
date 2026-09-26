# API routes

All API routes under `web/app/api` are built on the factory in
`web/lib/api/route.ts`. A route declares its contract up front; the factory
executes the gates in a fixed order. Hand-rolled guard prologues are a
migration residue, not a pattern to copy.

## Writing a route

```ts
import { jsonObject } from "@/lib/api/json";
import { defineRoute } from "@/lib/api/route";

export const POST = defineRoute({
  permission: "items.manage",
  feature: "inventory",
  scope: "unrestricted",
  body: jsonObject,
  handler: async ({ request, authz, params, body }) => {
    // ...
  },
});
```

`defineRoute({ permission | public, feature, scope?, body?, params?, handler })`:

- `permission` is the permission key the caller must hold. The alternative
  is `public: "token"` (sessionless by design: the handler authenticates
  every request itself with an API key, HMAC, or link token) or
  `public: "session"` (authenticated, no permission: self-service surfaces).
- `feature` is mandatory for every non-public route: a feature key, or
  `{ none: "<reason>" }` for the few always-on surfaces. A disabled feature
  answers 404 without naming the feature, so hidden modules expose no
  alternate API surface. Only the leaf key is declared; the registry
  resolves parents and requirements.
- `scope` is `"unrestricted"` (org-wide configuration: restricted callers
  are refused) or `"root"` (the org-root subsidiary must be inside the
  caller's scope). There is no `"subsidiary"` option: list filtering and
  record-level checks live in the handler, which enforces them through
  `authz` with `guardSubsidiaryScope` or the subsidiary filters — only the
  handler knows which field carries the subsidiary. An unknown scope value
  fails closed instead of running unscoped.
- `body` and `params` are zod schemas. Bodies parse through the shared JSON
  boundary; failures answer before the handler runs. Omit `body` on reads
  that take no input.
- Gate order is fixed: permission (or public) → feature → scope → params →
  body → handler. A named business refusal thrown anywhere (an error class
  with a 4xx status) becomes a 4xx carrying its code and remedy. Anything
  else rethrows so the edge request id lands in the server log, never the
  response body.

## Responses

`web/lib/api/responses.ts` is the one refusal vocabulary. Every body shares
the shape `{ error, code?, field?, fieldErrors?, remedy? }`:

- `notFound(kind, id?)` — one 404 spelling (`not_found`). Absent,
  foreign-org, and out-of-scope rows answer identically; the kind and id
  never reach the body.
- `unprocessable(error, { field?, fieldErrors? })` — 422 domain refusals
  (`{ status: 400 }` for a malformed idempotency key, which travels in a
  header no 422 could point at).
- `conflict(code, { remedy? })` — 409 state conflicts. A reused
  idempotency key answers 400 `invalid_idempotency_key` when malformed and
  409 `idempotency_key_conflict` when it cannot replay.
- `created(body)` — 201 with the created payload.

## Coverage

`node scripts/check-route-permission-coverage.mjs` proves every non-public
route declares a permission: each route file either uses the factory, is
public, or sits in the shrink-only ledger
`scripts/route-factory.baseline.json`. The ledger, the loose-`jsonObject`
count, and the `sql`-tag count may only shrink. Factory routes with an
empty `{ none }` reason fail; the surviving `{ none }` routes print as a
review list.

## Public routes

Public routes are declared in `web/lib/proxy-policy.ts`, nowhere else. A
path the proxy treats as public must carry its own per-request credential;
adding a route file under a public prefix without that credential silently
enrolls it as sessionless.
