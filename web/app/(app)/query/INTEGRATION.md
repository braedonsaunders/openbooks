# /query ViewSpec integration handoff

Page: `web/app/(app)/query/` — owner files are `view.ts`, `sections.tsx`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.

Spec widgets used: `query-console` only (proposed below — does not exist in
the registry yet). No `table`, `repeat`, or `frame` vocabulary: this page is
the degenerate case — a fully client-side workbench (`'use client'`) with
zero server-rendered content. The LOADER reproduces the `layout.tsx` gates
verbatim and resolves the header copy; the whole console below the header is
one interactive component placed whole, the same treatment as a studio
(`card-studio`, `view-studio`).

Read `web/app/(app)/insights/view.ts` before touching this spec: it is the
same "whole interactive component through one widget" precedent.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { QueryConsole } from '../../app/(app)/query/sections'
```

Entry:

```tsx
/* --- SQL console ------------------------------------------------------------ */
/**
 * The whole console workbench, placed whole rather than decomposed into
 * blocks: editor, rail (schema/snippets/history), results grid, every fetch.
 * All state is client-side (localStorage draft, fetch to /api/query); there
 * is no server content to decompose, so the spec's header copy stays in the
 * loader and the widget carries no props. Same precedent as `card-studio` /
 * `view-studio`, which likewise render loader-resolved props objects whole.
 */
'query-console': () => <QueryConsole />,
```

Why a bare widget with no props: the spec cannot carry interactive state
(editor text, busy flags, fetched rows) and the loader cannot precompute it
(it does not exist until the user runs a query). `QueryConsole` reads its own
`query.*` message keys through `useTranslations`, exactly as the native
branch does — threading static strings through widget props instead would
double every key and drift from the catalog on the first copy edit.
`QueryData` is an empty record: the loader runs the gates and binds nothing.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/query',
  // The console renders no server data: both paths serve the same client
  // component (sections.tsx), identical by construction. The single variant
  // proves the page renders past the loader's gates: header title (h1) +
  // read-only badge, both static component chrome.
  // Range-limited on purpose (see below): minMatches counts STATIC chrome
  // only — never fetched schema/result content. minMatches: 0 with an
  // expect selector still proves the spec path rendered past the gates.
  variants: [''],
  expect: 'main h1',
  minMatches: 1,
},
```

GATES verification (read-only queries, 2026-09-10) — verify against the
page's GATES, not just row counts:

- Permission: harness user `viewspec@sim.test`
  (`01a08426-0962-74c7-a086-e1609c589dcb`, org
  `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` "SIM · Summit Ridge
  Construction") holds the `admin` role, whose `permissions` array contains
  `"sql.execute"`. Gate 1 passes.
- Feature: `queryConsole` is `defaultEnabled: false`
  (`engine/src/feature-registry.ts:124`) and the harness org's
  `settings->'features'` blob is
  `{"crm": true, "orders": true, "banking": true, "budgets": true,
  "payroll": true, "scripts": true, "projects": true, "apiAccess": true,
  "inventory": true, "fixedAssets": true, "fieldTickets": true,
  "timeTracking": true, "subcontractorCompliance": true}` — no
  `queryConsole` key. `featureEnabled` falls back to the registry default,
  so `requireFeatureEnabled` → `notFound()`. **Gate 2 FAILS: both branches
  404 identically in the harness tenant today** (the layout gate runs before
  either branch, so native and spec agree byte for byte — but on the Next
  `not-found` page, and `expect: 'main h1'` will NOT match).

Do NOT register this entry until §3 is applied: without the fixture the
variant fails at the status/selectors, not at the comparison. After the
fixture the page renders for real on both paths.

Two harness mechanics this entry deliberately avoids:

- `assertVariantsDiffer` (conformance.mjs:1069) fails an entry whose
  variants render byte-identical markup. One variant only, so the check is
  vacuous — correctly so: for a zero-server-data page there is no second
  branch to pin.
- No `table tbody tr` selector: the schema rail and results grid render
  client-side after mount (fetch to `/api/query/schema`, localStorage
  restore). The `renderSettled` quiescence loop may capture them at
  different fill states on the two passes. `main h1` names loader-owned
  static chrome only.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

No fixture ROWS needed (no table path, no drawer id, no allocation-block
claim — nothing to collide under `ON CONFLICT DO NOTHING`). What is needed
is one feature merge in the existing "feature switches" block idiom
(fixtures.sql:140-150), so the harness tenant passes the page's own gates:

```sql
  -- ---- SQL console ------------------------------------------------------------
  --
  -- /query is gated by layout.tsx on `sql.execute` (the harness admin role
  -- holds it) AND the `queryConsole` feature flag (defaultEnabled: false,
  -- and the SIM org blob has no key). Without the flag both render paths
  -- 404 identically — a byte-perfect match of two error pages that proves
  -- nothing. Merging the flag into the existing feature-switches update
  -- (same jsonb_set idiom, same WHERE id = v_org) opens the real console on
  -- both paths. Scoped to the SIM org only; nothing here touches a real
  -- tenant.
  update orgs
     set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb), '{features}',
           coalesce(settings->'features', '{}'::jsonb) || jsonb_build_object(
             'queryConsole', true))
   where id = v_org;
```

(Or add `'queryConsole', true` to the existing `jsonb_build_object` list in
the feature-switches block — same effect, one fewer statement. Written as a
separate update only so it can be reviewed and reverted independently.)

## 4. What the spec does NOT cover (nothing renderable is missing)

- No composite cells, so no `sections.tsx` cell components. `sections.tsx`
  holds the MOVED `QueryConsole` workbench (moved from `page.tsx`, renamed
  to a named export; `page.tsx` imports it back for the native branch), so
  both render paths share one implementation. Never write a second copy.
- The editor/resplitter/results/splitters/rail/fetch logic is untouched —
  it is client behavior, not server content, and the spec language has no
  vocabulary for it by design (no conditionals, no function values, no
  component references).
- `layout: 'bare'` is load-bearing, not a default: the native root is
  `flex h-full min-h-0 flex-col` under the app shell's `<main>` (which the
  harness scopes, not anything ModuleView wraps). `list`/`detail` would nest
  a second `ListPageLayout` (sticky header container + padded body) around
  the workbench and break pixel parity.
- No `pageHeader` block: the native header is a bespoke `div` (icon tile +
  title/subtitle + read-only `Badge`), not the shared `PageHeader`, and
  decomposing it would retype its classes from memory. The widget renders
  the header exactly as the native component does — there is no loader-owned
  copy to bind, because every string stays inside the component's own
  `useTranslations` calls.
- The `sql.execute` + `queryConsole` gates run in the LOADER before any
  data — both branches 404 identically when the feature is off (field-tickets
  precedent, INTEGRATION.md §"feature gate"). Nothing travels through the
  spec for them: an org id in spec props would be a cross-tenant read.
- The `Select`'s `data-selected-value` stamping (conformance.mjs `renderSettled`)
  covers the row-limit control identically on both paths — same component,
  same DOM.

## 5. Pre-existing state of the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts, no
new files from main.
