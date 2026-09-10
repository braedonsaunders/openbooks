# /admin/setup/bank-feeds ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/bank-feeds/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the page defines local components (`BankAvatar`,
`StatusDot`, `SftpConnectionCard`, `SftpEndpointCard`,
`AddConnectionFlow`, `ConfigureConnection`, `FallbackTile`), but every one
of them renders INSIDE the `BankFeedsClient` island — none is referenced by
the spec — so nothing needed moving. `page.tsx` still imports
`BankFeedsClient` directly for the native branch; the spec path reuses it
whole through the widget below. Nothing is copied.

Spec shape: `bare` layout (the setup workspace renders its own shell —
same reason as the `[entity]` / labor-costing / payment-operations
conversions), one `mx-auto w-full max-w-4xl space-y-6 p-1` grid (the
native outer div, transcribed class-for-class) holding a single
`bank-feeds-workspace` widget. One new widget, proposed below.

Why whole-island (not decomposed): `BankFeedsClient` owns `useState`
(adding/msg/busy, per-SFTP-card routing/account/folder, the configure
wizard's provider/creds/sftpSecret), fires `fetch` POST/PATCH/DELETE
mutations against `/api/banking/bank-feeds/*` and `/api/banking/sftp/*`,
and filters `BANK_DIRECTORY` client-side. Decomposing its connection list
into a spec repeat would render the unfiltered set and strand the search
input from what it filters (the labor-costing lesson). The LOADER makes
every data decision the native page made server-side (gates, six-way
fetch, host fallback, account labels); the widget only renders.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed:

```tsx
import { BankFeedsClient } from '../../app/(app)/admin/setup/bank-feeds/BankFeedsClient'
```

Check the import block first — the banking imports (`AccountsRosterPanel`
etc.) are already there; only add this line. No name clash: no `bank-feeds`
or `BankFeeds` hit exists in the registry today (verified by grep).

```tsx
/**
 * Bank-feeds setup workspace: the whole BankFeedsClient island — connection
 * list, SFTP cards, shared endpoint card, add-connection flow. NOT
 * decomposable: everything below the setup shell owns useState (adding /
 * msg / busy, per-card routing drafts, the configure wizard) and fires
 * fetch mutations, and the bank directory is filtered client-side. The
 * LOADER makes every server-side data decision (gates, six-way fetch,
 * host fallback, account labels); the widget only renders.
 *
 * EXACT prop shape: FIVE FLAT props — `connections`, `sftpServers`,
 * `sftpSchedules`, `accounts`, `daemon` — spread directly, exactly as the
 * native page passes them. There is no nested `workspace` bag; do not
 * wrap them in one. (Same flat-spread division as the
 * `property-management-workspace` precedent.)
 */
'bank-feeds-workspace': (props) => (
  <BankFeedsClient {...(props as unknown as ComponentProps<typeof BankFeedsClient>)} />
),
```

## 2. Slot proposals (none)

No slot is needed. Authz, org id, feature state, daemon config and request
headers are consumed server-side by the loader; only plain data (row
arrays, option lists, the daemon record) crosses the spec. The island
persists mutations through `fetch` + the session cookie inside the shared
component. (Same division as labor-costing §2.)

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/setup/bank-feeds',
  // Whole-island setup page: the loader resolves the manage gate, the
  // bankFeeds feature gate and the six-way fetch; BankFeedsClient renders
  // the connection list, SFTP cards and the add-connection flow.
  // One AIS+ fixture connection (§4) so the list has a row on both paths;
  // the SFTP sections stay empty (no fixture server), which is the guarded
  // branch, not a gap.
  variants: [
    '',
  ],
  expect: 'main section h2',
  minMatches: 1,
},
```

GATES check (per the /query lesson): TWO server gates, both in the LOADER
before any query — `requirePermission('admin.setup.manage')` (throws, not
a render branch) and the `bankFeeds` feature redirect to
`/admin/setup/features`. `bankFeeds` is `defaultEnabled: false`
(`engine/src/feature-registry.ts:109`) and the SIM org's
`settings->'features'` blob has no `bankFeeds` key (verified), so **both
branches redirect identically in the harness tenant today**. Do NOT
register this entry until §4 is applied: the `'bankFeeds': true` merge
makes the gate pass on both paths, and only then does the comparison mean
anything (the property-management precedent — comparing two redirects is
a false pass).

Permission side, verified: the harness user `viewspec@sim.test`
(`01a08426-0962-74c7-a086-e1609c589dcb`) is `is_super_admin` in the SIM
org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, so the manage gate passes.

Variant-coverage check: the page reads NO search params (no `?view=`,
`?q=`, drawer or tab params — the `__viewspec` flag is the only query
key, consumed by `page.tsx`, never by the loader). Add/Configure/SFTP
routing are `useState` with no URL affordance. There is exactly ONE page
state per dataset (empty vs rows), so one variant is full coverage — a
second variant would render byte-identical markup, which
assertVariantsDiffer rejects (the /query precedent).

Row-count verification (read-only queries, `app.bypass_rls='on'`):
`bank_feed_connections` / `sftp_servers` / `sftp_import_schedules` hold
**0 rows** in the SIM org today; the §4 fixture adds **1 active
`gocardless` connection**, so the default variant renders 1 connection
card + the endpoint-less list (no SFTP server ⇒ no endpoint card) — pinned
by `minMatches: 1` against the page `h2`. The reconcilable-accounts picker
is non-empty (1 row: `1010 Operating Account`), so the add flow's account
select renders.

No logged-out variant is proposed (the harness is always authenticated;
the login redirect is framework behavior, not page content — the
labor-costing precedent).

## 4. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims fresh block **…1201–1299** (verified unused: zero
`00000000-0000-7000-9000-0000000012*` ids in the file today, and no pending
`…12xx` claim in any shipped INTEGRATION.md — the `…08xx` range is
triple-claimed by pending budgets/documents proposals and is avoided on
purpose). Please also add `…1201-1299  bank feeds (connection)` to the
allocation table at the top of the file.

Two parts: (a) a `'bankFeeds': true` merge in the existing "feature
switches" block idiom (fixtures.sql:147-162, the `jsonb_build_object`
list) — WITHOUT it the page redirects on both paths (§3); (b) the block
below, in the same `do $$` style as the rest of the file (it uses the
ambient `v_org`).

CHECK-safe by construction (verified against the live schema):
`provider` ∈ manual/sftp/plaid/gocardless/truelayer,
`sync_cadence` ∈ manual/hourly/daily, `status` ∈
pending/connected/error/disconnected — the fixture uses `gocardless` /
`daily` / `connected`.

Guard note: plain `ON CONFLICT (id) DO NOTHING` is idempotent here. The
three tables carry no trigger and no EXCLUDE constraint (verified:
`information_schema.triggers` empty for all three; constraints are
pkey + plain CHECKs only), and the only UNIQUE besides pkey is
`sftp_servers(username)` / `(org_id, username)` — untouched, since no SFTP
server is seeded. No second-run RAISE path exists (unlike the
property-management lease-charge precedent). The connection's
`account_id` resolves to the SIM org's reconcilable account at apply time
(`1010 Operating Account`, verified present) — no hardcoded account id.

```sql
  -- ---- bank feeds -----------------------------------------------------------
  --
  -- The simulator never connects a bank feed, so /admin/setup/bank-feeds
  -- renders its empty state on both paths. One live-cadence GoCardless
  -- connection on the SIM org's reconcilable operating account, so the
  -- connection list has a row. No SFTP server is seeded: the SFTP cards
  -- and the shared endpoint card stay in their guarded-empty branch.
  -- Claims fresh block …1201-1299 (verified unused).
  insert into bank_feed_connections
    (id, org_id, name, provider, account_id, status, sync_cadence,
     last_sync_at, is_active)
  values
    ('00000000-0000-7000-9000-000000001201', v_org,
     'ViewSpec operating feed', 'gocardless',
     (select id from accounts
       where org_id = v_org and reconcilable and not is_summary and is_active
       order by number nulls last limit 1),
     'connected', 'daily', now() - interval '1 day', true)
  on conflict (id) do nothing;
```

## 5. What the spec does NOT cover (nothing — full coverage)

- The `admin.setup.manage` gate, the `bankFeeds` feature redirect, the
  six-way fetch, the advertised-host fallback chain and the account-label
  join are all loader work copied verbatim from `page.tsx`.
- `lastSyncAt` / `lastAttemptAt` / `lastConnectedAt` / `lastRunAt` travel
  RAW (ISO strings): the island formats them client-side with
  `new Date(…).toLocaleDateString("en-CA")`, so the loader must NOT
  format them server-side (the payment-operations `nextRunAt` precedent).
- Message keys: the loader emits no copy of its own — every string the
  spec path renders resolves inside the shared `BankFeedsClient` via its
  existing `useTranslations("banking.bankFeeds.client…")` hooks. None
  invented. The `generateMetadata` title (`banking:bankFeeds.title`) is
  untouched on both paths.
- `page.tsx` native branch is untouched below the `__viewspec` branch;
  `BankFeedsClient.tsx` is unmodified. `Card` renders a `div` (not a
  native `<section>`), so no `as: 'section'` trap applies; no table, no
  pager, no `$root`.
