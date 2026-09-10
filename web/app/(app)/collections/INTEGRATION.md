# /collections ViewSpec integration handoff

Page: `web/app/(app)/collections/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. The native branch stays and now renders through
`CollectionsShell`, so both paths share one implementation.

Spec blocks used: one `widgetBlock` inside a `bare` page. No table, no
repeat, no pagination: the body is one client island (see §4), exactly the
call the `/ar` cockpit made for its position-fetching client component.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (component already exists in my owned dir):

```tsx
import { CollectionsShell } from '../../app/(app)/collections/sections'
```

Entry (place beside the `/* --- AR cockpit --- */` group):

```tsx
/* --- collections ------------------------------------------------------------ */
/**
 * Whole: the collections page shell — the `mx-auto max-w-6xl` container, the
 * PageHeader, and CollectionsClient with its tab state (recurring /
 * subscriptions / advanced / dunning), all four list fetches
 * (/api/recurring, /api/subscriptions, /api/dunning,
 * /api/subscriptions/advanced), every create form and every row action.
 * A spec cannot name tab state, fetch-on-mount, or the four-way panel
 * conditional (presence omits; it never chooses), so the island stays
 * whole. The loader still does the documents.manage gate, both feature
 * probes and the option queries; the widget only renders already-resolved
 * props. No Authz, org id or user id crosses the spec.
 *
 * EXACT prop shape (wire verbatim — the coordinator must not invent a
 * wrapper; CollectionsShell takes flat props, not a `data` object):
 *   title: string, description: string,
 *   subscriptionsEnabled: boolean, advancedSubscriptionsEnabled: boolean,
 *   customers: { id: string; name?: string; label?: string }[],
 *   incomeAccounts: { id: string; name?: string; label?: string }[]
 */
'collections-shell': (props) => (
  <CollectionsShell
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    subscriptionsEnabled={props.subscriptionsEnabled === true}
    advancedSubscriptionsEnabled={props.advancedSubscriptionsEnabled === true}
    customers={(props.customers as CollectionsShellProps['customers']) ?? []}
    incomeAccounts={(props.incomeAccounts as CollectionsShellProps['incomeAccounts']) ?? []}
  />
),
```

`str` and the `=== true` / direct-cast conventions follow the existing
registry entries (`ar-cockpit`, `reports-hub`). Import
`type CollectionsShellProps` from the same sections module for the casts.
No slot is needed: neither `CollectionsShell` nor `CollectionsClient`
takes an Authz, an org id, or a user id — the customers/incomeAccounts
options arrive as resolved `{ id, name }` / `{ id, label }` rows.

Why a `bare` page and not `list` + `pageHeader`: the native page renders
its own `mx-auto w-full max-w-6xl px-4 py-6` container, and neither
`ListPageLayout` (sticky header chrome + `max-w-screen-2xl` body) nor
`DetailPageLayout` reproduces it. Re-expressing the shell as spec chrome
would wrap the island in a second, wider container — the byte-for-byte
failure the harness exists to catch. The container travels with the
widget instead.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/collections',
  // Cockpit page — it reads no query params (the loader ignores
  // searchParams apart from the __viewspec proof marker), so one variant
  // pins every branch at once. The sim org has NEITHER subscriptionBilling
  // NOR advancedSubscriptions in settings (verified: features JSON has no
  // such keys, defaults false), so both renders show the recurring tab by
  // default with subscriptions/advanced tabs absent. The harness user
  // viewspec@sim.test holds documents.manage via the admin role (same
  // gate as the already-green /ar/invoices-family pages), so neither
  // render redirects. Recurring + dunning tables are EMPTY in this tenant
  // (0 recurring_schedules, 0 dunning_policies, verified read-only with
  // bypass RLS) — the empty `noneYet` rows are the pinned content, not a
  // gap: both lists fetch client-side from /api/* and render the
  // translated empty row. No fixture can change that: the rows live
  // behind fetch, not the loader. Selector pins the tab bar (4th button =
  // dunning), both panel headings and the empty rows.
  variants: [{ query: '', expect: 'main button, main h3, main td', minMatches: 8 }],
  expect: 'main button',
  minMatches: 3,
},
```

