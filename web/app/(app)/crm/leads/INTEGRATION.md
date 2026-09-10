# Leads (`/crm/leads`) — ViewSpec integration handoff

Loader + spec: `view.ts` (`loadLeads` / `leadsSpec`).
No `sections.tsx` — the page defines no local components and the spec places
no composite cells.

The conversion follows the `/crm/opportunities` precedent
(`web/app/(app)/crm/opportunities/view.ts`): the page is a thin entity-list
wrapper (`AccountList` with `stage="lead"`), so the spec owns only the header
(`pageHeader` + new button) and the `entity-list-view` slot with a
single-element drawer list. The loader copies `AccountList`'s queries,
permission gates, and drawer assembly verbatim, with `stage` inlined to
`'lead'` (`basePath = '/crm/leads'`, `t('accounts.lead.*')`).

Permission note: the header button is gated on `crm.accounts.create` while
the drawer's save control is gated on `crm.accounts.manage` — two different
permissions, so both ride the loader separately (`canCreate` bound to the
header action and the empty action; `canManage` inside the drawer payload).
The entity list's own `canManage` (`admin.customization.manage`) is
re-derived by the slot, never shipped.

## WIDGET_REGISTRY entries needed (coordinator: `web/components/viewspec/widgets.tsx`)

`crm-new-button` already exists (added for opportunities). Only the drawer
widget is new. Imports:

```tsx
import { AccountDrawer } from '../../app/(app)/crm/AccountDrawer'
```

(`ComponentProps` is already imported in `widgets.tsx`. Note: this is the CRM
`AccountDrawer`, not the chart-of-accounts `AccountDrawer` already imported
from `../../app/(app)/accounts/AccountDrawer` — the two components share a
name and the import must not be merged.)

Entry (mirrors `opportunity-drawer` / `activity-drawer` — flat drawer-object
payload, not the accounts-page `remountKey` shape; `ComponentProps` is
already imported in `widgets.tsx`):

```tsx
/* --- crm leads ------------------------------------------------------------ */
'crm-account-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof AccountDrawer> | null
  if (!drawer) return null
  return <AccountDrawer {...drawer} />
},
```

Prop shape (exact — the coordinator wires it verbatim):

```ts
// props: { drawer: AccountDrawerProps | null }
// AccountDrawerProps = Parameters<typeof AccountDrawer>[0] =
{
  data: any             // { ...loadParty(openId), crm: loadCrmAccount(openId) }
  statuses: { id: string; name: string; lifecycle_stage?: string }[]
  owners: { id: string; name: string }[]
  territories: { id: string; name: string }[]
  sources: { id: string; name: string }[]
  basePath: string      // drawerReturn when it starts with '/crm/leads', else '/crm/leads'
  canManage: boolean    // can(authz, 'crm.accounts.manage')
}
```

Notes:

- All `crm-new-button` props are loader-resolved strings
  (`t('accounts.lead.new')`, `t('feedback.createFailed')`), so no
  message-key lookup happens in the registry — same as opportunities.
- The native drawer carries no `key`, so `crm-account-drawer` applies none
  either. Both renders reuse the mounted flyout when switching accounts.
- The drawer slot is a single-element list (native renders at most the
  account flyout; there is no `?account=new` redirect). The
  `entity-list-view` slot already accepts a list, so no registry change is
  needed there.
- `prospects/page.tsx` renders the same `AccountList` with
  `stage="prospect"`; whoever converts it will reuse `crm-new-button` with
  `basePath: '/crm/prospects'` and this same `crm-account-drawer` entry.

## Proposed fixture SQL (coordinator: `scripts/viewspec-fixtures.sql`)

The SIM org has zero `crm_account_profiles`, so `/crm/leads` compares two
empty states without fixtures. Two lead accounts in one block, following the
CRM-activities fixture pattern (fixed ids, `ON CONFLICT DO NOTHING`,
org-scoped selects for owner/status, relative dates). Claimed fresh block
`…a000-000000000003–004` — verified by grepping the whole fixtures file and
the conformance registry: `…001/…002` are forecasts/opportunities AND
site-visit records AND activities (`…101/…102` are lead sources, sales teams,
and activities); `…010/…020` are quota/snapshot; `…103/…104` are sales team
membership/territory. `…003–…009` appear nowhere.

