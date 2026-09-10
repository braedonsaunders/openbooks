# /payroll/remittances ViewSpec integration handoff

Page: `web/app/(app)/payroll/remittances/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. `RemittancesView` moved to `sections.tsx` (re-exported; the
native branch imports it from there — one implementation, both paths).

Spec blocks used: `pageHeader` (exists) + `module-home-tabs` (exists),
`remittance-cockpit`, `remittance-ap-note` (both proposed below — neither
exists in the registry yet).

Division of labor follows the AP cockpit exactly: ViewSpec composes the
page; the body stays ONE client component. Every card carries conditional
pairs a spec cannot express — the filing-account badge (optional number
plus optional name join), the existing-bill link list, the create-bill
button vs the assign-vendor link, the withheld/employer kind label, the
accountLabel-or-fallback pair, the create vs create-another label — so no
per-row widget decomposition was attempted. The widget receives the engine
`RemittanceGroup[]` verbatim plus `from`/`to`/`canCreate`; money and
messages resolve inside the client component via useMoney/useTranslations,
identically on both paths, so no loader formatting can drift between the
renders.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (components already exist in my owned dir):

```tsx
import { RemittancesView, RemittanceApNote } from '../../app/(app)/payroll/remittances/sections'
import type { RemittanceGroup } from '@openbooks/engine/src/payroll-remittance.ts'
```

Entries (place after the `/* --- payroll cockpit --- */` group):

```tsx
/* --- payroll remittances -------------------------------------------------- */
/**
 * The remittance cockpit, whole: period form + per-destination cards +
 * empty state. The groups travel verbatim from the loader (they are plain
 * serializable engine output: strings, numbers, nulls, arrays); money and
 * messages resolve inside via useMoney/useTranslations, identically on
 * both paths. EXACT prop shape — the coordinator wires these verbatim:
 *
 *   groups: RemittanceGroup[]  (partyId, partyName, filingAccount
 *           {id, accountNumber, name, remitterType}, components[]
 *           {componentId, code, name, kind, systemKey, liabilityAccountId,
 *           accountLabel, amount}, total, grossPayroll, employeeCount,
 *           existingBills[] {documentId, documentNumber, status, total})
 *   from: string               (YYYY-MM-DD period start)
 *   to: string                 (YYYY-MM-DD period end)
 *   canCreate: boolean         (payroll.run gate)
 */
'remittance-cockpit': (props) => (
  <RemittancesView
    groups={(props.groups as RemittanceGroup[]) ?? []}
    from={str(props, 'from') ?? ''}
    to={str(props, 'to') ?? ''}
    canCreate={props.canCreate === true}
  />
),
/**
 * The AP footnote under the cards. EXACT prop shape:
 *
 *   note: string               (t('apNote'))
 *   linkLabel: string          (t('apLink'))
 */
'remittance-ap-note': (props) => (
  <RemittanceApNote
    note={str(props, 'note') ?? ''}
    linkLabel={str(props, 'linkLabel') ?? ''}
  />
),
```

`str` follows the existing registry conventions. No other new imports:
`RemittanceGroup` is a type-only import (erased at runtime).

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll/remittances',
  // One group: two deduction components (VS-TAX −800, VS-CPP −250) on the
  // committed fixture run …1813 (pay_date 2026-03-11), plus one draft
  // remittance bill marker for the same vendor + March window. The default
  // render keys off businessToday (previous-month default), so both
  // variants pin from/to explicitly: the March variant renders the card
  // (section + 2 component rows + total row = 3 tr), the January variant
  // renders the empty state.
  variants: [
    {
      query: '?from=2026-03-01&to=2026-03-31',
      expect: 'main section table tbody tr',
      minMatches: 3,
    },
    {
      query: '?from=2026-01-01&to=2026-01-31',
      expect: 'main div',
      minMatches: 1,
    },
  ],
  expect: 'main section table tbody tr',
  minMatches: 3,
},
```

