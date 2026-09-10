# /api-docs ViewSpec integration handoff

Page: `web/app/(app)/api-docs/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`:
the page needs no composite cells, and its workbench component already
lives in its own module (see "What the spec does NOT cover" below).

Spec widgets used: `api-console` only (proposed below — does not exist in
the registry yet). No `table`, `repeat`, or `frame` vocabulary: this page
is the degenerate case — a fully client-side workbench (`'use client'`)
with zero server-rendered branch points. The LOADER reproduces the native
gates verbatim and binds the live schema; the whole console below is one
interactive component placed whole, the same treatment as `query-console`
(`web/app/(app)/query/view.ts` — read it before touching this spec).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { ApiConsole } from '../../app/(app)/api-docs/ApiConsole'
```

Entry:

```tsx
/* --- API docs console ------------------------------------------------------- */
/**
 * The whole REST console workbench, placed whole rather than decomposed
 * into blocks: record-type rail, fields reference, request builder,
 * response panel, every fetch. All interaction state is client-side
 * (token, selected type, method, body text, fetched response); there is
 * no server-rendered branch to decompose, so the spec places one widget.
 * Same precedent as `query-console`, except the schema IS server data —
 * the same plain-data prop the native page hands the component ("safe to
 * hand to the client") — so it travels as a literal widget prop rather
 * than no props. Literal props pass through `resolveWidgetProps`
 * verbatim (only FieldRefs resolve); nothing here is a capability or an
 * org id, so the slot doctrine is satisfied without a server slot.
 */
'api-console': (props) => (
  <ApiConsole schema={(props.schema as ComponentProps<typeof ApiConsole>['schema']) ?? []} />
),
```

EXACT prop shape (the coordinator wires it verbatim — `ApiConsole`'s own
props, `web/app/(app)/api-docs/ApiConsole.tsx:100`):

```ts
{ schema: RecordType[] }

interface RecordType {
  key: string
  label: string
  description: string
  path: string
  readPermission: string
  writePermission: string | null
  operations: Array<'list' | 'get' | 'create' | 'update' | 'delete'>
  dynamic: boolean
  writer: { kind: 'custom_record' | 'document' | 'entity' | 'readonly' }
  fields: Array<{
    name: string
    type: string
    required: boolean
    writable: boolean
    description: string | null
    custom: boolean
  }>
}
```

What the loader actually passes is `ApiRecordTypeSchema[]`
(`web/lib/api/schema-registry.ts:239` — the `RecordType` above plus
`table`, `searchColumn`, optional `featureKey`/`documentKinds`, and
optional per-field `requiredOnRead`/`writableOnCreate`/`requiredOnUpdate`/
`writeOnly`/`pattern`/`enum`). That is a structural SUPERSET of what the
component reads: the component only touches the `RecordType` subset, and
the extra keys are loader-resolved data, not capabilities — no `orgId`,
no `Authz`, no server action. Pass the array through untouched; do NOT
reshape or strip it (stripping `enum`/`pattern` would silently change the
reference the console renders).

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/api-docs',
  // The REST console. Its whole body is one client workbench fed by the
  // loader-bound schema; the left rail renders one <li> per record type
  // server-side (the query filter starts empty, so `filtered` is the full
  // schema). ONE variant only: the page consumes no search params, so any
  // second variant would render byte-identical markup and trip
  // `assertVariantsDiffer` (conformance.mjs:1969) — the /query precedent.
  variants: [{ query: '', expect: 'main aside ul li', minMatches: 10 }],
  expect: 'main aside ul li',
  minMatches: 10,
},
```

Rail-count verification (read-only queries, 2026-09-10, `openbooks_sim_viewspec`):

- Built-in registry (`web/lib/api/registry-data.ts:62-175`): 9 types, ALL
  with `table` set, so all survive the `loadApiSchema` table filter.
  Feature-gated two: `projects` (gate `projects`, registry default ON,
  harness org blob HAS the key) and `assets` (gate `fixedAssets`,
  registry default ON, blob HAS the key) — both kept. → 9 built-in.
