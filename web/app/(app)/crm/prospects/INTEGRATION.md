# Prospects (`/crm/prospects`) — ViewSpec integration handoff

Loader + spec: `view.ts` (`loadProspects` / `prospectsSpec`).
No `sections.tsx` — the page defines no local components and the spec places
no composite cells.

The conversion follows the `/crm/opportunities` precedent
(`web/app/(app)/crm/opportunities/view.ts`): the native page is a thin
entity-list wrapper (`AccountList` with `stage="prospect"`), so the spec owns
only the header (`pageHeader` + new button) and the `entity-list-view` slot
with a single-element drawer list. The loader copies `AccountList`'s queries,
permissions and drawer assembly verbatim.

Permission notes (match the native page exactly):

- Header action gate is `canCreate` (`crm.accounts.create`), not `canManage`
  — unlike opportunities, which gates its button on `manage`.
- The `entity-list-view` slot re-derives the customization permission
  (`admin.customization.manage`) from the session, same as the native
  `EntityListView` call inside `AccountList`.
- The drawer payload carries `canManage` (`crm.accounts.manage`) for the
  flyout's Save button, verbatim from `AccountList`.

## WIDGET_REGISTRY entries needed (coordinator: `web/components/viewspec/widgets.tsx`)

`'crm-new-button'` and `'entity-list-view'` already exist and need no change.
One new entry:

Imports:

```tsx
import { AccountDrawer as CrmAccountDrawer } from '../../app/(app)/crm/AccountDrawer'
```

Entry:

```tsx
/* --- crm prospects -------------------------------------------------------- */
/**
 * The CRM account flyout shared by /crm/leads and /crm/prospects. Named
 * `crm-account-drawer` because the registry already owns an unrelated
 * `account-drawer` (the chart-of-accounts flyout).
 * The native drawer carries no `key`, so neither does this entry: switching
 * accounts reuses the mounted flyout in both renders.
 */
'crm-account-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof CrmAccountDrawer> | null
  if (!drawer) return null
  return <CrmAccountDrawer {...drawer} />
},
```

Notes:

- The `drawer` prop shape is the exact `AccountDrawer` props object
  (`data` / `statuses` / `owners` / `territories` / `sources` / `basePath` /
  `canManage`). The `data` field is `{ ...party, crm: account }` where
  `party` is the full `PartyPayload` from `loadParty` and `crm` is the
  `loadCrmAccount` result — both are row-JSON the loader passes through
  untouched, so they serialize cleanly.
- The drawer slot is a single-element list (native renders at most the
  account flyout; there is no `?account=new` redirect). The
  `entity-list-view` slot already accepts a list, so no registry change is
  needed there.
- The leads page (`/crm/leads`) shares `AccountList` and `AccountDrawer`; its
  future conversion reuses this same `crm-account-drawer` entry with
  `recordType: 'lead'` and its own `crm-new-button` props.

## Fixture SQL needed (coordinator: append to `scripts/viewspec-fixtures.sql`)

The sim tenant holds **zero** `crm_account_profiles` rows (verified:
`select count(*), lifecycle_stage … group by 2` returns no rows), so the
page compares two identical empty states without fixtures. Claiming fresh
block `…000000001301–1304` in the `9000` series (verified: no
`0000-7000-9000-0000000013*` id exists anywhere in the fixtures file, and no
other block in the allocation table claims `…1301+`).

Two prospect accounts on real sim-org statuses, with different owners, so the
status/owner filter chips and the sort columns have something to select and
the drawer pickers render:

