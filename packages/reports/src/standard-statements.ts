// The catalog of STANDARD financial-statement reports, seeded into
// report_definitions as `report_type = 'statement'` rows (kind = 'built_in',
// system = true) by engine/src/seed-reports.ts. This makes standard reports
// first-class definitions in the SAME table as custom reports — the first step
// of unifying standard + custom onto one model/pipeline/editor.
//
// `statementKind` matches the web layer's REPORT_KINDS (web/lib/report-run.ts);
// `params` are the report's fixed arguments (e.g. AR vs AP side). Reports that
// require a runtime selection (partner statement → a party, budget → a scenario)
// are intentionally NOT seeded here — they are launched with their argument.

export type StandardStatementDefinition = {
  /** Stable per-org slug (also the deep-link + idempotent-seed key). */
  slug: string
  name: string
  description: string
  /** Matches web REPORT_KINDS; routes to the statement/matrix engine. */
  statementKind: string
  /** Fixed args merged into the resolve request (side, kind, …). */
  params?: Record<string, string>
}

export const STANDARD_STATEMENT_DEFINITIONS: StandardStatementDefinition[] = [
  {
    slug: 'profit-and-loss',
    name: 'Profit & Loss',
    description: 'Income statement — revenue, COGS, gross profit, expenses and net income, with comparatives and dimension breakouts.',
    statementKind: 'pnl',
  },
  {
    slug: 'balance-sheet',
    name: 'Balance Sheet',
    description: 'Assets, liabilities and equity as of a date, with comparatives and dimension breakouts.',
    statementKind: 'balance-sheet',
  },
  {
    slug: 'cash-flow',
    name: 'Cash Flow Statement',
    description: 'Operating, investing and financing cash movement for a period, proven against bank balances.',
    statementKind: 'cash-flow',
  },
  {
    slug: 'trial-balance',
    name: 'Trial Balance',
    description: 'Debit and credit balances for every account, as of a date.',
    statementKind: 'trial-balance',
  },
  {
    slug: 'general-ledger',
    name: 'General Ledger',
    description: 'Per-account posted activity with opening/closing balances and a running balance.',
    statementKind: 'general-ledger',
  },
  {
    slug: 'journal',
    name: 'Journal',
    description: 'Posted journal entries with their debit/credit lines, newest first.',
    statementKind: 'journal',
  },
  {
    slug: 'ar-aging',
    name: 'A/R Aging',
    description: 'Open receivables per customer bucketed by age (current / 30 / 60 / 90+).',
    statementKind: 'aging',
    params: { side: 'ar' },
  },
  {
    slug: 'ap-aging',
    name: 'A/P Aging',
    description: 'Open payables per vendor bucketed by age (current / 30 / 60 / 90+).',
    statementKind: 'aging',
    params: { side: 'ap' },
  },
  {
    slug: 'ar-register',
    name: 'A/R Register',
    description: 'Per-customer register on the receivable control account with a running balance.',
    statementKind: 'registers',
    params: { side: 'ar' },
  },
  {
    slug: 'ap-register',
    name: 'A/P Register',
    description: 'Per-vendor register on the payable control account with a running balance.',
    statementKind: 'registers',
    params: { side: 'ap' },
  },
  {
    slug: 'receivables',
    name: 'Receivables',
    description: 'Outstanding balance owed by each customer (point-in-time snapshot).',
    statementKind: 'partners',
    params: { kind: 'receivable' },
  },
  {
    slug: 'payables',
    name: 'Payables',
    description: 'Outstanding balance owed to each vendor (point-in-time snapshot).',
    statementKind: 'partners',
    params: { kind: 'payable' },
  },
  {
    slug: 'project-profitability',
    name: 'Project Profitability',
    description: 'Per-project revenue, cost and margin with approved job hours; ties to the P&L.',
    statementKind: 'project-profitability',
  },
]