```sql
  -- ---- crm leads ----------------------------------------------------------
  --
  -- The simulator never writes account profiles, so the leads list would come
  -- up empty. Two active lead profiles on active company parties with a lead
  -- lifecycle status: leadWhere requires cp.lifecycle_stage = 'lead' and
  -- cp.is_active and p.is_active, and subsidiary_id stays null so
  -- crmSharedScope passes for any grant set. The Default `lead` list view has
  -- no filters, so both fixtures render.
  declare
    v_lead_owner uuid;
    v_lead_new uuid;
    v_lead_working uuid;
  begin
    select id into v_lead_owner from users where org_id = v_org order by created_at limit 1;
    select id into v_lead_new from crm_account_statuses
     where org_id = v_org and lifecycle_stage = 'lead' and is_active order by sequence limit 1;
    select id into v_lead_working from crm_account_statuses
     where org_id = v_org and lifecycle_stage = 'lead' and is_active order by sequence desc limit 1;
    if v_lead_owner is null or v_lead_new is null then
      raise notice 'no users or lead statuses; skipping lead fixtures';
      return;
    end if;

    insert into parties (id, org_id, kind, display_name, email, phone, is_active, created_by, updated_by)
    values
      ('00000000-0000-7000-a000-000000000003', v_org, 'company',
       'ViewSpec Lead Conformance A', 'leads-a@viewspec.test', '555-0101', true, v_lead_owner, v_lead_owner),
      ('00000000-0000-7000-a000-000000000004', v_org, 'company',
       'ViewSpec Lead Conformance B', 'leads-b@viewspec.test', '555-0102', true, v_lead_owner, v_lead_owner)
    on conflict (id) do nothing;

    insert into crm_account_profiles
      (id, org_id, party_id, lifecycle_stage, status_id, owner_user_id,
       qualification_score, last_activity_at, is_active, created_by, updated_by)
    values
      ('00000000-0000-7000-a000-000000000003', v_org,
       '00000000-0000-7000-a000-000000000003', 'lead', v_lead_new, v_lead_owner,
       42, current_timestamp - interval '1 day', true, v_lead_owner, v_lead_owner),
      ('00000000-0000-7000-a000-000000000004', v_org,
       '00000000-0000-7000-a000-000000000004', 'lead', v_lead_working, v_lead_owner,
       70, current_timestamp - interval '2 days', true, v_lead_owner, v_lead_owner)
    on conflict (id) do nothing;
  end;
```

Column notes: `kind` on parties has no default so it is given explicitly
(`'company'`, matching the draft route); `custom`/`qualification` default to
`'{}'`, `created_at`/`updated_at` to `now()`, `is_active` to true, so those
are omitted. Profile id reuses the party id for readability only — they are
independent primary keys in different tables, not a foreign key.

## Proposed conformance entry (coordinator: `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/crm/leads',
  // Thin entity-list wrapper: the header button and one drawer slot. The
  // VS lead fixtures (block …a000-…003/004, seeded above) render in the
  // default list; the second variant opens the first fixture's flyout.
  variants: [
    '',
    // The flyout path. …003 is a sim-org lead visible to the harness user
    // (null subsidiary_id, active party + profile + lead status), and the
    // drawer is portaled to <body>.
    {
      query: '?account=00000000-0000-7000-a000-000000000003',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Verified against the database (read-only):

- `crm_account_profiles` in the SIM org: 0 rows today, so fixtures are
  required (no silent-empty comparison).
- Sim-org `lead` Default list view config has `"filters": []` and visible
  columns `account_name, status, owner_name, qualification_score,
  last_activity, _actions` — both fixtures satisfy the where clause
  (`lifecycle_stage='lead'`, active profile, active party, null
  subsidiary) and render (2 rows >= minMatches 2).
- Lead lifecycle statuses exist (`New`, `Working`, `Qualified`,
  `Disqualified` — all active), and 5 active users exist, so the fixture's
  org-scoped selects resolve.
- The `?account=<id>` variant: `loadParty` resolves the fixture party
  (`subsidiary_id` null passes `subsidiaryVisibleFilter` with
  `orgWideNull`), `loadCrmAccount` resolves the profile (same null
  subsidiary passes `crmSharedScope`), and the drawer pickers are ordinary
  org-scoped selects.
- Fixture ids `…003/…004` verified free across the whole fixtures file and
  the conformance registry (see block analysis above).

## Anything I could not express

Nothing. No new vocabulary needed: `layout: 'list'`, `pageHeader`,
`entity-list-view` with a single-element drawer slot, the existing
`crm-new-button`, and one new `crm-account-drawer` entry that delegates to
the existing CRM `AccountDrawer` component cover the page. No `sections.tsx`
(no composite cells, no local components to move), and none of the three
named pitfalls apply (no native `<section>`, no `tabular-nums` on a `<td>`,
no pager — the entity list owns its own).
