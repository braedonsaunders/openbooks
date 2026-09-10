# /admin/setup/overhead ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/overhead/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. The native branch is preserved below the spec branch; the native
model body now renders through the shared `OverheadModelHeader` /
`OverheadModelBody` components so both paths share one implementation (moved,
not copied).

Spec shape: `bare` layout (the setup workspace renders its own shell — same
reason as the `[entity]` and labor-costing conversions), one `space-y-4`
grid holding the header widget plus four presence-gated body widgets
(`onModel` / `onRates` / `onLifecycle` / `onApplication` — the accounts-page
precedent one step wider). Seven new widgets/slots, all proposed below.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed:

```tsx
import {
  OverheadApplicationTabSlot,
  OverheadLifecycleTabSlot,
  OverheadModelBody,
  OverheadModelHeader,
  OverheadRatesTabSlot,
} from '../../app/(app)/admin/setup/overhead/sections'
```

Check the import lines first — `Link`, `BookOpen`, `cn` are already imported
in the registry file; only add what is missing. No `overhead-` widget exists
in the registry today (verified by grep — the only `overhead` hit is the
labor-costing header's link *href* to `/admin/setup/overhead`), so no
twin-component risk.

```tsx
/**
 * Overhead-model header: h2 title + description, the docs/analytics/labor
 * links and the publish/wizard actions island, plus the four-tab underline
 * strip. NOT `page-header`: that block cannot express the three-link action
 * cluster or the client-only OverheadActions island (modals, useMoney,
 * useBusinessToday). NOT `labor-costing-header-actions`: that cluster is
 * two sized buttons plus a teal link, while this one is three teal links
 * (docs carrying `<BookOpen size={13} />` + space, analytics and labor each
 * carrying a literal `→`) plus the actions island. NOT
 * `labor-costing-tabs`: the strip shares its shape, but the hrefs, labels
 * and active key differ per page and the registry passes props, not code —
 * one component behind one registry entry. Diffed; kept separate.
 */
'overhead-model-header': (props) => (
  <OverheadModelHeader
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    docsHref={str(props, 'docsHref') ?? '/docs/overhead-costing'}
    docsLabel={str(props, 'docsLabel') ?? ''}
    analyticsHref={str(props, 'analyticsHref') ?? '/analytics/true-cost'}
    analyticsLabel={str(props, 'analyticsLabel') ?? ''}
    laborHref={str(props, 'laborHref') ?? '/admin/setup/labor-costing'}
    laborLabel={str(props, 'laborLabel') ?? ''}
    actions={
      props.actions as ComponentProps<typeof OverheadModelHeader>['actions']
    }
    tabs={
      (props.tabs as ComponentProps<typeof OverheadModelHeader>['tabs']) ?? []
    }
  />
),
/**
 * Overhead-model body: the three guided steps, the per-project-type policy
 * pills, and the engine itself (`TrueCostView mode="setup"` — categories /
 * matrix / config tabs). NOT decomposable into spec blocks: the step badge
 * is a conditional PAIR (teal `✓` vs numbered slate circle), the policies
 * are a data repeat, and TrueCostView owns `useState` (tab, flyouts,
 * drills) the way LaborCostingWorkspace does. The loader resolves every
 * string; the widget only renders.
 */
'overhead-model-body': (props) => (
  <OverheadModelBody
    steps={(props.steps as ComponentProps<typeof OverheadModelBody>['steps']) ?? []}
    policies={(props.policies as ComponentProps<typeof OverheadModelBody>['policies']) ?? []}
    trueCost={props.trueCost as ComponentProps<typeof OverheadModelBody>['trueCost']}
  />
),
/**
 * Rates tab slot: the published effective-dated rate card plus its `?row=`
 * SetupDrawer. The drawer row query and the org id stay server-side — a
 * spec must never carry an org id — so this is a slot, not props.
 */
'overhead-rates-tab': (props) => (
  <OverheadRatesTabSlot
    sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
  />
),
/**
 * Lifecycle tab slot: the manual/scheduled/live switch, the cadence switch
 * and the live-vs-published drift table. Drift money formatting happens
 * inside (it owns the money hooks the spec cannot name). No props: all
 * state is org-derived.
 */
'overhead-lifecycle-tab': () => <OverheadLifecycleTabSlot />,
/**
 * Application tab slot: the report_only/net_zero_pair/off switch, the
 * account picker, the backfill prompt and the applied-postings ledger.
 */
'overhead-application-tab': () => <OverheadApplicationTabSlot />,
```

A note on the slot props: the rates slot takes `sp` (it must re-resolve
`?row=` for its drawer); the lifecycle and application slots take no props
(their state is org-derived, and their mutations re-read from the session).
Async server components are valid registry values — the payroll tab slots
(`PacksTabSlot`, rate-tab slots) already render this way.

## 2. Slot proposals

The three tab slots ARE the slot proposals (above): each re-derives the org
id (and subsidiary scope) from the session via `getAuthz()` and re-runs the
native page's own queries verbatim. No new capability crosses the spec.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness super-admin
`viewspec@sim.test`):

