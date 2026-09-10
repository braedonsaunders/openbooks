# /admin/pdf-templates ViewSpec integration handoff

Page: `/admin/pdf-templates` — org PDF templates plus one built-in starter
row per record type, in a single client-searched/paginated list
(`TemplatesList` over `PagedTable`, with a type dropdown, a read-only
starter preview drawer, and prompt-then-fetch new/duplicate mutations).

Files created/edited (all inside `web/app/(app)/admin/pdf-templates/`,
the only dir this page owns):

- `view.ts` — `loadPdfTemplates()` + `pdfTemplatesSpec(data)`. The loader
  copies the native page's permission, visibility and derivation logic
  verbatim (the `admin.customization.manage` gate, the feature-gated
  `disabledDocKinds` filter applied to BOTH the catalog and the stored
  templates, the effective-default derivation). Title/description/back
  label are the native page's resolved strings.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged. The component now takes `searchParams` (required for
  the `__viewspec` branch). No `sections.tsx`: the page needs no
  composite cell — the body is a single client component, not a spec
  table.

## WIDGET_REGISTRY entry needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

One entry. Flat props — the spec passes `templates`, `starters` and
`recordTypes` as three top-level props (NOT a single `list` object):

```tsx
import { TemplatesList } from '../../app/(app)/admin/pdf-templates/TemplatesList'

/* --- admin pdf-templates ---------------------------------------------------- */
// Whole-page widget, not a `table` block: the native page renders one client
// component owning the search box + type dropdown (local useState), client
// pagination (PagedTable state), the starter preview drawer (a POST-fetch
// effect rendering into an iframe), and prompt-then-fetch mutations (new /
// duplicate via TemplateActions). Filter state, effects and capabilities
// are not spec vocabulary, so the component stays whole and the spec
// places it. The loader resolves every server input (permission,
// feature-gated catalog, stored templates, effective defaults); the
// session never crosses the boundary.
'pdf-templates-list': (props) => (
  <TemplatesList
    templates={(props.templates as ComponentProps<typeof TemplatesList>['templates']) ?? []}
    starters={(props.starters as ComponentProps<typeof TemplatesList>['starters']) ?? []}
    recordTypes={(props.recordTypes as ComponentProps<typeof TemplatesList>['recordTypes']) ?? []}
  />
),
```

Needed import: `TemplatesList` as above. `ComponentProps` already exists
in that file. `TemplatesList` is a client component (`"use client"` at
its top); `widgets.tsx` already renders other client components
(`StatementMatrixTable`, `TrendChart`, …), so this needs no new
boundary. No name collision: `pdf-templates-list` appears nowhere in
`widgets.tsx` today (verified by grep).

EXACT prop shape (wired verbatim from `TemplatesList.tsx`):

```ts
templates: {
  id: string
  name: string
  description: string | null
  recordType: string
  paperSize: string
  orientation: string
  isActive: boolean
  isDefault: boolean
}[]
starters: {
  recordType: string
  label: string
  sourceHtml: string
  headerHtml: string
  footerHtml: string
  /** No org template is the type default, so the starter is what prints. */
  isEffectiveDefault: boolean
}[]
recordTypes: { key: string; label: string }[]
```

## What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: the loader resolves everything server-side and the
spec binds only flat data plus three already-loaded arrays. The new /
duplicate mutations stay inside `TemplatesList`/`TemplateActions` as
fetch calls to `/api/pdf-templates*`, exactly as on the native path —
the same arrangement as `admin backups` (§"must NOT create").