- Custom: `select key, name … where org_id='<harness>' and
  status='published'` → exactly 1 row: `site_visit|Site visit`.
  (Plus 2 active `custom_field_defs` on `documents`/`parties` — field-level
  only, they add `cf_*` fields, not rail rows.)
- 9 + 1 = **10 `<li>`** on both paths — same component, same prop, same
  SSR output, identical by construction.

GATES verification (the page 404s unless BOTH pass — verify gates, not
just rows):

- Permission: harness user `viewspec@sim.test`
  (`01a08426-0962-74c7-a086-e1609c589dcb`) has `is_super_admin = true`,
  and super-admins resolve to `permissions = {"*"}` (`web/lib/authz.ts:36`),
  so `requirePermission('api.keys.manage')` passes (a redirect, not a
  throw, on failure).
- Feature: harness org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`
  ("SIM · Summit Ridge Construction") `settings->'features'` contains
  `"apiAccess": true`, so `requireFeatureEnabled` passes (would
  `notFound()` otherwise).

No fixture needed: no fixture ROWS (no table path, no drawer id), no
feature merge (`apiAccess` is already on in the harness blob), and NO
allocation-block claim — nothing to collide under `ON CONFLICT DO
NOTHING`. (Grepped the whole fixtures file: no `api-docs`/`ApiConsole`
fixture exists, and the ...0001-0099 … ...99xx blocks listed in the
allocation table are untouched by this page.)

Viewport note: the rail `aside` is `hidden … lg:flex`. The harness runs
at 1440px (`VIEWPORT`, conformance.mjs:45) ≥ the `lg` breakpoint, so the
`li` nodes have boxes and the default `visible` expect-state holds. Do
not move this entry to a narrower viewport without switching to
`expectState: 'attached'`.

## 3. What the spec does NOT cover (nothing renderable is missing)

- No `sections.tsx`: the page defines no local components, and
  `ApiConsole` already lives in its own module (`./ApiConsole.tsx`),
  imported by BOTH branches — the brief's "MOVE it here" rule exists to
  prevent a second copy, and there is only one by construction. Never
  write a second copy.
- No `pageHeader` block: the native header is a bespoke `div` (icon tile
  + title/subtitle + `v1` Badge + token input), not the shared
  `PageHeader`, and decomposing it would retype its classes from memory.
  The widget renders the header exactly as the native component does.
- The loader binds NO title/description strings: every string stays
  inside the component's own `useTranslations('apiDocs')` calls, exactly
  as the native branch does — threading static copy through widget props
  would double every key and drift from the catalog on the first copy
  edit (the `query-console` precedent, `query/INTEGRATION.md` §1). No
  message key is invented; `view.ts` makes zero `t('…')` calls.
- The request builder, body-template seeding (`bodyTemplate`/`sampleFor`
  per writer kind), token gating, fetch + timing, and response
  pretty-printing are untouched client behavior — the spec language has
  no vocabulary for them by design (no conditionals, no function
  values, no component references).
- `layout: 'bare'` is load-bearing, not a default: the native root is
  `flex h-full min-h-0 flex-col` under the app shell's `<main>` (which
  the harness scopes, not anything ModuleView wraps). `list`/`detail`
  would nest a second `ListPageLayout` (sticky header container + padded
  body) around the workbench and break pixel parity — same as `/query`.
- The widget block renders as a bare Fragment (`WidgetBlockView`,
  `widgets.tsx:3083` — `<>…</>`), and `BlockList` adds no wrapper
  (`blocks.tsx:554`), so the spec path emits the console's root `div`
  exactly where the native branch does. `layout: 'bare'` concatenates
  header (empty) + body with no `ListPageLayout` chrome (`module-view.tsx:51`).
- The `Select`'s `data-selected-value` stamping (conformance.mjs
  `renderSettled`) covers the method dropdown identically on both
  paths — same component, same DOM. The token `Input` is uncontrolled
  client state (empty on both initial renders).

## 4. Anything I could not express

Nothing. The page has no server-rendered conditional, no sorted/filtered
list, no drawer, no per-row action, and no second branch — the only
server work is gates + one plain-data prop, both fully expressed.

## 5. Pre-existing state of the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts,
no new files from main.
