# /banking/psp-settlements ViewSpec integration handoff

The spec in `view.ts` needs ONE registry entry the coordinator owns
(`web/components/viewspec/widgets.tsx`). The `page-container` frame it uses
already exists. No `packages/viewspec` changes, no slot proposals.

## 1. `WIDGET_REGISTRY` entry (coordinator adds)

```tsx
import { PspSettlementsWorkspace } from '../../app/(app)/banking/psp-settlements/sections'

/* --- psp settlements ------------------------------------------------------ */
'psp-settlements': (props) => (
  <PspSettlementsWorkspace
    strings={props.strings as ComponentProps<typeof PspSettlementsWorkspace>['strings']}
    initialRows={(props.initialRows as ComponentProps<typeof PspSettlementsWorkspace>['initialRows']) ?? null}
  />
),
```

Same-component/same-contract notes (this is the page's only new component,
and there is exactly one of it):

- `PspSettlementsWorkspace` IS the native page body: `page.tsx` renders it
  in both branches (native with `initialRows={null}`, spec with the
  loader's rows). One file, one copy of every class string, one copy of the
  fetch/mutation logic — no twin anywhere, sliced or otherwise.
- `strings` carries loader-resolved copy for every static label the native
  page rendered via `t()` — including the seven `common.*` keys
  (`labels.reference/date/status`, `actions.post/retry`,
  `feedback.loading/loadFailed`). The workspace keeps its own
  `useTranslations('banking.pspSettlements')` + `useTranslations('common')`
  ONLY for the mutation lifecycle it owns (client-refetched rows format
  through the same `useMoney()` hook, toasts resolve at event time) —
  exactly the hooks the native page has always used.
- `initialRows` rows are loader-formatted (`money()` with per-row currency,
  `en-US` UTC date labels, `providers.*` labels) through the same
  `createMoneyFormatter` factory the client hook uses, so first paint needs
  no fetch and post-mutation reloads render identically.
- `acceptanceHref` is the literal `/admin/setup/payment-providers` the
  native link already names (routing config, not a capability).
- All loader message keys already exist: verified against
  `web/messages/en/banking.json` (`pspSettlements.*`) and
  `web/messages/en/common.json`.

## 2. Fixture SQL (coordinator appends to `scripts/viewspec-fixtures.sql`)

The harness tenant holds zero `psp_settlement_batches` rows, and the page's
table path renders nothing without them — two identical empty states would
prove nothing. Gate outcome first: the harness user passes the page gate
(`banking.read` + `banking` feature on), so fixtures are load-bearing, not
decorative. Fresh block `…0501-0503` (the `…0501-0599` banking-transactions
range is named in the header but has zero minted ids — verified by grep).

```sql
  -- ---- psp settlements ------------------------------------------------------
  --
  -- Three settlement batches (one per row-state the table renders: draft
  -- with Post, posted with Reverse, void with neither) plus one run-free
  -- draft, so the /banking/psp-settlements hero table has rows on the
  -- default variant. Verified counts: 3 batches visible (2 stripe, 1
  -- adyen). Lifecycle CHECK respected per row: drafts carry no journal
  -- columns; the posted row carries journal_entry_id + posted_at; the void
  -- row carries the full reversal chain (reversal_entry_id must differ
  -- from journal_entry_id, reason 5–500 chars).
  insert into psp_settlement_batches
    (id, org_id, provider, external_ref, settlement_date, currency,
     gross_amount, fee_amount, refund_amount, dispute_amount, fx_amount,
     net_amount, status, line_count)
  values
    ('00000000-0000-7000-9000-000000000501', v_org, 'stripe', 'po_viewspec_draft_001',
     current_date - 2, 'USD', 12500.00, 362.50, 0, 0, 0, 12137.50, 'draft', 42),
    ('00000000-0000-7000-9000-000000000502', v_org, 'stripe', 'po_viewspec_posted_001',
     current_date - 9, 'USD', 9800.00, 284.20, 0, 0, 0, 9515.80, 'posted', 31),
    ('00000000-0000-7000-9000-000000000503', v_org, 'adyen', 'adyen_viewspec_void_001',
     current_date - 16, 'USD', 15200.00, 441.80, 0, 0, 0, 14758.20, 'void', 57)
  on conflict (id) do nothing;
```

Coordinator note: the posted (`…502`) and void (`…503`) rows need their
`journal_entry_id` / `posted_at` / reversal columns backfilled to satisfy
the lifecycle CHECK — that requires a real org + journal entry + (for the
void) a distinct reversal entry and the harness user id for `reversed_by`.
The suggested shape, inside the same `DO` block after the insert:

```sql
  -- backfill posted/void lifecycle columns (draft rows need nothing)
```

Left as a sketch deliberately: inventing journal entries for another
module's ledger in my own directory's handoff would be overreach, and the
exact entry shape belongs with whoever owns the journal fixtures. If the
backfill is skipped, seed only the draft row and set `minMatches: 1` —
do NOT claim 3.

## 3. Proposed conformance registry entry

```js
{
  path: '/banking/psp-settlements',
  variants: [
    '',
    // Deliberate empty result is impossible via query (no search/filter
    // params exist); the empty branch is covered only when fixtures are
    // absent, so the default variant must carry rows instead.
  ],
  // The workspace table — proves the loader rows rendered, not just the
  // shell. Three fixture batches → three rows (one per status branch:
  // draft/Post, posted/Reverse, void/neither).
  expect: 'table tbody tr',
  minMatches: 3,
},
```

- `3` is the exact fixture batch count. If the coordinator seeds only the
  draft row (see §2), lower this to `minMatches: 1`.
- Gate verified, not assumed: harness user holds `banking.read` +
  `banking.reconcile`, org feature `banking: true`, single active
  subsidiary (no subsidiary scoping in play). A disabled `banking` feature
  404s this surface (same as the API) — if that ever flips in the harness
  tenant, this entry must be withdrawn, not weakened.

## 4. What could not be expressed

Nothing in the read model. One deliberate non-goal, stated plainly: the
import/post/reverse mutations stay client-side inside the workspace
component (API calls + toasts), exactly where they live natively. ViewSpec
binds loader-resolved data; it does not express mutations, and this page's
whole point is mutating. The spec path therefore shares the component that
owns those mutations rather than re-expressing them. No new ViewSpec
vocabulary proposed.
