# /data/export ViewSpec integration handoff

Page: `/data/export` — the data export workbench (resource Select with
grouped optgroups, column checkboxes with select-all/clear-all, CSV/XLSX/JSON
format buttons, Export button with file download). Fully client-side:
`ExportClient` owns all state (`useState` per field), all data fetching
(`fetch` to `/api/data/resources` on mount and on resource change), and the
download mutation (`fetch` POST to `/api/data/export` + `URL.createObjectURL`
+ `toast.error` on failure).

Files created/edited (all inside `web/app/(app)/data/export/`, the only dir
this page owns):

- `view.ts` — `loadDataExport(sp)` + `dataExportSpec(data)`. The loader runs
  the page.tsx gate verbatim (`requirePermission('data.export')`) and binds
  nothing — there is zero server-rendered content on this page.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged. No `sections.tsx`: `ExportClient` is already a sibling
  module (not inline in page.tsx), so both render paths share that one
  implementation with no move needed. Never write a second copy.

Read `web/app/(app)/query/view.ts` before touching this spec: it is the same
"whole interactive component through one widget" precedent (a degenerate
zero-server-data page placed through one bare widget).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed:

```tsx
import { ExportClient } from '../../app/(app)/data/export/ExportClient'
```

Entry:

```tsx
/* --- data export ----------------------------------------------------------- */
/**
 * The whole export workbench, placed whole rather than decomposed into
 * blocks: resource Select (grouped optgroups), column checkboxes with
 * select-all/clear-all, format buttons, Export button with file download.
 * All state is client-side (selected resource/columns/format, busy flags,
 * fetched descriptors over /api/data/resources); there is no server content
 * to decompose, so the widget carries no props. Same precedent as
 * `query-console`, which likewise renders its workbench with no props.
 */
'data-export': () => <ExportClient />,
```

Why a bare widget with no props: the spec cannot carry interactive state
(selected resource, columns, format, loading/busy flags, fetched rows) and
the loader cannot precompute it (the resource list and columns do not exist
until the component fetches them after mount). `ExportClient` reads its own
`data.export.*` message keys through `useTranslations('data')`, exactly as
the native branch does — threading static strings through widget props
instead would double every key and drift from the catalog on the first copy
edit. `DataExportData` is an empty record: the loader runs the gate and
binds nothing.

No new vocabulary needed: `layout: 'bare'` plus the existing
`page-container` frame (already in `FRAME_REGISTRY`, blocks.tsx:67) covers
the native `<PageContainer>` shell. No `packages/viewspec` changes proposed.

## What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: the loader resolves the one gate server-side and the
spec carries no props at all. `ExportClient` owns its data through fetch
calls to `/api/data/resources` and `/api/data/export`, exactly as on the
native path — the same arrangement as `query-console` (§"Why a bare widget
with no props"). The `data.export` permission never crosses the boundary.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/data/export',
  // Fully client-side workbench: both paths serve the same component
  // (ExportClient), identical by construction. The single variant proves the
  // page renders past the loader's gate: PageHeader title (h1) + resource
  // label + Export button, all static chrome present before any fetch.
  // Range-limited on purpose: minMatches counts STATIC chrome only — never
  // fetched resources/columns. The resource Select's options arrive over
  // /api/data/resources after mount, so no selector may name them.
  // One variant only, so `assertVariantsDiffer` is vacuous — correctly so:
  // for a zero-server-data page there is no second branch to pin.
  variants: [''],
  expect: 'main h1',
  minMatches: 1,
},
```

GATES verification (read-only queries, 2026-09-10) — verified against the
page's gate, not just row counts:

- Permission: harness user `viewspec@sim.test` (org
  `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` "SIM · Summit Ridge Construction")
  holds the `Administrator` role, whose `permissions` array contains
  `"data.export"` (verified via role_assignments → app_roles join). Gate
  passes on both paths.

No fixture ROWS needed (no table path, no drawer id, no allocation-block
claim — nothing to collide under `ON CONFLICT DO NOTHING`). The SIM tenant
already yields real `/api/data/resources` content (setup + master + 1
published custom record type + doc-kind transactions), but the `expect`
selector deliberately names only pre-fetch static chrome, so no fixture is
required for the comparison to be meaningful.

## 3. What the spec does NOT cover (nothing renderable is missing)

- No composite cells, so no `sections.tsx` cell components. `ExportClient`
  stays in place as the one shared implementation.
- The Select/optgroups/checkboxes/format buttons/download logic is untouched
  — client behavior, not server content, and the spec language has no
  vocabulary for it by design (no conditionals, no function values, no
  component references).
- `layout: 'bare'` + `page-container` frame is load-bearing, not a default:
  the native page wraps the workbench in `<PageContainer>` (scroll wrapper +
  centered container + fade-in) directly under the app shell's `<main>`.
  `list`/`detail` would nest a second `ListPageLayout` (sticky header chrome
  + padded body) around the workbench and break pixel parity — the same
  arrangement as the reports hub.
- No `pageHeader` block: the native header is the shared `PageHeader`, but it
  is rendered INSIDE `ExportClient` (with the `Download` icon button sibling
  below it), not by page.tsx. Decomposing it would split one component's
  markup across the spec/component boundary. The widget renders it exactly
  as the native component does — there is no loader-owned copy to bind,
  because every string stays inside the component's own `useTranslations`
  calls.
- The `data.export` gate runs in the LOADER before any data — both branches
  403/redirect identically without it. Nothing travels through the spec for
  it: an org id in spec props would be a cross-tenant read.

## 4. Pre-existing state of the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts, no
new files from main.
