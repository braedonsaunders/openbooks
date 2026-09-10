# Opportunities (`/crm/opportunities`) — ViewSpec integration handoff

Loader + spec: `view.ts` (`loadOpportunities` / `opportunitiesSpec`).
No `sections.tsx` — the page defines no local components and the spec places
no composite cells.

The conversion follows the `/projects` precedent (`web/app/(app)/projects/view.ts`):
the page is a thin entity-list wrapper, so the spec owns only the header
(`pageHeader` + new button) and the `entity-list-view` slot with a
single-element drawer list.

## WIDGET_REGISTRY entries needed (coordinator: `web/components/viewspec/widgets.tsx`)

Imports:

```tsx
import { CrmNewButton } from '../../app/(app)/crm/CrmNewButton'
import { OpportunityDrawer } from '../../app/(app)/crm/OpportunityDrawer'
```

Entries:

```tsx
/* --- crm opportunities ---------------------------------------------------- */
'crm-new-button': (props) => (
  <CrmNewButton
    apiPath={str(props, 'apiPath') ?? ''}
    basePath={str(props, 'basePath') ?? ''}
    param={str(props, 'param') ?? ''}
    label={str(props, 'label') ?? ''}
    failed={str(props, 'failed') ?? ''}
  />
),
'opportunity-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof OpportunityDrawer> | null
  if (!drawer) return null
  return <OpportunityDrawer {...drawer} />
},
```

Notes:

- Unlike `NewProjectButton` / `NewPartyButton` (which hard-code their API
  path), `CrmNewButton` takes `apiPath`/`basePath`/`param` as props — the same
  component serves leads, prospects and opportunities. All five props are
  loader-resolved strings (`t('opportunities.new')`,
  `t('feedback.createFailed')`), so no message-key lookup happens in the
  registry.
- The native drawer carries no `key` (compare `key={...}` on the project and
  party drawers), so `opportunity-drawer` applies none either. Both renders
  reuse the mounted flyout when switching opportunities.
- The drawer slot is a single-element list (native renders at most the
  opportunity flyout; there is no `?opportunity=new` redirect and no
  transaction flyout on this page). The `entity-list-view` slot already accepts
  a list, so no registry change is needed there.

## Proposed conformance entry (coordinator: `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/crm/opportunities',
  // Thin entity-list wrapper: the header button and one drawer slot. The
  // VS-FC fixture opportunities (seeded by the forecasts page) render in the
  // default list; the second variant opens the first fixture's flyout.
  variants: [
    '',
    // The flyout path. VS-FC-1 is a sim-org opportunity visible to the
    // harness user, and the drawer is portaled to <body>.
    {
      query: '?opportunity=00000000-0000-7000-a000-000000000001',
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

- `crm_opportunities` active in the SIM org: 2 (`VS-FC-1`, `VS-FC-2`), both
  with `subsidiary_id`/`party_id` null so `crmOpportunityScope` passes for any
  grant set (including the harness admin).
- Both join an active status (`Proposal`, `Negotiation`), which the entity-list
  inner join requires.
- Sim-org `list_views` has an `opportunity` Default view with no filters and
  7 visible columns, so both fixtures render in the default list (2 rows
  >= minMatches 2).
- The `?opportunity=<id>` variant needs no extra fixture: `loadOpportunity`
  resolves VS-FC-1 (status join + scope both pass), and the drawer pickers are
  ordinary org-scoped selects.
- No fixture SQL needed — the fixtures already live in
  `scripts/viewspec-fixtures.sql` (forecasts section) on main.

## Anything I could not express

Nothing. No new vocabulary needed: `layout: 'list'`, `pageHeader`,
`entity-list-view` with a single-element drawer slot, and two registry widgets
that delegate to the existing `CrmNewButton` / `OpportunityDrawer` components
cover the page. No `sections.tsx` (no composite cells, no local components to
move), and none of the three named pitfalls apply (no native `<section>`, no
`tabular-nums` on a `<td>`, no pager — the entity list owns its own).