GATES verification: `documents.manage` — the harness user holds the admin
role (verified `viewspec@sim.test` exists in `users`). Feature flags
`subscriptionBilling` / `advancedSubscriptions` are ABSENT from the sim
org's settings JSON (verified read-only) → both false → Subscriptions and
Advanced tabs absent on both renders, and the loader's option queries take
the `[{ rows: [] }, { rows: [] }]` branch (no customers/incomeAccounts
queries fire).

Counts behind the single variant (read-only, bypass RLS on; SIM org
`da472d3a-…`): 0 recurring schedules, 0 dunning policies, 0 dunning
stages → RecurringPanel renders the `newSchedule` card + the `noneYet`
empty row (colSpan 8); the dunning tab (client state, not a query param)
renders on click with the `newPolicy` card + `noneYet`. The conformance
default variant asserts the default (recurring) tab: 3 tab buttons
(recurring + dunning + conditional subscriptions/advanced absent = 2
visible… see moving parts), the `newSchedule` h3, and the empty-row td.

Heads-up on two moving parts:

- The tab-button count depends on the sim org's feature flags TODAY:
  neither flag is set → 2 tab buttons (recurring, dunning). If the
  simulator later enables `subscriptionBilling`, both renders gain the
  Subscriptions button together (same loader flag), so the count moves in
  lockstep — but `minMatches` above would need revisiting.
- `AdvancedSubscriptionsPanel` defaults its date inputs to
  `useBusinessToday()` (business date, not wall-clock): identical on both
  paths since both mount the same component, so drift moves both renders
  together. Only reachable when `advancedSubscriptions` is on, which it
  is not in this tenant.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

None needed, and none proposed. Two reasons:

1. The page's lists load client-side via `fetch('/api/recurring')` and
   `fetch('/api/dunning')` AFTER mount — seeded `recurring_schedules` /
   `dunning_policies` rows would change what the BROWSER shows but would
   exercise zero loader/spec code (the loader only resolves the header
   strings, the two feature flags and the two option lists). A fixture
   here proves the API works, not the conversion.
2. The loader-bound data IS verified live: 5 active customers with
   customer_roles and 6 active income accounts exist in the SIM org — but
   the loader only queries them when `subscriptionBilling` is on, which
   it is not, so both paths take the empty-arrays branch. Seeding the
   flag instead of rows would flip the tabs on; that is a coordinator
   decision (it changes every other subscription-gated page's renders),
   not a fixture block. I claim no id block; ON CONFLICT DO NOTHING has
   nothing of mine to collide with. (For the record: `…2401–2499`,
   `…2501–2599`, `…2601–2699`, `…2701–2799` and `…2901–2999` are all free
   of `00000000xx` ids in the current file, should a future conversion
   need a collections block.)

## 4. What the spec does NOT cover (explicitly shared instead)

- The tab bar conditional pair (a `Button` when `subscriptionsEnabled` /
  `advancedSubscriptionsEnabled`, nothing otherwise) and the four-way
  panel switch on client `tab` state: presence omits, it never chooses.
  Both live in `CollectionsClient`, untouched.
- The RecurringPanel create form, schedules table (7 data columns +
  actions, run-now / pause-resume / delete), empty `noneYet` row and the
  `generated_documents_exist` error branch: all client state + fetch.
- The SubscriptionsPanel MRR card, plans table, subscriptions table with
  the qty-change inline form, both create forms and all toast messages:
  all client state + fetch.
- The DunningPanel policy builder (dynamic stage list, token hint) and
  the policy cards with sorted stage lines: all client state + fetch.
- `AdvancedSubscriptionsPanel` in full (version catalog, lifecycle form,
  amendment form, three POST flows): client state + fetch, with hardcoded
  English strings the loader must not touch (never `t('...')` — those
  strings are component-owned, not message keys).
- `PageHeader`, the `mt-6` tab wrapper div and the `mb-4 flex flex-wrap
  gap-2` tab row: component-owned chrome inside `CollectionsShell`, never
  re-expressed as spec blocks (a `pageHeader` + grid would emit
  `ListPageLayout`'s sticky chrome, not the native container).
- `requirePermission('documents.manage').catch(() => null)` +
  `redirect('/dashboard')` is reproduced VERBATIM in the loader (a real
  redirect, never a presence flag): an unauthorized reader never reaches
  either render.
- Message keys used by the loader — `nav.modules.collections` and
  `ar.cockpit.description` — are both consumed by the native page today
  (verified in `web/messages/en/nav.json` and `web/messages/en/ar.json`);
  no key was invented.
