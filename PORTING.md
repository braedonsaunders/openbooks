# beaconhs → openbooks foundation port (in progress)

Source of truth: /Users/braedonsaunders/Documents/Code/beaconhs-platform
Standing rule: beaconhs is the boilerplate — copy, then adapt vendor-neutrally.

## Conventions every port must follow
- Schema: new tables live in their OWN file under `schema/src/` using helpers
  (`id()`, `orgRef()`, `auditColumns`) — org-scoped (`org_id`), NOT tenant_id.
- Do NOT run drizzle-kit or apply migrations — the integrator generates ONE
  migration after merge. Do NOT edit `schema/src/index.ts` (integrator adds
  exports). List any FKs at the bottom of your schema file in a SQL comment.
- UI: compose from `@openbooks/ui` + `web/components/page-layout` etc.
  No hardcoded vendor/org names. Money right-aligned tabular-nums.
- Auth: `currentUser()` from `web/lib/auth.ts` (id, email, name, role, orgId).
- New packages get their own `package.json` (@openbooks/<name>) — do NOT run
  npm install; note dependencies in the package.json only.
- Do NOT edit: web/app/(app)/layout.tsx, web/components/sidebar-nav*, app-shell,
  package.json (root/web), next.config, existing pages (integrator wires nav).

## Workstreams
| # | Subsystem | Owner | Status |
|---|---|---|---|
| 1 | RBAC (iam schema, permission catalogue, can/assertCan, admin UI) | agent | started |
| 2 | Insights/analytics (BHQL engine pkg, insight tables, card studio, dashboards) | agent | started |
| 3 | Reports engine (definitions/schedules/runs schema, studio UI, manual run + CSV) | agent | started |
| 4 | App builder (forms-core pkg, form tables, designer + filler) | agent | started |
| 5 | Sidebar customization (nav registry/resolve/org overrides + admin editor) | integrator | started |
| 6 | List-view framework wiring (search/sort/filter/pagination on AP/journal/COA) | integrator | started |

Integration steps after agents land: add schema exports → drizzle generate 0004
→ apply to cluster (+ grants to openbooks_read) → npm install → wire nav items +
permission gates → build → verify in preview → commit.
