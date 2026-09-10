# /admin/audit ViewSpec integration handoff

Page: `/admin/audit` — the company audit log. List + filter chips + date
range + hand-rolled client rows table + interactive event drawer. Closest
worked example is the org-users conversion (`admin/users/view.ts`): same
shape (PageHeader with back link, search + chips, widget table, pager), same
reason the table stays a widget.

Files created (all inside `web/app/(app)/admin/audit/`, the only dir this page owns):

- `view.ts` — `loadAudit(sp)` + `auditSpec(data)`. The loader copies the
  native page's permission gate (`admin.audit.read`), the unrestricted-
  subsidiary `redirect('/')`, the malformed-param `notFound()`, the effective-
  record-type expression, and all six queries VERBATIM. Row payloads and the
  drawer payload carry ISO `at` strings; the client components format dates
  exactly as on the native path.
- `sections.tsx` — `AuditRowsTable` and `AuditEventFlyout`, thin wrappers
  around the SAME `AuditRows` / `AuditEventDrawer` components the native
  `page.tsx` renders. No markup moved, no second copy: the brief's
  "move it here and import it back" applies to local components the spec
  needs to name, and these two were already shared siblings — the section
  file only re-exports them under widget-friendly names with the drawer
  union narrowed to the URL variant both paths use.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { AuditRowsTable, AuditEventFlyout } from '../../app/(app)/admin/audit/sections'

/* --- audit log ------------------------------------------------------------ */
'audit-rows-table': (props) => (
  <AuditRowsTable
    rows={(props.rows as ComponentProps<typeof AuditRowsTable>['rows']) ?? []}
    selectedId={(str(props, 'selectedId') ?? undefined) as ComponentProps<typeof AuditRowsTable>['selectedId']}
  />
),
'audit-event-drawer': (props) => {
  const drawer = props.drawer as { event: ComponentProps<typeof AuditEventFlyout>['event']; closeHref: string } | null
  if (!drawer) return null
  return <AuditEventFlyout event={drawer.event} closeHref={drawer.closeHref} />
},
```

Reused with NO change (already in the registry — verify, don't duplicate):

- `'search-input'`, `'filter-chips'` (×3: rtype / actor / action), `'empty-state'`,
  `'pagination'`
- `'date-range-filter'` — takes `fromLabel`/`toLabel`/`clearLabel`; the native
  page passes all three, so the spec passes all three. (The widget's
  `fromKey`/`toKey` default to `from`/`to`, matching the page's param keys.)
- `'docs-link-button'` — outline `sm` Button-as-Link with the BookOpen-14
  glyph pointing at `/docs/audit-log`. Same component AND same contract as
  the native header action: `{ href, label }`. Verified against the registry
  source (lines ~547-557), not just the name.

One registry gap the coordinator must close: the native empty state carries
the `ScrollText` glyph (`icon={<ScrollText />}`), but the `empty-state`
widget's closed icon map has no `scroll-text` key — today that renders the
empty state with NO icon on the spec path. Either add
`'scroll-text': <ScrollText />` to the map (and the lucide import), or accept
the missing glyph. Do not special-case it in the audit entries.

## What the coordinator must NOT create

No new slot is needed. Authz, org id, and the subsidiary-scope decision stay
inside `loadAudit` (server code). The drawer payload (`event.changes` is
arbitrary JSON) travels as widget data to the shared component — the spec
never inspects it.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/audit',
  // 488 sim-org rows across 5 actions; variants exercise the action filter,
  // the actor filter (system has no rows in sim — empty-state branch), the
  // date range, and the event flyout over a real id.
  variants: [
    '',
    '?action=post',
    // No system-actor rows in sim: total hits 0, exercises the empty state.
    '?actor=system',
    '?from=2026-09-08&to=2026-09-08',
    // The event flyout, portaled to <body>.
    {
      query: '?event=01a083e7-3bb7-7dc6-88e6-dcf4e53e8270',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, role `admin`):

- GATES FIRST (the /query lesson). `requirePermission('admin.audit.read')`:
  the admin role's permission JSON **includes `admin.audit.read`** (verified
  verbatim in the role row). Subsidiary gate: the admin role's
  `subsidiary_restriction` is `{"mode": "all"}`, which resolves to
  `allowedSubsidiaryIds === null` → the `redirect('/')` does NOT fire. The
  page renders 200 for the harness tenant; neither gate 404s.
- `audit_log` rows for the sim org: **488** (all org rows — the sim DB holds
  only this org's log). Default page size is 50, so the default variant
  renders 50 rows — `minMatches: 5` is conservative.
- Actions present: post **425**, insert **27**, approve/invoice/submit **12**
  each → `?action=post` renders 50 rows (still paged).
- Actors: exactly one non-null actor id across all 488 rows, zero
  system-actor rows → `?actor=system` renders the empty state (total 0).
  Actor filter options: 1 user row + implicit system value.
- Effective record types (documents split by kind): **9** distinct values →
  the rtype chip row is non-trivial.
- Date range: all rows dated **2026-09-08** → `?from=2026-09-08&to=2026-09-08`
  matches all 488 (the `to` bound is end-of-day inclusive).
- Drawer id `01a083e7-3bb7-7dc6-88e6-dcf4e53e8270` is the most recent `post`
  event in the org. Note: `?event=<garbage>` renders no drawer on EITHER
  path (loader resolves null); only the valid-id variant exercises the
  flyout.
- No fixture SQL is proposed and **no fixture id block is claimed**: every
  exercised branch above already has sim data. The malformed-param `notFound`
  branches (`?actor=xyz`, `?from=blah`) need no harness variant — both paths
  share the loader.

## Could not express

Nothing structural. Two coordinator-owned closes (above): the `scroll-text`
empty-state icon, and confirming the `[data-drawer-layer]` scope convention
matches the drawer variant pattern the journal conversion used.
