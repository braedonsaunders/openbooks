# /ap ViewSpec integration handoff

The spec in `view.ts` needs ONE registry entry the coordinator owns
(`web/components/viewspec/widgets.tsx`). The `ap-capture-link`,
`new-document`, and `module-home-tabs` widgets already exist. No new
`packages/viewspec` vocabulary. No `sections.tsx`: the cockpit body is a
single client component shared by both render paths through the widget, so
there is nothing to extract and no second copy to keep in sync.

## 1. `WIDGET_REGISTRY` entry (coordinator adds)

```tsx
/* --- AP cockpit ------------------------------------------------------------- */
/** Whole: vitals tiles, the pay-run planner, aging bars, the cash-out
 *  schedule, the by-vendor table, and three on-demand flyouts (week drill,
 *  vendor drawer, selection-rule config) are client behaviour a spec cannot
 *  name. The /ar cockpit converts the same way (`ar-cockpit`). */
'ap-cockpit': (props) => (
  <ApCockpit
    data={props.data as ComponentProps<typeof ApCockpit>['data']}
    canConfigure={props.canConfigure === true}
    canPay={props.canPay === true}
  />
),
```

- Needs import: `import { ApCockpit } from '../../app/(app)/ap/cockpit/ApCockpit'`
  (same relative depth as the existing `ArCockpit` import).
- Props are loader-resolved capabilities: `canConfigure` re-derives
  `can(authz, 'admin.setup.manage')` (the config gear) and `canPay` re-derives
  `can(authz, 'ap.pay')` (the week-drill pay-run handoff). `data` is the
  projected `ApPosition` with per-week entries stripped (labels + amounts
  only; the drill fetches from `/api/cash/week-entries`), verbatim from
  `page.tsx`.
- Byte-equivalence notes (checked against `page.tsx` lines 44–80):
  - The capture link + new button sit beside the module tabs inside
    `<div className="flex items-center gap-3">`. That wrapper is NOT a widget —
    it arrives via the header block's `actionsClassName`, the same mechanism
    the `/ar` conversion uses. (The native AP page nests
    `flex items-center gap-2` inside `flex items-center gap-3`; the PageHeader
    component itself wraps all actions in its own
    `flex shrink-0 flex-wrap items-center justify-end gap-2` container, so the
    two renders share chrome through `blocks.tsx`, exactly as the `/ar`
    conversion accepted.)
  - `triggerLabel` is `t('actions.newBill')` (not `t('actions.new')` as on
    `/ar`) and the credit fallback is
    `t('actions.newCredit') ?? t('actions.newBill')` — copied verbatim. All
    five message keys are already used by the native page.

## 2. Proposed conformance registry entry

Verified against `openbooks_sim_viewspec` (bypass RLS). The harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` holds **238 `vendor_bill`**
documents (all `posted`, no `vendor_credit`) — nonzero open payables, so the
cockpit renders vitals, the planner, aging, schedule, and vendor rows rather
than the `noPayables` empty state. No fixture block needed: this page needs
no seeded rows and claims no fixture ids.

```js
{
  path: '/ap',
  // The cockpit body is one client component; the header is a capture link
  // plus a create menu beside the module tabs in one flex wrapper.
  variants: [{ query: '', expect: 'main h1, main h3', minMatches: 2 }],
  expect: 'main h1, main h3',
  minMatches: 2,
},
```

- `main h1` is the PageHeader title ("Accounts Payable"); `main h3` matches
  the four `CockpitPanel` headings (Pay run, Aging, Schedule, By vendor).
  `minMatches: 2` stays robust if panels are reordered or renamed.
- No query variants: the loader takes no search params (the `__viewspec`
  flag is consumed by the branch, not the loader). There is no empty branch
  to exercise and no drawer param on this route.

## 3. What could not be expressed

1. **`ApCockpit` stays whole.** Vitals tiles, the capacity meter, the
   planner's selection state, aging/schedule bars, the vendor table, and the
   three flyouts are client state and conditional pairs — decomposing them
   would reimplement the cockpit, not compose it. Same division as the `/ar`
   conversion.
2. **No new vocabulary needed.** Header composition (`pageHeader` +
   `actionsClassName`), presence-gated widgets (`when: canCreate`), and the
   projected-data widget block all already exist as patterns. No
   `packages/viewspec` changes proposed.
