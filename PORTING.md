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
| 1 | RBAC (iam schema, permission catalogue, can/assertCan, admin UI) | agent | landed; migrated (0004); roles seeded |
| 2 | Insights/analytics (BHQL engine pkg, insight tables, card studio, dashboards) | agent | started |
| 3 | Reports engine (definitions/schedules/runs schema, studio UI, manual run + CSV) | agent | landed + PDF/Excel export + saved searches (Knowledge) |
| 4 | App builder (forms-core pkg, form tables, designer + filler) | agent | landed; migrated (0004) |
| 5 | Sidebar customization (nav registry/resolve/org overrides + admin editor) | integrator | DONE (0004; shell wiring pending RBAC integration) |
| 6 | List-view framework wiring (search/sort/filter/pagination on AP/journal) | integrator | DONE + flyout-first/instant-draft pattern live on AP |

Integration steps after agents land: add schema exports → drizzle generate 0004
→ apply to cluster (+ grants to openbooks_read) → npm install → wire nav items +
permission gates → build → verify in preview → commit.

## Wave 2 — module buildout (concurrent)
| Module | Owner | Routes (exclusive) | Status |
|---|---|---|---|
| AR (customer invoices) | agent-LANDED | web/app/(app)/ar, web/app/api/invoices | started |
| Payments + application + EFT | agent-LANDED | web/app/(app)/payments, /receipts, web/app/api/payments, engine/src/payments.ts | started |
| Journal entry module | agent-LANDED | web/app/(app)/journal (JournalDrawer + new-entry only; list page shared — coordinate via ?entry= param), web/app/api/journals | started |
| Parties directory | agent-LANDED | web/app/(app)/parties, web/app/api/parties | started |
| Bank reconciliation | agent-LANDED | web/app/(app)/banking, web/app/api/banking, engine/src/banking.ts | landed; e2e verified (import→auto/manual match→sign-off) |
| Expenses | agent-LANDED | web/app/(app)/expenses, web/app/api/expenses | started |
| Period close | integrator | schema/src/close.ts, engine/src/close.ts, web/app/(app)/close, web/app/(app)/admin/setup/[entity]/CloseSetupWorkspace.tsx | complete |
| Scripts + audit admin | integrator | web/app/(app)/admin/scripts, /admin/audit | pending |
| Custom record types | agent | web/app/(app)/records, web/app/api/records, web/app/api/forms/options, schema/src/custom-records.ts, web/lib/record{s,-schema}.ts, web/components/record-fields.tsx | landed; schema UNMIGRATED (custom_record_types + custom_records + FKs pending) |
| AI assistant (agent loop + accounting tools + /assistant chat + ⌘K launcher + multi-provider admin UI) | integrator | web/app/(app)/assistant, web/app/api/assistant, web/lib/assistant, web/lib/ai-conversations.ts, web/components/assistant, web/components/assistant-launcher.tsx, web/app/(app)/admin/ai, web/app/api/admin/ai, web/lib/secrets.ts, schema/src/ai.ts | DONE (0010 applied; roles re-seeded; provider+key configured per-org under Admin → AI, encrypted at rest with OPENBOOKS_DATA_KEY — no AI keys in env) |

Shared files are PRE-STAGED by the integrator (nav registry entries + permission
keys already exist for every module above). Agents: do NOT edit registry.ts,
permissions.ts, schema/src/index.ts, package.json, next.config, or another
module's routes. New engine helpers go in your own engine/src/<module>.ts.
