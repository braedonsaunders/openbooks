# /admin/setup/project-types ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/project-types/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the page defines no local components (see "What the spec
does NOT cover" below).

Spec widgets used: `project-types-workspace` (proposed below — does not
exist in the registry yet). Everything else the page renders (type list,
four sub-tabs, P&L layout editor, save/delete flows) lives inside that one
widget.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (the component already exists):

```tsx
import { ProjectTypesWorkspace } from '../../app/(app)/admin/setup/project-types/ProjectTypesWorkspace'
```

Entry:

```tsx
/* --- project types setup ---------------------------------------------------- */
/**
 * The whole page is one client island, passed whole like
 * `crm-setup-workspace` and `bank-feeds-workspace`: the type list, the four
 * sub-tabs (general / profitability / invoicing / backup), the P&L layout
 * editor, the chips and enum selects all own client behavior (selection
 * state, sub-tab, draft, busy, financial effective-from/reason, fetch
 * POST/PATCH/DELETE mutations, confirm, toast, router.refresh) a spec
 * cannot name, and the per-sub-tab bodies are a four-way conditional pair,
 * not presence. A spec `table` block is wrong here twice over: variant
 * 'app' renders different list/button markup, and it cannot carry the
 * draft-editing flow. Every prop is loader-resolved data (gates, the
 * lateral effective-version query, the dimension/account pickers, the
 * fieldTickets flag); the entry only binds it.
 *
 * Diffed against the existing entries before writing this one:
 * `entity-list-view`/`record-list-view` are slot-backed universal lists with
 * drawer/emptyAction/rowActions refs — this page's type list is bespoke
 * (per-row built-in/inactive badges, a selected-row highlight, a separate
 * New-row affordance) with an editor beside it, not the universal list.
 * `setup-section` is one generic setup panel with its own shell contract;
 * it cannot carry a master-detail editor with four sub-tabs. So a new
 * entry, following the `crm-setup-workspace` spread pattern.
 */
'project-types-workspace': (props) => (
  <ProjectTypesWorkspace {...(props as unknown as ComponentProps<typeof ProjectTypesWorkspace>)} />
),
```

EXACT prop shape of `ProjectTypesWorkspace` (wire verbatim — the loader's
`ProjectTypesData` already matches it field for field):

```ts
{
  types: ProjectTypeRow[]  // id, key, name, description: string | null,
                           // isBuiltIn, isActive, sortOrder, billingMethod: string | null,
                           // financialProfile: FinancialProfile,
                           // financialProfileEffectiveFrom: string | null,
                           // invoicingProfile: InvoicingProfile,
                           // backupProfile: BackupProfile
  dimensions: string[]
  incomeAccounts: { id: string; number: string; name: string }[]
  fieldTicketsEnabled: boolean
}
```

Note: the current `ProjectTypesWorkspace` destructures only
`{ types, dimensions, fieldTicketsEnabled }` and does not read
`incomeAccounts` yet — pass it anyway. The loader fetches it (the native
page's `acctRes` query) so the prop rides through for the API round-trip
and a future picker, and dropping it from the widget call would fork the
two renders' data. Unused-props destructuring is not a conformance
difference.

## 2. Fixture SQL (for the coordinator — append to `scripts/viewspec-fixtures.sql`)

No fixture needed. The simulator already seeds 5 project types for the
harness org (`Time & Materials|Fixed Price|Cost-Plus|Not-to-Exceed|
Schedule of Values`, all built-in, all active), each with an effective
financial-profile version row, and 6 income/income_other accounts for the
picker. The list renders 5 rows on both paths with zero seeding. The
available-bases branch is covered by data, not fixtures: the harness org
has `settings.features.fieldTickets = true`, so all six bases (including
`field_ticket`) render. The `account_groups` dimension list is empty for
the harness org — the cost-dimension / overhead-dimension selects render
their empty option identically on both paths, so that branch needs no
rows either.

Claimed fresh id block (reserved, unused — do NOT append fixture rows
against it unless a future variant needs them):
`00000000-0000-7000-a000-000000000105` … `00000000-0000-7000-a000-000000000106`
(occupied in the `…a000` range, verified by `grep -o` over the whole
file after the 2026-09-10 main merge: `…001`, `…002` forecast
conformance, `…003`, `…004` CRM prospects, `…010` quota, `…020` snapshot,
`…101`–`…104` CRM setup — no collision; note the `…9000-…105/106`
watchlist ids are a different prefix and do not collide).

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` on 2026-09-10 (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`; harness user `viewspec@sim.test`
holds the admin role, which carries `admin.setup.manage`; the harness org
has `settings.features.projects = true`, so no redirect to
`/admin/setup/features`; `fieldTickets = true`, so the invoicing
`field_ticket` basis renders on both paths identically):

```js
{
  path: '/admin/setup/project-types',
  // One client island: the type list (5 simulator rows, all built-in) plus
  // the master-detail editor. No query params drive branches — selection,
  // sub-tab and draft are all client state — so the default render is the
  // whole page. `main button` counts the list rows' buttons plus the New,
  // sub-tab, help, delete and save buttons.
  variants: [{ query: '', expect: 'main button', minMatches: 10 }],
  expect: 'main button',
  minMatches: 10,
},
```

Row-count verification (read-only queries, harness org):

- `project_types` → 5 (`Time & Materials|Fixed Price|Cost-Plus|
  Not-to-Exceed|Schedule of Values`, ordered by sort_order 10–50, all
  `is_built_in`, all active)
- `project_financial_profile_versions` → 5 (one effective row per type,
  `effective_from = 0001-01-01`, open-ended — the lateral join resolves on
  both paths identically)
- income/income_other active non-summary accounts → 6 (picker data)
- distinct `account_groups` dimensions → 0 rows (empty-option branch,
  identical on both paths)
- `?__viewspec=1` is the harness's own path switch, not a page branch —
  not proposed as a variant

## 4. What the spec does NOT cover (nothing — full coverage by construction)

- No `sections.tsx`: the page defines no local components. `EnumField`,
  `Chips`, `BLANK` and `stableJson` all live in
  `ProjectTypesWorkspace.tsx`, which both render paths share through the
  widget — the same single-implementation rule as the crm island.
- Sub-tab selection, draft editing, the financial-version effective-from /
  reason flow, and save/delete (confirm, toast, `router.refresh()`) are
  internal to the widget; the loader supplies the four query results
  verbatim and the `key={tab:selected?.id}`-style remount state rides
  along.
- `financialProfileEffectiveFrom` arrives as `effective_from::text` from
  the loader (native page's cast, copied verbatim) — no server formatting
  to drift. `useBusinessToday` comes from the `(app)` layout's provider,
  which wraps both paths.
- The `docs/project-types` help link, the `admin/setup/features` link in
  the field-tickets-disabled note, and the `useTranslations('projectTypes'
  | 'common' | 'projects.measures')` copy all resolve inside the shared
  island via its existing hooks, so no message key can be invented. No
  `t()` calls in the loader.
- GATES (not just row counts): `admin.setup.manage` (harness admin role
  has it) + the `projects` feature flag (harness org has it — without it
  both paths `redirect('/admin/setup/features')` and the harness would
  compare two redirects).
