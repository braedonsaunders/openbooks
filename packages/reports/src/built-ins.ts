// Built-in report definitions — plain ReportCustomQuery plans against the
// entity catalog, seeded per-org by engine/src/seed-reports.ts (kind =
// 'built_in'). Users can run/schedule them as-is or clone them in the studio.
//
// "This FY" note: plans use the relative `this_year` operator, which compiles
// to the CURRENT CALENDAR YEAR anchored to the DB clock. Org-specific fiscal
// calendars are a deliberate seam — when fiscal-period-aware operators land,
// swap `this_year` for them here.

import type { ReportCustomQuery } from './types'

export type BuiltInReportDefinition = {
  slug: string
  name: string
  description: string
  query: ReportCustomQuery
}

export const BUILT_IN_REPORT_DEFINITIONS: BuiltInReportDefinition[] = [
  {
    slug: 'ap-aging-by-vendor',
    name: 'AP aging by vendor',
    description:
      'Open payable ledger lines summed per vendor and due month. Negative totals are amounts owed (credit-normal payables).',
    query: {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'party_name' }, { column: 'due_date', bin: 'month' }],
      measures: [
        { fn: 'sum', column: 'amount', label: 'Open amount (base)' },
        { fn: 'count', label: 'Open lines' },
      ],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'account_type', op: 'eq', value: 'liability_payable' },
          { field: 'is_open_item', op: 'is_true' },
          { field: 'entry_status', op: 'eq', value: 'posted' },
        ],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'open-ar-by-customer',
    name: 'Open AR by customer',
    description:
      'Outstanding receivable balance per customer from open ledger items. Positive totals are amounts owed to you.',
    query: {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'party_name' }],
      measures: [
        { fn: 'sum', column: 'amount', label: 'Open balance (base)' },
        { fn: 'count', label: 'Open lines' },
        { fn: 'min', column: 'due_date', label: 'Oldest due date' },
      ],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'account_type', op: 'eq', value: 'asset_receivable' },
          { field: 'is_open_item', op: 'is_true' },
          { field: 'entry_status', op: 'eq', value: 'posted' },
        ],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'gl-activity-by-account-fy',
    name: 'GL activity by account (this FY)',
    description:
      'Posted journal activity this year, one row per account: net movement and line count. Uses the calendar year until fiscal-period operators land.',
    query: {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'account_number' }, { column: 'account_name' }, { column: 'account_type' }],
      measures: [
        { fn: 'sum', column: 'amount', label: 'Net change (base)' },
        { fn: 'count', label: 'Lines' },
      ],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'entry_status', op: 'eq', value: 'posted' },
          { field: 'posting_date', op: 'this_year' },
        ],
      },
      groupBy: null,
      limit: 5000,
    },
  },
  {
    slug: 'expense-detail-by-department-fy',
    name: 'Expense detail by department (this FY)',
    description:
      'Posted expense and COGS lines this year, sectioned by department — date, entry, account, party, memo and amount.',
    query: {
      entity: 'ledger_lines',
      mode: 'rows',
      columns: [
        'posting_date',
        'entry_number',
        'account_number',
        'account_name',
        'party_name',
        'project',
        'memo',
        'amount',
      ],
      breakouts: [],
      measures: [],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'entry_status', op: 'eq', value: 'posted' },
          { field: 'posting_date', op: 'this_year' },
          {
            field: 'account_type',
            op: 'in',
            value: ['expense', 'expense_other', 'expense_deferred', 'cogs'],
          },
        ],
      },
      groupBy: 'department',
      sorts: [{ column: 'posting_date', direction: 'asc' }],
      limit: 10000,
    },
  },
]
