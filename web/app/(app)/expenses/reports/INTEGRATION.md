# /expenses/reports ViewSpec integration handoff

The spec in `view.ts` needs TWO registry entries the coordinator owns
(`web/components/viewspec/widgets.tsx`). The list itself reuses the shared
`record-list-view` slot that the bills conversion landed — no new slot, no new
vocabulary.

## 1. `WIDGET_REGISTRY` entries (coordinator adds)

```tsx
/* --- expenses reports ----------------------------------------------------- */
'new-expense': (props) => (
  <NewExpenseButton
    label={str(props, 'label') ?? ''}
    creatingLabel={str(props, 'creatingLabel') ?? ''}
  />
),
```

Byte-equivalence notes (checked against `NewExpenseButton.tsx`):

- NOT `new-document`: that widget creates a draft document inline for a
  bill/credit kind. The expense button POSTs to `/api/expenses/draft` and
  pushes `/expenses/reports?expense=${id}&mode=edit` — a different component
  with a different contract, so it gets its own entry.
- Labels are loader-resolved (`t('actions.newReport')`,
  `tCommon('actions.creating')`); both keys are already used by the native
  page. The spec places this widget twice (header actions gated on
  `canSubmit`, empty-state action) — the same `button` element the native page
  passes as both `actions` and `emptyAction`.
- The `NewExpenseButton` component takes no props today; it reads its labels
  from `useTranslations` internally. Two ways to wire it: (a) extend the
  component with optional `label`/`creatingLabel` props defaulting to the
  current translated strings (native render unchanged, spec render passes the
  loader-resolved strings), or (b) render it prop-less here (`() =>
  <NewExpenseButton />`) and ignore the two props. (a) is exact under
  message-override scenarios; (b) is byte-identical today. Coordinator's call
  — the loader already resolves both strings either way.
- Needs import: `NewExpenseButton` from
  `../../app/(app)/expenses/NewExpenseButton`.

```tsx
'expense-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof ExpenseDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <ExpenseDrawer key={remountKey} {...rest} />
},
```

- The remount key rides as a prop (`key={report.doc.id}` equivalent — the
  native page does not pass an explicit key, but the drawer is mounted fresh
  per navigation; through the fixed-position slot the key is what resets
  client state when switching reports), the same arrangement as
  `party-drawer` / `document-drawer`.
- `report` is the `ExpensePayload` (`{ doc, lines }` plain rows from
  `loadExpenseReport`); pickers are `Opt[]`/row arrays; `layout` is the plain
  JSON layout config — all client-safe data, same argument the bills
  `ap-bill-drawer` entry makes.
- `initialMode` is loader-resolved (`pickString(sp.mode) === 'edit'`).
- `closeHref: '/expenses/reports'` is a literal matching the native prop —
  routing config the page already names, not a capability.
- Needs import: `ExpenseDrawer` from
  `../../app/(app)/expenses/ExpenseDrawer`.

## 2. Proposed conformance registry entry

Verified against `openbooks_sim_viewspec` (bypass RLS). The harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` holds **30 `expense_report`**
documents, all `posted`, across 12 employees (subsidiary scoping not in play:
the where-builder applies `allowedSubsidiaryIds` but every fixture row has
`subsidiary_id` null).

```js
{
  path: '/expenses/reports',
  // The universal RECORD list for expense_report plus the expense flyout.
  // No per-row actions: ExpenseActions (submit/post against
  // /api/expenses/actions) has no slot coverage yet, so the _actions column
  // renders the slot's default eye-link cell — see §3.
  variants: [
    '',
    // Employee quick-filter branch (Ade Balogun has 2 reports).
    '?employee=e1951303-c5ae-4cf6-a407-2b450c6b3720',
    // Status filter branch (posted is the only status in fixtures).
    '?status=posted',
    // Deliberate empty result: asserts the empty branch (generic
    // common.empty.* copy + the New button as emptyAction), not row content.
    '?q=zzzznomatch',
    // The flyout is portaled to <body>: without naming that root the
    // comparison never looks at the drawer at all. Report is a posted
    // expense_report in the harness org.
    {
      query: '?expense=01a083e7-14fe-7b87-9dfb-11a4e1796449',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 3,
},
```

- Default `perPage` is 25 (saved-view default), so `table tbody tr` matches 25
  rows on the default variant; `minMatches: 3` stays robust to fixture drift.
- The `?q=zzzznomatch` variant returns 0 rows (verified: the document_number /
  reference_number ilike matches nothing), so RecordListView renders its
  `total === 0` EmptyState branch with the New button.
- No fixture rows needed: 30 rows already exist in the harness org.

## 3. What could not be expressed

1. **`ExpenseActions` row actions.** The native `_actions` cell renders
   `ExpenseActions` (submit-for-approval from draft gated on
   `expenses.create`, post from approved gated on `ap.post`, else an eye
   link whose href preserves active filters via `buildListDrawerHref`). The
   shared slot's `renderRowActions` prop is a function, which a spec can
   never carry, so the spec passes nothing and the slot renders its default
   eye-link cell (`openHref(row.id)` = `/expenses/reports?expense=${id}`,
   no filter preservation). The harness WILL flag the `_actions` column
   wherever `ExpenseActions` renders anything but the plain eye link
   (draft/approved rows) and wherever filters are active (href loses
   `drawerReturn`). In the current fixtures all 30 rows are `posted`, so
   every row renders the eye link on both paths — the only byte difference
   is the missing `drawerReturn` query param: `buildListDrawerHref` with no
   extra params returns `/expenses/reports?expense=${id}` PLUS
   `drawerReturn=/expenses/reports`. That is a real, known mismatch on every
   row's eye link; options: (a) extend the slot with a closed row-actions
   variant that builds `ExpenseActions` per row (needs `canSubmit`/`canPost`
   — capabilities the slot would re-derive server-side, the
   entity-list-slot pattern), or (b) leave the list native. (a) is ~15 lines
   in `record-list-slot.tsx` + a 10-line `expense-row-actions` registry
   entry; the loader already resolves both flags.
2. **No new vocabulary needed.** Header actions (`pageHeader` + the default
   actions wrapper), the shared `record-list-view` slot, and the remount-key
   drawer all already exist as patterns. No `packages/viewspec` changes
   proposed. No `sections.tsx`: every cell the list renders is typed inside
   `RecordListView` from the customization registry.