```sql
-- ---- crm prospects -------------------------------------------------------
-- The simulator never creates CRM account profiles, so /crm/prospects would
-- compare two identical empty states. Two prospect accounts on the sim org's
-- real prospect statuses (Open, Nurturing) with different owners.
-- Block …1301–1304 claimed by the prospects conversion; verified free.
do $$
declare
  v_org uuid;
  v_status_open uuid;
  v_status_nurturing uuid;
  v_owner_a uuid;
  v_owner_b uuid;
  v_party_a uuid := '00000000-0000-7000-9000-000000001301';
  v_party_b uuid := '00000000-0000-7000-9000-000000001302';
begin
  select id into v_org from orgs where name like 'SIM · %' order by name limit 1;
  if v_org is null then
    raise notice 'no SIM org present; skipping ViewSpec fixtures';
    return;
  end if;
  select id into v_status_open from crm_account_statuses
   where org_id = v_org and lifecycle_stage = 'prospect' and name = 'Open' and is_active
   order by sequence limit 1;
  select id into v_status_nurturing from crm_account_statuses
   where org_id = v_org and lifecycle_stage = 'prospect' and name = 'Nurturing' and is_active
   order by sequence limit 1;
  select id into v_owner_a from users where org_id = v_org and is_active order by name limit 1;
  select id into v_owner_b from users where org_id = v_org and is_active order by name limit 1 offset 1;
  if v_status_open is null or v_owner_a is null then
    raise notice 'missing prospect status or owner; skipping prospects fixtures';
    return;
  end if;

  insert into parties (id, org_id, kind, display_name, email, phone, website, is_active)
  values (v_party_a, v_org, 'customer', 'ViewSpec Prospect Alpha', 'alpha@viewspec.test', '555-0101', 'https://alpha.viewspect.test', true),
         (v_party_b, v_org, 'customer', 'ViewSpec Prospect Beta', 'beta@viewspec.test', '555-0102', 'https://beta.viewspect.test', true)
  on conflict (id) do nothing;

  -- subsidiary_id stays null so crmSharedScope (null = org-wide visible)
  -- passes for any grant set, including the harness admin.
  insert into crm_account_profiles
    (id, org_id, party_id, lifecycle_stage, status_id, owner_user_id,
     industry, qualification_score, last_activity_at, is_active)
  values ('00000000-0000-7000-9000-000000001303', v_org, v_party_a, 'prospect',
          v_status_open, v_owner_a, 'Construction', 72, now() - interval '2 days', true),
         ('00000000-0000-7000-9000-000000001304', v_org, v_party_b, 'prospect',
          coalesce(v_status_nurturing, v_status_open), v_owner_b, 'Real estate', 45, now() - interval '9 days', true)
  on conflict (id) do nothing;
end $$;
```

## Proposed conformance entry (coordinator: `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/crm/prospects',
  // Thin entity-list wrapper: the header button and one drawer slot. Both
  // fixture prospects (…1303/…1304) join real sim-org prospect statuses, so
  // they render in the default list; the second variant opens the first
  // fixture's flyout.
  variants: [
    '',
    // The flyout path. …1301 is a sim-org prospect visible to the harness
    // user, and the drawer is portaled to <body>.
    {
      query: '?account=00000000-0000-7000-9000-000000001301',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Verified against the database (`openbooks_sim_viewspec`, read-only, before
fixtures):

- `crm_account_profiles` in the SIM org (`da472d3a-…`): **0 rows** — the
  fixture is load-bearing, not decorative.
- Sim-org `crm_account_statuses` has active prospect statuses `Open`,
  `Nurturing`, `Closed lost`, and ≥2 active users, so the fixture's
  status/owner lookups resolve.
- Sim-org `list_views` has a `prospect` Default view with no filters, 6
  visible columns + `_actions`, sorted by `account_name` asc — both fixtures
  render in the default list (2 rows >= minMatches 2).
- The `?account=<id>` variant needs no extra fixture: fixture `…1301`
  resolves through `loadParty` (null `subsidiary_id` passes the subsidiary
  guard) + `loadCrmAccount`, and the drawer pickers are ordinary org-scoped
  selects.

## Anything I could not express

Nothing. No new vocabulary needed: `layout: 'list'`, `pageHeader`,
`entity-list-view` with a single-element drawer slot, and two registry
widgets (`crm-new-button` existing, `crm-account-drawer` proposed) that
delegate to the existing `CrmNewButton` / `AccountDrawer` components cover
the page. No `sections.tsx` (no composite cells, no local components to
move), and none of the three named pitfalls apply (no native `<section>`, no
`tabular-nums` on a `<td>`, no pager — the entity list owns its own).

...[truncated 3880 chars]