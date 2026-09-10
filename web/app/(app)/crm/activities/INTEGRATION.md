# Activities (`/crm/activities`) — ViewSpec integration handoff

Loader + spec: `view.ts` (`loadActivities` / `activitiesSpec`).
No `sections.tsx` — the page defines no local components and the spec places
no composite cells.

The conversion follows the `/crm/opportunities` precedent
(`web/app/(app)/crm/opportunities/view.ts`): the page is a thin entity-list
wrapper, so the spec owns only the header (`pageHeader` + new button) and the
`entity-list-view` slot with a single-element drawer list. The native drawer's
query, permission and picker logic is copied verbatim into the loader.

## WIDGET_REGISTRY entries needed (coordinator: `web/components/viewspec/widgets.tsx`)

`crm-new-button` already exists (added for the opportunities page) and needs
no change: `CrmNewButton` takes `apiPath`/`basePath`/`param` as props and all
five props here are loader-resolved strings. Only the drawer widget is new.

Imports:

```tsx
import { ActivityDrawer } from '../../app/(app)/crm/ActivityDrawer'
```

Entry (mirrors `opportunity-drawer`; `ComponentProps` is already imported in
`widgets.tsx`):

```tsx
/* --- crm activities ------------------------------------------------------- */
'activity-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof ActivityDrawer> | null
  if (!drawer) return null
  return <ActivityDrawer {...drawer} />
},
```

Exact prop shape the spec passes (FLAT widget props carrying ONE object —
same as `opportunity-drawer`, not flat drawer fields):

```ts
// widget ref placed in the entity-list-view drawer slot:
{ widget: 'activity-drawer', props: { drawer: data.drawer } }
// where data.drawer is ActivityDrawerProps =
//   Parameters<typeof ActivityDrawer>[0] =
//   { data: any; owners: any[]; accounts: unknown[]; opportunities: any[];
//     closeHref: string; canManage: boolean }
// and the registry spreads it: <ActivityDrawer {...drawer} />
```

Notes:

- The loader passes `loadActivity`'s return (`{ activity, links, participants }`)
  through as `data` UNTOUCHED. The `datetime-local` slicing
  (`String(row.starts_at).slice(0, 16)`) happens client-side in
  `ActivityDrawer`'s `useState` initializer, so per the client-format trap the
  loader must not pre-format: raw timestamptz values ride through.
- The native drawer carries no `key`, so neither does the spec's. Both renders
  reuse the mounted flyout when switching activities.
- The drawer slot is a single-element list (a non-uuid `activity` param fails
  `isUuid` and renders no drawer; drafts come from the header button's POST).
  The `entity-list-view` slot already accepts a list, so no change needed there.
- Message keys used by the loader (`activities.title`, `activities.description`,
  `activities.new`, `feedback.createFailed`) are exactly the native page's —
  nothing invented.

## Proposed conformance entry (coordinator: `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/crm/activities',
  // Thin entity-list wrapper: the header button and one drawer slot. The
  // VS-AC fixtures below render in the default list; the second variant
  // opens the first fixture's flyout.
  variants: [
    '',
    // The flyout path. VS-AC-101 is a sim-org activity with no links and no
    // contact participants, so crmActivityScope passes for any grant set and
    // loadActivity resolves it; the drawer is portaled to <body>.
    {
      query: '?activity=00000000-0000-7000-a000-000000000101',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

## Proposed fixture SQL (coordinator: `scripts/viewspec-fixtures.sql`)

Fresh block `00000000-0000-7000-a000-000000000101/102`: the `a000` block holds
only `...001/002/010/020` on main, and no `7000`-prefix row exists in
`crm_activities` today (verified read-only). `crm_activities` has no triggers
and its only CHECKs are date/duration sanity, which the rows below satisfy, so
plain `ON CONFLICT DO NOTHING` is sound — no pre-insert guard needed beyond
the null-owner `raise notice` skip, following the forecasts-block pattern.

```sql
  -- ---- crm activities -------------------------------------------------------
  --
  -- The simulator never writes activities, so the list page would come up
  -- empty. Two UNLINKED activities (no crm_activity_links rows, no contact
  -- participants): crmActivityScope passes unlinked rows for any grant set,
  -- and the Default `activity` list view in both sim orgs has no filters, so
  -- both fixtures render. Dates are relative so the fixture keeps working as
  -- the simulated clock moves.
  declare
    v_act_owner uuid;
  begin
    select id into v_act_owner from users where org_id = v_org order by created_at limit 1;
    if v_act_owner is null then
      raise notice 'no users; skipping activity fixtures';
      return;
    end if;

    insert into crm_activities
      (id, org_id, kind, status, subject, body, priority,
       owner_user_id, assigned_user_id, starts_at, due_at)
    values
      ('00000000-0000-7000-a000-000000000101', v_org, 'task', 'planned',
       'ViewSpec activity conformance A', 'Harness activity A', 'normal',
       v_act_owner, v_act_owner, current_timestamp + interval '1 day', current_timestamp + interval '2 days'),
      ('00000000-0000-7000-a000-000000000102', v_org, 'call', 'in_progress',
       'ViewSpec activity conformance B', 'Harness activity B', 'high',
       v_act_owner, v_act_owner, current_timestamp + interval '3 days', current_timestamp + interval '4 days')
    on conflict (id) do nothing;
  end;
```

Verified against the database (read-only):

- `crm_activities` in `openbooks_sim_viewspec` is EMPTY — the default list
  needs these fixtures, and `minMatches: 2` counts exactly the two rows above.
- Both sim orgs (`01a083e6…` activity view and `da472d3a…` = SIM · Summit Ridge
  Construction) have an `activity` Default view with no filters and 7 visible
  columns (`subject`, `customer_name`, `kind`, `status`, `assigned_name`,
  `activity_date`, `_actions`), so both fixtures render in the default list.
- The entity list's joins are LEFT joins (`users`, lateral `customer`), so
  unlinked activities with no assignee-customer still produce rows.
- `activityWhere` = org match + `crmActivityScope`: with no links and no
  contact participants both `not exists` clauses pass regardless of grants.
- GATES: the loader keeps `requirePermission('crm.activities.read')` (throws
  without it — the harness user needs that grant, same class of gate as the
  opportunities page) and the `crm.activities.manage` button/drawer-save gate.
  Counts are not permission-filtered beyond org + scope, and both are
  reproduced verbatim (the list itself re-derives org/subsidiaries from the
  session inside the `entity-list-view` slot; the drawer passes
  `authz.user.orgId` + `allowedSubsidiaryIds` to `loadActivity`).

## Anything I could not express

Nothing. No new vocabulary needed: `layout: 'list'`, `pageHeader`,
`entity-list-view` with a single-element drawer slot, the existing
`crm-new-button`, and one new `activity-drawer` entry cover the page. No
`sections.tsx` (no composite cells, no local components to move), and none of
the named traps apply beyond the ones handled above (no native `<section>`, no
`tabular-nums` cell, no pager — the entity list owns its own; client-side date
slicing stays in the component; single-object drawer prop shape stated above).
