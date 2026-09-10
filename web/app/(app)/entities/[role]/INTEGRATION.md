# INTEGRATION — `/entities/[role]` ViewSpec conversion

Page dir `web/app/(app)/entities/[role]/` is converted. Three files are owned
and finished here: `view.ts` (loader + spec), `page.tsx` (native branch plus a
`__viewspec` branch, mirroring `records/[typeKey]` and `admin/setup/[entity]`),
and this handoff. **The coordinator owns everything below: registry entries,
conformance entry, fixtures. Nothing is applied.**

No fixture rows are needed. The sim tenant
(`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, `SIM · Summit Ridge Construction`)
already holds 5 active-customer / 12 active-vendor / 12 active-employee
parties (verified read-only against `openbooks_sim_viewspec`; see §5). No
fresh id block is claimed and no SQL is proposed.

## 1. What the page is

`/entities/customers`, `/entities/vendors`, `/entities/employees` share one
dynamic-segment page. Almost all of it is the universal entity list; what is
page-specific is:

- the header copy (`entities` catalog, `roles.<slug>.title/description`),
- the new-party button, which carries per-role `basePath`, `role` and a
  translated `label` ("New customer", not "New party"),
- the drawer slot: a fragment of up to three components — a create-redirect,
  the party flyout, and a related-transaction flyout — exactly the projects
  arrangement.

No `sections.tsx` is needed: there are no composite cells. The drawer payload
verbatim-copies the native `PartyDrawer` prop assembly (all 9 pickers,
`resolveFormLayout` with `recordType: role`, `key={party.id}` as remount key).

## 2. `WIDGET_REGISTRY` entries (coordinator adds)

Two new widgets. `new-party` / `new-party-redirect` exist but are prop-less
(hard-wired to `/parties` with the default label); this page's buttons need
the role's own path and label, and a spec can only supply that as props.

```tsx
/* --- entity role lists ---------------------------------------------------- */
'new-role-party': (props) => (
  <NewPartyButton
    basePath={str(props, 'basePath') ?? '/parties'}
    role={(str(props, 'role') ?? 'customer') as 'customer' | 'vendor' | 'employee'}
    label={str(props, 'label') ?? ''}
  />
),
'new-role-party-redirect': (props) => (
  <NewPartyRedirect
    basePath={str(props, 'basePath') ?? '/parties'}
    role={(str(props, 'role') ?? 'customer') as 'customer' | 'vendor' | 'employee'}
  />
),
```

- Props are loader-resolved strings (`basePath` is `/entities/<slug>`,
  `label` is `t('roles.<slug>.newLabel')` from the `entities` catalog). All
  three keys the loader reads already exist and are used by the native page.
- Byte-equivalence: `<NewPartyButton basePath role label>` in the widgets
  file instantiates the same component with the same props the native page
  passes, so the header action and the empty-state action render identically
  (both paths instantiate the component twice — header + empty state — so
  hook state is per-placement in both).
- Needs imports: `NewPartyButton`, `NewPartyRedirect` from
  `../../app/(app)/parties/NewPartyButton` /
  `../../app/(app)/parties/NewPartyRedirect` (same relative depth as the
  existing `NewSetupButton` import, lines 60–61).
- Reused, not proposed: `entity-list-view` (with `EntityListSlot`),
  `party-drawer`, `related-txn-drawer`. The entity `recordType` values the
  spec passes (`customer` / `vendor` / `employee`) are the ones already
  registered in `lib/list/entity-sources.ts` with `basePath`
  `/entities/<slug>` and `drawerParam: 'party'` — no source changes needed.

## 3. Conformance entry (coordinator adds)

Dynamic segments have no precedent in the harness yet (`records/[typeKey]`
and `admin/setup/[entity]` converted but list no entry). The concrete paths
work as literal strings, so propose one entry per role:

```js
{
  path: '/entities/customers',
  // The default saved view sorts by display name; all five sim customers
  // are active, so the unfiltered list shows every one.
  variants: [
    '',
    // The flyout path. The id is a sim-org customer party; the drawer is
    // portaled to <body>, so the layer scope must be named explicitly (same
    // arrangement as the /parties drawer variant).
    {
      query: '?party=1186e699-5da5-466e-8adb-a85ed07a9ee6',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
{
  path: '/entities/vendors',
  variants: [
    '',
    {
      query: '?party=96c6a13b-5ae5-4627-b56a-1fc2c5bec9fc',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 10,
},
{
  path: '/entities/employees',
  variants: [
    '',
    {
      query: '?party=e1951303-c5ae-4cf6-a407-2b450c6b3720',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 10,
},
```

`minMatches` rationale: the default view shows active parties only — 5
customers (all active), 12 vendors, 12 employees. The vendor/employee entries
use 10 rather than 12 so one archived record does not flip the harness; the
customer entry uses exactly 5 (verified row counts in §5). Drawer ids are
verified sim-org rows: `1186e699…` (Harborview Development LLC, customer),
`96c6a13b…` (Apex Mechanical Subs — the same vendor id the `/parties`
drawer variant already uses), `e1951303…` (employee).

## 4. What could not be expressed

Nothing structural. Two things for the coordinator to confirm:

- The `entity-list-view` spec call passes no `drawer`/`emptyAction` when the
  slot list is empty: `[]` after `.filter(Boolean)` renders as `undefined`
  through the registry's `slot()` helper (empty array → no rendered nodes →
  `undefined`), matching the native page passing `drawer={empty fragment>}`.
  If the harness shows an empty-state-action diff, the fix is a
  null-vs-empty-fragment difference in the slot, not in this spec.
- `NewPartyButton`'s `label` prop defaults to `t('defaultLabel')` ("New
  party") when undefined; the loader always supplies the role label, so the
  fallback never fires on this page.

## 5. DB verification (read-only, `openbooks_sim_viewspec`)

```sql
-- 5 customers, 12 vendors, 12 employees (active canonical role rows):
select count(*) filter (where exists (... customer_roles ...)),
       count(*) filter (where exists (... vendor_roles ...)),
       count(*) filter (where exists (... employee_roles ...))
  from parties p where p.org_id = '<sim>';
-- → 5|12|12
-- Drawer ids resolve in the sim org: 96c6a13b… present; first customer
-- 1186e699… (Harborview Development LLC); first employee e1951303….
```
