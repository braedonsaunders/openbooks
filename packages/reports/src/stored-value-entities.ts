import type { ReportEntity } from './entities'

// Stored-value reports (gift cards and store credit) read the liability
// subledger directly: the immutable entries for the movement roll-forward,
// the open accounts for unclaimed property. The GL sees only posted control
// totals, which cannot break out by program or follow dormancy, so the
// catalog carries the same org-pinned joins as the list and drawer queries.
// Amounts are ledger minor units at ten-thousandths precision; the money
// expressions divide back to whole units in exact numeric arithmetic, the
// same conversion the register list uses — the reports never see raw
// integers and never blend currencies (every money column is txnCurrency
// with the row's currency exposed for pinning or breakout).
const MINOR_TO_UNITS = (column: string): string => `(${column}::numeric / 10000)`

const shared = {
  category: 'transactions',
  featureKey: 'storedValue',
  requiredPermission: 'stored_value.read',
  // Neither table carries a subsidiary: stored value is issued and redeemed
  // org-wide, so there is no legal-entity boundary to scope (precedent:
  // custom-record entities declare an explicit null scope the same way).
  subsidiaryScope: null,
  currencyColumn: 'currency',
} as const

export const STORED_VALUE_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: 'stored_value_movements',
    label: 'Stored-value movements',
    description:
      'One row per stored-value ledger entry — issue, redemption, correction, expiry and breakage — with the program, masked code, customer and running account balance. Group by program and month for the liability roll-forward.',
    from: `stored_value_entries e
      JOIN stored_value_accounts a ON a.id = e.account_id AND a.org_id = e.org_id
      JOIN stored_value_programs p ON p.id = a.program_id AND p.org_id = e.org_id
      LEFT JOIN parties cust ON cust.id = a.customer_party_id AND cust.org_id = e.org_id`,
    orgColumn: 'e.org_id',
    timeKey: 'entered_on',
    latestOrderExpr: 'e.created_at DESC, e.id DESC',
    defaultPeriodField: 'entered_on',
    defaultSort: { column: 'entered_on', direction: 'desc' },
    columns: [
      { key: 'id', label: 'Entry key', kind: 'uuid', expr: 'e.id' },
      { key: 'program', label: 'Program', kind: 'text', expr: 'p.name' },
      {
        key: 'program_kind', label: 'Program kind', kind: 'enum', expr: 'p.kind',
        options: ['gift_card', 'store_credit'],
      },
      { key: 'account_code', label: 'Account', kind: 'text', expr: `'••••-' || a.code_last4` },
      { key: 'customer', label: 'Customer', kind: 'text', expr: 'cust.display_name' },
      {
        key: 'kind', label: 'Movement', kind: 'enum', expr: 'e.kind',
        options: ['issue', 'redeem', 'adjust', 'expire', 'breakage', 'reversal'],
      },
      {
        key: 'amount', label: 'Amount', kind: 'money',
        expr: MINOR_TO_UNITS('e.amount_minor'), txnCurrency: true,
      },
      {
        key: 'balance_after', label: 'Account balance after', kind: 'money',
        expr: MINOR_TO_UNITS('e.balance_after'), txnCurrency: true, snapshot: true,
      },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'e.currency' },
      { key: 'entered_on', label: 'Entered on', kind: 'date', expr: '(e.created_at::date)' },
      { key: 'reason', label: 'Reason', kind: 'text', expr: 'e.reason' },
      { key: 'document_id', label: 'Document key', kind: 'uuid', expr: 'e.document_id' },
    ],
  },
  {
    ...shared,
    key: 'stored_value_balances',
    label: 'Stored-value balances',
    description:
      'One row per stored-value account with its open balance, customer region and last activity. Filter to open statuses and group by region and activity month for unclaimed-property (escheat) review.',
    from: `stored_value_accounts a
      JOIN stored_value_programs p ON p.id = a.program_id AND p.org_id = a.org_id
      LEFT JOIN parties cust ON cust.id = a.customer_party_id AND cust.org_id = a.org_id`,
    orgColumn: 'a.org_id',
    // A balance snapshot must not acquire a fiscal window merely because it
    // exposes activity and expiry dates (precedent: inventory lot movements
    // opts out the same way); dormancy cohorts come from grouping by
    // last_activity_on, not from windowing the snapshot.
    defaultPeriodField: null,
    defaultSort: { column: 'last_activity_on', direction: 'asc' },
    columns: [
      { key: 'account_code', label: 'Account', kind: 'text', expr: `'••••-' || a.code_last4` },
      { key: 'customer', label: 'Customer', kind: 'text', expr: 'cust.display_name' },
      { key: 'customer_region', label: 'Customer region', kind: 'text', expr: 'cust.region' },
      { key: 'program', label: 'Program', kind: 'text', expr: 'p.name' },
      {
        key: 'program_kind', label: 'Program kind', kind: 'enum', expr: 'p.kind',
        options: ['gift_card', 'store_credit'],
      },
      {
        key: 'status', label: 'Status', kind: 'enum', expr: 'a.status',
        options: ['active', 'frozen', 'closed', 'expired'],
      },
      // No snapshot flag: the grain is one row per account, so each dollar
      // appears exactly once in any grouping and sums to the outstanding
      // total. (The movements entity keeps snapshot on balance_after, where
      // one account's dollars repeat on every later entry.)
      {
        key: 'balance', label: 'Open balance', kind: 'money',
        expr: MINOR_TO_UNITS('a.balance_minor'), txnCurrency: true,
      },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'a.currency' },
      { key: 'last_activity_on', label: 'Last activity', kind: 'date', expr: 'a.last_activity_on' },
      { key: 'expires_on', label: 'Expires on', kind: 'date', expr: 'a.expires_on' },
      { key: 'inactivity_months', label: 'Program inactivity threshold (months)', kind: 'number', expr: 'p.inactivity_months' },
    ],
  },
]