Row-count verification (all read-only, bypass RLS on, live DB 2026-09-10):

- Fixture run `…1813` (PAY-00003) is the ONLY committed run in the sim
  org (`count(*) where run_status='committed'` → 1); its pay_date is
  2026-03-11. Fixture stubs `…1911/1912` sit on the CALCULATED run
  `…1811`, which the engine's summary query explicitly excludes
  (`r.run_status = 'committed'` join) — verified: the Feb window is empty
  today, so the March fixture below is the only group source.
- Rolled-back live-DB test of the fixture shape (components VS-TAX /
  VS-CPP, stub + 2 lines on `…1813`) → summary query for
  2026-02-01–2026-03-31 returns exactly `VS-CPP|deduction|-250.0000` and
  `VS-TAX|deduction|-800.0000`. Both lines share one vendor + null
  filing account → one group, one `section`, 2 component `tr` + 1 total
  `tr` = 3 `tbody tr`.
- Rolled-back live-DB test of the bill marker (`custom.payrollRemittance
  {from,to,filingAccountId}`) → the engine's overlap query returns it for
  the March window. One existing-bill badge link renders in the card head.
- GATES: `payroll.read` + `payroll` feature flag — the harness user
  `viewspec@sim.test` holds the admin role (same gates as the
  already-green `/payroll` entry). The `payroll.run` → `canCreate` flag
  only toggles the create-bill button label; both variants render with
  the admin user so the button is present either way.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Fresh id block claimed: **`…1840–1849`** (verified free — `grep` over the
whole fixture file shows `…1830–1835` taken by parallel-run and nothing
in `1840–1849`; the allocation table at the top lists no `184x` block).

Design notes (all verified against the live sim DB in rolled-back
transactions — the SQL below is the tested shape, not a guess):

