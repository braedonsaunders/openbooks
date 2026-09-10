# /banking/transactions ViewSpec integration handoff

Page: `/banking/transactions` — checks, deposits, card charges/refunds and
transfers over the universal `RecordListView`, with the `DocumentDrawer`
flyout (`?doc=`) and the New-document menu. Closest worked example is the
AR-invoices conversion (`ar/invoices/view.ts`): same shape (record-list slot
+ document drawer + per-row actions threaded through widget refs), same
reason the list stays a slot.

Files created (all inside `web/app/(app)/banking/transactions/`, the only dir
this page owns):

- `view.ts` — `loadBankingTransactions(sp)` + `bankingTransactionsSpec(data)`.
  The loader copies the native page's `banking.read` gate, the
  `ap.create`/`gl.post` New-menu permission, the ?doc= flyout resolution (org
  guard, subsidiary guard, BANK-kind guard), the drawer pickers (accounts,
  cards, bank accounts, items, subsidiaries) and the form-layout resolution
  VERBATIM.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged. No `sections.tsx`: the page defines no local components
  and needs no composite cells, so there is nothing to share.

## WIDGET_REGISTRY entries needed: NONE

Every widget the spec names already exists:

- `'record-list-view'` — takes `{ recordType: 'bank_transaction', ... }`.
  The slot resolves the `bank_transaction` list source (kinds card_charge /
  card_refund / check / deposit / transfer, `drawerParam: 'doc'`) exactly as
  the native `RecordListView recordType="bank_transaction"` does — same
  component, same source, same contract.
- `'document-drawer'` — takes `{ drawer }` with the remount key, the full
  picker set (accounts, cards, bankAccounts, subsidiaries, header/line defs),
  `canCreate`/`canPost`/`canCustomize`, and the resolved form layout. The
  banking drawer has no payment-links panel, so that prop stays null — the
  entry already handles the null case.
- `'document-row-actions'` — per-row `{ widget, props: { basePath } }`; the
  slot builds the callback from the row's own `id`/`status`/`kind`.
- `'new-document'` — `{ items, basePath, triggerLabel, creatingLabel,
  failedLabel }`, gated on `canCreate` exactly as the native
  `NewDocumentButton` is.

## Reuse diffs performed (per the harness lesson — same name is not enough)

1. **`document-row-actions` vs the native `renderRowActions`.** Native:
   `config={DOC_KINDS[row.kind]!}` plus
   `openHref={buildListDrawerHref(basePath, sp, 'doc', id)}`. Registry entry:
   `config={DOC_KINDS[String(props.kind)]!}` (identical lookup — a kind the
   native page accepts can never resolve differently here) and
   `openHref={`${basePath}?doc=${id}`}` (SIMPLER than the native href: no
   `drawerReturn`, no preserved params). The slot, not the widget, owns row
   navigation — `RecordListView` itself builds `openHref` via
   `buildListDrawerHref(basePath, sp, source.drawerParam /* 'doc' */, id)`
   (`web/components/record-list-view.tsx:226-227`), which is the full
   return-preserving form the native rows use when clicked through the list.
   The widget-level `openHref` only fires for rows rendered OUTSIDE the slot,
   which this page never does: every row on both paths renders inside
   `RecordListView`. Byte-compare risk: none — the differing string is dead
   on this page. (The ar/invoices and expenses/reports conversions accepted
   the same entry on the same reasoning.)
2. **`document-drawer` remount key.** Native passes `key={String(openDoc.doc.id)}`
   on `<DocumentDrawer>`; the loader ships `remountKey: String(openDoc.doc.id)`
   and the registry entry applies it as the React key — verified line by
   line, same value, same position.
3. **`new-document` labels.** All four strings (`txKinds.*` × 5,
   `actions.new`, `actions.creating`, `toasts.createDraftFailed`) resolve in
   the loader from the same `banking`/`common` keys the native page uses.

## What the coordinator must NOT create

No new slot is needed. Org id, user id, `canManage`, subsidiary scope and the
permission decisions stay inside `RecordListSlot` (server code, re-derived
from the session). The loader never ships them.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/banking/transactions',
  // Record list over the five bank kinds, plus the document-drawer flyout
  // over a draft check.
  variants: [
    '',
    // The document flyout, portaled to <body>.
    {
      query: '?doc=00000000-0000-7000-9000-000000000501',
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

- GATES FIRST. `requirePermission('banking.read')`: the admin role's
  permission JSON **includes `banking.read`** (same row verified for the
  audit conversion). No feature flag gates this page (`DOC_KIND_FEATURE`
  covers orders/expenses/fieldTickets/payroll/projects only — none of the
  five bank kinds). No subsidiary redirect exists on this route. The page
  renders 200 for the harness tenant.
- Bank-kind documents in the org: **5, one per kind** (check CHK-9001, deposit
  DEP-9001, transfer TRF-9001, card_charge CC-9001, card_refund CRF-9001),
  all status `draft`, all sim-seeded fixture ids in the `…0501-0599` banking
  block (predate this task — no new fixture SQL, **no id block claimed**).
  Default list page size covers all 5 — `minMatches: 5` is exact, not
  conservative.
- Drawer id `00000000-0000-7000-9000-000000000501` is CHK-9001, kind `check`
  ∈ BANK_KINDS, status `draft`, org matches → `drawerOpen` true on both
  paths. It is a DRAFT, so the drawer exercises the edit-capable branch
  (`?doc=<id>&mode=edit` additionally flips `initialMode`; not proposed as
  a variant — same drawer, one flag).
- `canCreate` for the harness admin: `ap.create` ∈ the admin permission set
  → the New menu renders on the default variant (the `emptyAction` and the
  header action share the flag, so both agree).

## Could not express

Nothing. The whole body is the shared `RecordListView` placed through its
slot — not a client component owning filter state (all search/filter/sort
state lives in the URL and is owned by the slot), so the /analytics
whole-component carve-out does not apply.
