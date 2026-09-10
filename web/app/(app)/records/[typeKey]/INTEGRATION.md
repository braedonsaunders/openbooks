# INTEGRATION — `/records/[typeKey]` ViewSpec handoff

Page: the auto-generated module for one published record type (list +
instant-draft flyout). Files owned by this conversion:

- `web/app/(app)/records/[typeKey]/view.ts` — `loadRecordModule(sp, typeKey)`
  plus `recordModuleSpec(data)`.
- `web/app/(app)/records/[typeKey]/page.tsx` — `__viewspec=1` branch added
  (native branch untouched). No `sections.tsx`: every cell is a single leaf
  (`link`, `text` with em-dash fallback, `badge`), so no composite cells exist.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

Imports to add:

```tsx
import { NewRecordButton } from '../../app/(app)/records/[typeKey]/NewRecordButton'
import { RecordDrawer } from '../../app/(app)/records/[typeKey]/RecordDrawer'
```

Entries:

```tsx
'new-record': (props) => (
  <NewRecordButton typeKey={str(props, 'typeKey') ?? ''} typeName={str(props, 'typeName') ?? ''} />
),
'record-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof RecordDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <RecordDrawer key={remountKey} {...rest} />
},
```

`show-inactives-toggle` already exists in the registry — no entry needed.
The empty state uses the generic `empty-state` widget with
`action: 'new-record'` + `actionProps: { typeKey, typeName }` — no entry needed.

Spec-to-widget wiring (already in `recordModuleSpec`, for reference):

- header action: `widget('new-record', newRecordProps, f('canCreate'))`
  (WidgetSlot is a Fragment — a `when`-off widget leaves no wrapper div, so
  the no-permission header matches the native one exactly).
- filter row: `search-input`, `filter-chips` (status), `show-inactives-toggle`,
  then one `filter-chips` per choice field (`f_<fieldId>`).
- body: generic `empty-state` (when `isEmpty`), app-variant `table` (when
  `hasRows`), `pagination` (when `hasRows`), `record-drawer` (when
  `drawerOpen`).

## 2. Proposed conformance entry (`scripts/viewspec-conformance.mjs`)

```js
{
  path: '/records/site_visit',
  variants: ['', '?status=active', '?q=zzzznomatch'],
  // The sim seed's only published record type holds ZERO records, so every
  // variant renders the total === 0 empty branch. The variants still pin real
  // branches: the status chip set, and a search term. The h3 is the
  // EmptyState title (the header renders h1; the filter row has no headings).
  expect: 'main h3',
  minMatches: 1,
},
```

Verified against the database (`openbooks_sim_viewspec`, RLS bypassed):

```
key             | status    | record_count
site_visit      | published | 0
safety_incident | draft     | 0   → 404 (not published)
legacy_permit   | archived  | 0   → 404 (not published)
```

Proposed fixtures (`scripts/viewspec-fixtures.sql`, idempotent, same style as
the existing file — fixed ids, `ON CONFLICT DO NOTHING`, SIM org only). The
seed `site_visit` type has one section with two fields: `visited_on` (date)
and `notes` (long_text, unlistable). Two records exercise the table branch,
the sort headers (`number`, the one listable column, `created`), a formatted
date cell, and an em-dash fallback is NOT covered (both columns always have
values — `notes` never renders). A third record with `{}` data would cover
the dash, and a `?rec=<id>` drawer variant needs `scopes:
['main', '[data-drawer-layer]']` per the records/types precedent:

```sql
-- Records-module fixtures: two site_visit rows (fixed ids, SIM org only).
insert into custom_records (id, org_id, type_id, type_key, record_number, data, search_text, status)
select v.id, t.id, 'site_visit', 'SV-00000' || v.n,
       jsonb_build_object('visited_on', '2026-0' || v.n || '-15', 'notes', 'Harness visit ' || v.n),
       'sv-00000' || v.n || ' harness visit',
       case when v.n = 1 then 'active' else 'draft' end
  from (values
    ('00000000-0000-7000-a000-000000000001', 1),
    ('00000000-0000-7000-a000-000000000002', 2)) as v(id, n)
  join (select id, key from custom_record_types where key = 'site_visit') t on true
  join orgs o on o.id = t.org_id and o.name like 'SIM · %'
on conflict (id) do nothing;
```

Note: the join through `t.org_id` keeps the rows in whichever org owns the
seed type, and the `SIM · %` guard keeps the coordinator's SIM-only rule.
`created_by`/`updated_by` are nullable (no NOT NULL in the table shape above),
so they are left unset, matching "seeded, not user-created".

With those rows live, the entry above should gain
`{ query: '', expect: 'table tbody tr', minMatches: 2 }` (replacing the h3
expectation) plus `'?sort=number&dir=asc'` and a drawer variant.

## 3. What could not be expressed (and why)

1. ~~Drawer remount key~~ — solved via the merged vocabulary: the loader puts
   `remountKey: String(openRecord.id)` on the drawer props and the
   `record-drawer` entry above strips it into a React key, exactly as
   `party-drawer` / `account-drawer` / `project-drawer` already do.
2. **Dynamic columns.** The table's data columns come from the record type's
   schema (first five listable fields), not a fixed list, so
   `recordModuleSpec` maps loader-provided column descriptors to `column()`
   defs and rows carry a flattened `cells.<fieldId>` map bound by matching id.
   The column SET is stable per typeKey (it changes only when the type is
   redesigned), while row data varies per request — the opposite of the
   compliance matrix, whose per-cell policy logic is why it stayed a whole
   component. Field ids are forms-core identifiers (`/^[A-Za-z0-9_-]+$/`, dots
   impossible), so the constructed paths stay single-segment lookups.
3. **Nothing else.** Permissions (`records.read` gate, audience 404,
   `canCreate`), visibility-filtered counts, money/date/choice formatting, sort
   expressions, and the `total === 0` vs `hasRows` split are all reproduced
   verbatim in the loader.