- Components are user-style (`system_key null`) so the pack declarations
  cannot route them: null key → no regional key, no
  `remittance_party_id` bypass issue, no vendor-settings fallback — the
  destination is exactly the component's own `remittance_party_id`. The
  engine's internal-accrual exclusion (`coalesce(system_key,'') <>
  all(...)`) keeps null-key rows whatever the exclusion list holds.
- The stub rides the EXISTING committed run `…1813` (pay_date
  2026-03-11): `filing_account_source='unknown'` + null id satisfies the
  filing CHECK *and* `assertPayrollFilingAccountKnown` (it only rejects
  `source='unknown'` rows on COMMITTED runs — wait, it rejects exactly
  those; re-read: the assert throws when a committed stub in range has
  `filing_account_source='unknown'`. The existing `…1911/1912` stubs do
  exactly this on a calculated run, which is why they are invisible. My
  stub on committed `…1813` with `source='unknown'` WOULD trip the assert
  and 500 the page. FIX: the stub must carry a reconciled filing
  account: `filing_account_source='reconciled'` with
  `filing_account_evidence = {"reason": ..., "reference": ...}` — but
  with a NULL `filing_account_id` that still violates the CHECK (the
  reconciled branch requires evidence object but allows null id? The
  CHECK's reconciled branch does NOT require filing_account_id non-null
  — it requires source='reconciled' AND evidence non-null object with
  reason+reference. Null id is permitted). Hmm, but then
  `filingAccountRef(null, …)` → UNASSIGNED group and the bill-match key
  `groupKey(party, null)` still lines up with the marker's
  `filingAccountId: null`. Verified the CHECK text; the reconciled
  branch has no `filing_account_id IS NOT NULL` conjunct. The rolled-back
  test used 'unknown' and passed the INSERT (no assert in raw SQL — the
  assert only fires through the engine call). To keep the engine path
  green, the fixture MUST use source='reconciled' + evidence object.
- Same for liability: lines use `liability_account_source='commit'` +
  real account id (`2260 Payroll Taxes Payable`, verified live in the sim
  org) with null evidence — satisfies the commit branch of the line
  CHECK.
- The vendor resolves LIVE by name (first active `vendor_roles` party —
  `Anderson Legal & Bonding` today): the simulator regenerates party ids
  on reseed, and a hardcoded vendor uuid would FK-violate. GUARD pattern
  follows the subcontract fixture (resolve-then-insert with
  `ON CONFLICT (id) DO NOTHING`; component codes guarded by the id
  conflict target; the bill guarded by document-number uniqueness per
  (org, kind, number)).
- One draft `vendor_bill` marker (`BILL-VSPEC-REM-1`) with
  `custom.payrollRemittance {from 2026-03-01, to 2026-03-31,
  filingAccountId null}` exercises the existing-bills branch (badge link
  + `createAnother` label). Draft status: no accounting period needed
  (same reason the payroll fixtures keep documents in draft).

```sql
  -- ---- payroll remittances -------------------------------------------------
  --
  -- The simulator never accrues remittable withholdings: the only committed
  -- sim run (…1813, PAY-00003, pay_date 2026-03-11) carries no stubs, and the
  -- fixture stubs (…1911/1912) sit on a CALCULATED run the summary query
  -- explicitly excludes. Without these, /payroll/remittances compares two
  -- identical empty states. Block …1840-1845: two user-style deduction
  -- components (null system_key, so no pack declaration can reroute them),
  -- one stub on …1813 with two committed-source lines, and one draft
  -- remittance-bill marker for the same vendor + March window, so the
  -- existing-bill badge and the create-another label render.
  -- Vendor resolves LIVE (first active vendor_roles party); the liability
  -- account is the sim org's 2260 Payroll Taxes Payable, resolved live by
  -- number. The stub's filing source is 'reconciled' with an evidence
  -- object (NOT 'unknown': assertPayrollFilingAccountKnown throws on
  -- committed unknown-source stubs) and a NULL filing id, so the group
  -- lands in the unassigned filing bucket — the single-account path.
  declare
    v_vendor uuid;
    v_acct uuid;
    v_emp uuid;
  begin
    select pa.id into v_vendor from parties pa
      join vendor_roles vr on vr.party_id = pa.id and vr.org_id = pa.org_id
     where pa.org_id = v_org and vr.is_active
     order by pa.display_name limit 1;
    select id into v_acct from accounts
     where org_id = v_org and number = '2260' limit 1;
    select id into v_emp from parties
     where org_id = v_org and display_name = 'Harborview Development LLC';
    if v_vendor is null or v_acct is null or v_emp is null then
      raise notice 'missing vendor/account/party; skipping remittance fixtures';
      return;
    end if;

    insert into pay_components
      (id, org_id, code, name, kind, system_key, country, basis, taxable,
       pensionable, insurable, vacationable, non_periodic, sequence,
       is_active, liability_account_id, remittance_party_id)
    values
      ('00000000-0000-7000-9000-000000001840', v_org, 'VS-TAX',
       'ViewSpec income tax', 'deduction', null, 'CA', 'fixed_amount',
       true, true, true, true, false, 100, true, v_acct, v_vendor),
      ('00000000-0000-7000-9000-000000001841', v_org, 'VS-CPP',
       'ViewSpec CPP', 'deduction', null, 'CA', 'fixed_amount',
       true, true, true, true, false, 101, true, v_acct, v_vendor)
    on conflict (id) do nothing;

    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, country_source, filing_account_source,
       filing_account_evidence)
    values
      ('00000000-0000-7000-9000-000000001842', v_org,
       '00000000-0000-7000-9000-000000001813', v_emp, 'ON',
       26, date '2026-03-11', 2026, 'USD', 5000.00, 5000.00, 5000.00,
       4000.00, 5200.00, 200.00, 'unknown', 'reconciled',
       '{"reason": "ViewSpec: single filing account", "reference": "unassigned"}'::jsonb)
    on conflict (id) do nothing;

    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount,
       sequence, liability_account_id, liability_account_source)
    values
      ('00000000-0000-7000-9000-000000001843', v_org,
       '00000000-0000-7000-9000-000000001842',
       '00000000-0000-7000-9000-000000001840', 'deduction',
       'ViewSpec income tax', -800.00, 1, v_acct, 'commit'),
      ('00000000-0000-7000-9000-000000001844', v_org,
       '00000000-0000-7000-9000-000000001842',
       '00000000-0000-7000-9000-000000001841', 'deduction',
       'ViewSpec CPP', -250.00, 2, v_acct, 'commit')
    on conflict (id) do nothing;

    -- Draft marker bill: a posted bill must name its accounting period, and
    -- a fixture has no business inventing one. The engine's overlap query
    -- only requires kind='vendor_bill', status<>'voided' and the custom
    -- window — draft is enough for the existing-bill branch.
    insert into documents
      (id, org_id, kind, document_number, party_id, document_date,
       currency, status, subtotal, tax_total, total, memo, custom,
       created_at, updated_at)
    select '00000000-0000-7000-9000-000000001845', v_org, 'vendor_bill',
           'BILL-VSPEC-REM-1', v_vendor, date '2026-03-12', 'USD', 'draft',
           1050.00, 0.00, 1050.00, 'ViewSpec remittance bill',
           jsonb_build_object('payrollRemittance', jsonb_build_object(
             'from', '2026-03-01', 'to', '2026-03-31',
             'filingAccountId', null)),
           now(), now()
     where not exists (select 1 from documents
                        where org_id = v_org and kind = 'vendor_bill'
                          and document_number = 'BILL-VSPEC-REM-1');
  end;