```js
{
  path: '/admin/setup/overhead',
  // Four mutually exclusive bodies behind ?view=. Default (model) renders
  // the h2 header, the guided steps and the TrueCost engine (categories
  // tab: tables + h3 panels from real journal data); rates renders the
  // published card table (one seeded row); lifecycle renders the mode
  // switch section; application renders the mode switch section. Every
  // variant differs from the default — no identical-markup variant is
  // proposed. ?view=zzzznomatch falls back to model (same whitelist as
  // native) and is NOT proposed: it cannot differ from the default.
  variants: [
    '',
    { query: '?view=rates', expect: 'main table tbody tr', minMatches: 1 },
    { query: '?view=lifecycle', expect: 'main section h3', minMatches: 1 },
    { query: '?view=application', expect: 'main section h3', minMatches: 1 },
    {
      query: '?view=rates&row=new',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The drawer is portaled to <body>: without naming that root the
      // comparison never looks at it. Deterministic in-tenant: static
      // department ref options (Field operations + fixture dept), no rows
      // required.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'main h2',
  minMatches: 1,
},
```

GATES check (per the /query lesson): two server gates —
`requirePermission('admin.setup.manage')` and `requireProjectsFeature`
(redirects to `/admin/setup/features` when the projects feature is off). The
harness user passes the permission via the Administrator role (verified),
and projects is stored `true` on the harness org (verified) — so the page
renders 200 in all four views. No 404 branch exists. No logged-out variant
is proposed (the harness is always authenticated; the login redirect is
framework behavior, not page content).

Variant-coverage check (per the /compliance lesson): the tenant holds five
active project types (all `method: none`), one active department (Field
operations), zero `overhead_rates` until the fixture below applies, zero
`journal_entries` with `origin = 'overhead_applied'`, and real journal-line
volume (1310 lines) feeding the engine. `?view=rates` pins the card table
with the one seeded row; `?view=lifecycle` / `?view=application` pin their
section chrome. `?view=model` IS the default (no separate variant — it
cannot differ from it). A `?row=<id>` drawer variant on an existing rate row
is not proposed: the drawer is covered by `?row=new`, and the fixture id is
stable but the coordinator owns drawer-id conventions.

Row-count verification (read-only queries):
`project_types` active in the harness org → 5 (all `method: none`, so the
wizard auto-opens on both paths — identical);
`departments` active → 1 (`00000000-0000-7000-9000-000000008831` Field
operations);
`overhead_rates` → 0 before fixtures, 1 after (the `...08901` row below);
`journal_entries origin='overhead_applied'` → 0 (empty ledger on both
paths);
`journal_lines` → 1310 (the engine renders real categories/matrix content).

## 4. Fixture SQL (for the coordinator — `scripts/viewspec-fixtures.sql`)

Claims fresh block `…08901-0899` (verified free: no `0000000089xx` id exists
in the file; neighbors `…08801-0891` are the labor-pricing book block and
`…1901-…` are pay stubs). The rate row must satisfy the card query's window
predicate (`effective_to is null or >= today`) and join a department the
tenant holds, so the `?view=rates` variant pins a real populated row rather
than the empty state:

```sql
-- Overhead rate card row for the /admin/setup/overhead rates tab: one open
-- per-hour published rate on the tenant's Field operations department, so
-- the card table renders one row on both paths. Fixed id in the claimed
-- …08901-0899 block (neighbors …08801-0891 are the labor-pricing book).
insert into overhead_rates
  (id, org_id, department_id, category, method, rate_kind, rate_percent, effective_from, effective_to)
values
  ('00000000-0000-7000-9000-000000008901', v_org, '00000000-0000-7000-9000-000000008831',
   'Published', 'standard', 'per_hour', 85.00, '2025-01-01', null)
on conflict (id) do nothing;
```

Table shape verified against the live database (`overhead_rates` columns:
`id, org_id, department_id, category, method, rate_percent, effective_from,
effective_to, created_at, created_by, updated_at, updated_by, rate_kind` —
`category`/`method` are NOT NULL with no default, hence the `'Published'` /
`'standard'` values matching the publish path).

## 5. What the spec does NOT cover (nothing — full coverage)

- The setup.manage gate, the projects feature gate, the TTM window, the
  types/card queries, the method labels, the auto-open derivation and the
  guided-step derivations are all loader work copied verbatim from
  `page.tsx`.
- Message keys used by the loader (`setup.entities.overhead-model.title`,
  `.description`, `.docs`, `.viewAnalytics`, `.laborCostingLink`,
  `.tabs.*`, `.step1t/.step1d`, `.step2t/.step2d`, `.step3t`,
  `.ratesActive`, `.noRates`, `.methodCard/.methodPct/.methodHr/.methodGl/
  .methodNone`) are all already consumed by the native page — verified by
  grep against `web/messages/en/admin.json`; none invented. All other copy
  (publish/wizard modals, lifecycle/application chrome, the TrueCost engine)
  resolves inside the shared client components via their existing hooks.
- `page.tsx` native branch is untouched below the `__viewspec` branch
  except for the shared-component move (header/tabs chrome and the model
  body render through `./sections`, imported back).
- Typecheck: `cd web && node_modules/.bin/tsc --noEmit -p tsconfig.json`
  passes clean (exit 0, no output) with this conversion in the tree. Deps
  were installed with `npm install` at the repo root for the check;
  `node_modules/` is gitignored and `git status` shows no collateral — only
  the four owned-directory files.