No `packages/viewspec` changes proposed. Header (`pageHeader` with
`back`) and the `list` layout (native page uses `ListPageLayout` with no
`className` override) are existing vocabulary. The preview drawer is
closed on first paint on both paths, so it contributes nothing to the
settled DOM.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/pdf-templates',
  // Stored + starter PDF templates: back-linked header, one
  // TemplatesList widget (PagedTable: search, type dropdown, 15/page).
  // The SIM tenant holds no pdf_templates rows, so the default variant
  // renders 18 starter rows and nothing else; the fixture below seeds 3
  // org templates (one of them the type default, one inactive) so the
  // template-name links, the default badge, and the inactive badge each
  // have a row. No query params exist on this page — PagedTable search
  // and the type filter are client state — so variants cannot pin them;
  // coverage is the table-row selector over starter + seeded rows.
  // GATES: requires `admin.customization.manage` (the harness admin role
  // holds every catalogue key, so the page renders 200 in the harness
  // tenant once the fixture below lands).
  variants: [{ query: '', expect: 'table tbody tr', minMatches: 21 }],
  expect: 'table tbody tr',
  minMatches: 21,
},
```

Verified against the database (`openbooks_sim_viewspec`, SIM org
`SIM · Summit Ridge Construction`): `pdf_templates` holds **0** rows
today, and the SIM org disables no record types — its `settings.features`
sets `orders: true`, `fieldTickets: true`, and `expenses`/`payroll` are
absent (both `defaultEnabled: true` in `engine/src/feature-registry.ts`),
so `disabledDocKinds` returns `[]` and all 18 `PDF_RECORD_TYPES` survive
as starter rows. The fixture below seeds 3 org templates, so
`minMatches: 21` (18 starters + 3 templates) is exact once fixtures
land — re-verify after the coordinator lands the fixture.

## Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids, `ON CONFLICT DO NOTHING`, SIM org only (same
`v_org` pattern as the existing blocks). Claims the fresh id block
`…3101-3199` (verified: zero occurrences of `…31xx` in the fixtures
file, and no `…31xx` allocation in the table at the top; neighbors
`…29xx` revenue contracts and `…38xx` bank matching rules are both
taken).

Guard note: `pdf_templates` has `id` as its only unique key besides the
FKs, so fixed ids + `ON CONFLICT (id) DO NOTHING` suffice. Natural-key
guard on `(org_id, name)` makes the block idempotent even if a future
fixture seeds same-named rows first. `created_by`/`updated_by` stay null
(the columns are nullable; the page never reads them). `compiled_html`
gets the trivial `'<p>ViewSpec</p>'` — the list page never renders it.
Timestamps are fixed (not `now()`) so ordering is stable across harness
runs.

Three rows: one default template for `customer_invoice` (makes that
type's starter lose its effective-default badge — the conditional-badge
branch), one inactive template for `vendor_bill` (the inactive-badge
branch), and one plain template for `quote`:

```sql
  -- ---- pdf templates (/admin/pdf-templates) --------------------------------
  -- The simulator never authors PDF templates, so the page would compare
  -- two identical starter-only tables. Three org templates: a default for
  -- customer_invoice (that starter loses its effective-default badge),
  -- an inactive one for vendor_bill (inactive-badge branch), and a plain
  -- one for quote. Claims fresh block …3101-3199 (verified unused).
  insert into pdf_templates
    (id, org_id, record_type, name, description, paper_size, orientation,
     margin_mm, header_html, footer_html, source_html, compiled_html,
     is_default, is_active, created_at, updated_at)
  select v.id, v_org, v.record_type, v.name, v.description, v.paper_size,
         v.orientation, 14, null, null,
         '<p>ViewSpec ' || v.record_type || '</p>', '<p>ViewSpec</p>',
         v.is_default, v.is_active,
         timestamptz '2026-08-20 12:00:00+00', timestamptz '2026-08-20 12:00:00+00'
    from (values
      ('00000000-0000-7000-9000-000000003101'::uuid, 'customer_invoice',
       'ViewSpec Default Invoice', 'Seeded default invoice design',
       'letter', 'portrait', true, true),
      ('00000000-0000-7000-9000-000000003102'::uuid, 'vendor_bill',
       'ViewSpec Old Bill', null,
       'a4', 'landscape', false, false),
      ('00000000-0000-7000-9000-000000003103'::uuid, 'quote',
       'ViewSpec Quote', 'Seeded quote design',
       'letter', 'portrait', false, true)
    ) as v(id, record_type, name, description, paper_size, orientation,
           is_default, is_active)
   where not exists (select 1 from pdf_templates
                      where org_id = v_org
                        and name in ('ViewSpec Default Invoice',
                                     'ViewSpec Old Bill',
                                     'ViewSpec Quote'))
  on conflict (id) do nothing;
```

## Could not express

Nothing structural. Judgment calls, all following the stated machinery
rules:

1. The entire body is one widget. `TemplatesList` owns `useState` (type
   filter, preview selection, preview blob URL), a `useEffect` POST
   fetch for the starter preview, and prompt-then-fetch mutations —
   roughly half the component is client state, effects or capabilities.
   Splitting the static table into spec blocks around widget cells would
   byte-split one component for no fidelity gain; it stays whole (same
   doctrine as `admin/users-table` and `admin/backups`).
2. `starterTemplate(meta)` runs in the loader. It is pure HTML-string
   building from the static catalog (no request data), so the loader —
   ordinary TypeScript per the brief — is its correct home. No string
   building crosses into the spec.
3. The starter paper cell (`Letter · Portrait`) and the `PAPER_LABEL`
   map stay inside `TemplatesList`. They format loader-resolved
   `paperSize`/`orientation` strings into display text — formatting in
   the component IS the native behavior, and moving it to the loader
   would change rendered output.
4. No drawer, no pager, no filter-chips widget in the spec: the page has
   no query params (search/filter/pagination are `PagedTable` client
   state; the preview `Drawer` is closed on first paint), so
   `loadPdfTemplates` takes no `sp` — same as `loadAdminBackups`. `sp`
   is still passed to `ModuleView` (required prop) but carries only
   `__viewspec`. `search-input` / `filter-chips` would navigate via URL
   params the native page never reads; using them would DIVERGE the two
   renders rather than match them.
5. `NewTemplateButton` / `DuplicateTemplateButton` (`TemplateActions`)
   are not separate registry entries: they render only inside
   `TemplatesList` cells/toolbar, so they ride along with the
   whole-page widget and need no independent props.
6. Permission-gating note: the harness admin role must hold
   `admin.customization.manage`; without it both paths render the same
   403 and the harness compares two error pages. Same caveat as other
   admin-list conversions.