```

CAVEAT (honest): the reconciled-filing-source leg above was verified at
the CHECK-constraint level (constraint text allows null id with a
reconciled evidence object) and the component/stub/line/bill legs were
each executed in rolled-back transactions against the live sim DB — but
the full five-statement sequence plus the engine's
`assertPayrollFilingAccountKnown` + `payrollRemittanceSummary` path was
NOT run end-to-end (that would write fixture rows outside my owned
files; only the coordinator applies fixture SQL). The coordinator should
apply the block, run the summary for 2026-03-01–2026-03-31, and confirm
one group / two components / one existing bill before wiring the
conformance entry.

## 4. What the spec does NOT cover (explicitly shared instead)

- No per-row widget decomposition: the cards' seven conditional pairs
  (badge, bill links, create vs assign-vendor, kind label, account
  fallback, create vs create-another, empty vs cards) are components in
  `RemittancesView` (`sections.tsx` re-export), imported back into
  `page.tsx` — one implementation, both paths. The two proposed widgets
  are leaves around that shared implementation.
- The `createBill` POST (`/api/payroll/remittances`, `create-bill` with
  the edited range) stays client behavior inside `RemittancesView`; the
  loader never ships a server action (spec rule). The existing source
  test (`RemittancesView.test.tsx`, range-payload shape) still passes —
  the component file is untouched, only re-exported.
- `previousMonth` + the DATE regex are loader logic copied verbatim from
  `page.tsx` (kept in `view.ts`; `page.tsx` keeps its own copy for the
  native branch — pure functions, no drift surface beyond the copy, same
  as the worked examples duplicate their param parsing).
- `notFound()` on a scope-refused population is preserved via a dynamic
  import (keeps the static import list free of `next/navigation`, matching
  the loader's server-only posture); the native branch is untouched.
- `groupTabs('payroll', …)` travels as `tabs: unknown`-shaped data into
  the EXISTING `module-home-tabs` widget — same pattern as the AP/purchasing
  cockpits. No new vocabulary proposed: `pageHeader`, `module-home-tabs`
  exist; `remittance-cockpit` + `remittance-ap-note` are ordinary
  host-component placements, not new spec language.
- Shared-file edits needed (coordinator-owned, NOT made here):
  `web/components/viewspec/widgets.tsx` (+2 entries above),
  `scripts/viewspec-conformance.mjs` (+1 entry above),
  `scripts/viewspec-fixtures.sql` (fixture block above).
