// Built-in report definitions — plain ReportCustomQuery plans against the
// entity catalog, seeded per-org by engine/src/seed-reports.ts (kind =
// 'built_in'). Users can run/schedule them as-is or clone them in the studio.
//
// Year-wide windows use the `period_preset` operator with value
// 'this_fiscal_year': the web executor (web/lib/custom-reports.ts) resolves it
// to concrete gte/lte bounds against the org's fiscal calendar before the
// DB-free compiler runs, so the window honours fiscalYearStartMonth instead of
// silently reading as the calendar year. Every definition run path (interactive,
// export, drill, scheduled) funnels through that executor.

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
      'Posted journal activity this fiscal year, one row per account: net movement and line count.',
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
          { field: 'posting_date', op: 'period_preset', value: 'this_fiscal_year' },
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
      'Posted expense and COGS lines this fiscal year, sectioned by department — date, entry, account, party, memo and amount.',
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
          { field: 'posting_date', op: 'period_preset', value: 'this_fiscal_year' },
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
  {
    slug: 'payroll-register',
    name: 'Payroll register',
    description:
      'Every pay stub this fiscal year, one row per employee per run: gross, statutory withholdings, net, and employer cost, sectioned by pay run. Requires the payroll permission.',
    query: {
      entity: 'pay_stubs',
      mode: 'rows',
      columns: [
        'employee', 'province', 'gross', 'cpp_fica', 'ei', 'income_tax',
        'net_pay', 'employer_cost', 'pay_date',
      ],
      groupBy: 'run_number',
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      sorts: [{ column: 'pay_date', direction: 'desc' }],
      limit: 5000,
    },
  },
  {
    slug: 'payroll-journal',
    name: 'Payroll journal',
    description:
      'The full pay-period audit record, one section per employee: every earning, deduction, and employer contribution with hours, rate, this-period amount, and year-to-date. Pick a single pay period from the period menu to match a run. Requires the payroll permission.',
    query: {
      entity: 'pay_stub_lines',
      mode: 'summarize',
      columns: [],
      // One line per component per employee — period totals plus the exact
      // end-of-window YTD (the 'latest' running figure, not a max).
      breakouts: [{ column: 'employee' }, { column: 'line_kind' }, { column: 'component' }],
      measures: [
        { fn: 'sum', column: 'hours', label: 'Hours' },
        { fn: 'sum', column: 'amount', label: 'Amount' },
        { fn: 'latest', column: 'ytd_amount', label: 'YTD amount' },
      ],
      groupBy: 'employee',
      totals: {
        sections: true,
        grand: true,
        // The Paymate-style footer line: what actually hits the bank account.
        derived: [{
          label: 'Net pay',
          plus: { field: 'line_kind', value: 'earning' },
          minus: { field: 'line_kind', value: 'deduction' },
        }],
      },
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      limit: 10000,
    },
  },
  {
    slug: 'payroll-deductions-register',
    name: 'Deductions & contributions register',
    description:
      'Every withholding and employer contribution, sectioned by component: who paid what this period and year-to-date. The backing detail for remittances and benefit carriers. Requires the payroll permission.',
    query: {
      entity: 'pay_stub_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'component' }, { column: 'employee' }, { column: 'line_kind' }],
      measures: [
        { fn: 'sum', column: 'amount', label: 'Amount' },
        { fn: 'latest', column: 'ytd_amount', label: 'YTD amount' },
      ],
      groupBy: 'component',
      filters: {
        combinator: 'and',
        rules: [
          { field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' },
          { field: 'line_kind', op: 'in', value: ['deduction', 'employer_contribution'] },
        ],
      },
      limit: 10000,
    },
  },
  {
    slug: 'payroll-cost-by-department',
    name: 'Payroll cost by department',
    description:
      'Labor distribution: payroll amounts by department and component kind (earnings, deductions withheld, employer burden). Requires the payroll permission.',
    query: {
      entity: 'pay_stub_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'department' }, { column: 'line_kind' }],
      measures: [
        { fn: 'sum', column: 'amount', label: 'Amount' },
        { fn: 'count', label: 'Lines' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'payroll-employee-totals',
    name: 'Employee totals (YTD)',
    description:
      'One line per employee: gross, income tax withheld, net pay, and employer cost totals with stub counts for the selected period. Requires the payroll permission.',
    query: {
      entity: 'pay_stubs',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'employee' }],
      measures: [
        { fn: 'sum', column: 'gross', label: 'Gross pay' },
        { fn: 'sum', column: 'income_tax', label: 'Income tax withheld' },
        { fn: 'sum', column: 'net_pay', label: 'Net pay' },
        { fn: 'sum', column: 'employer_cost', label: 'Employer cost' },
        { fn: 'count', label: 'Stubs' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'payroll-cost-by-month',
    name: 'Payroll cost by month',
    description:
      'Monthly payroll totals this fiscal year: gross, net, income tax withheld, and employer cost, with stub counts. Requires the payroll permission.',
    query: {
      entity: 'pay_stubs',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'pay_date', bin: 'month' }, { column: 'schedule' }],
      measures: [
        { fn: 'sum', column: 'gross', label: 'Gross pay' },
        { fn: 'sum', column: 'income_tax', label: 'Income tax withheld' },
        { fn: 'sum', column: 'net_pay', label: 'Net pay' },
        { fn: 'sum', column: 'employer_cost', label: 'Employer cost' },
        { fn: 'count', label: 'Stubs' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'payroll-parallel-run',
    name: 'Parallel run reconciliation',
    description:
      'The adoption control: for one pay period, every employee and every component compared against the prior payroll provider, sectioned by result so material differences and one-sided employees are read first and exact matches last. The comparison and its classification come from the filed reconciliation — this report never restates them. A tolerance, where one is configured, is shown in its own column. Requires the payroll permission.',
    query: {
      entity: 'payroll_parallel_findings',
      mode: 'rows',
      columns: [
        'employee', 'line_kind', 'component', 'prior_amount', 'our_amount',
        'difference', 'tolerance_applied', 'source_column', 'run_number', 'register',
      ],
      // Sectioned by RESULT, not by employee: an operator running a parallel
      // run wants the differences, and a report that opens on three hundred
      // matching rows is a report nobody reads to the bottom.
      groupBy: 'classification',
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      sorts: [
        { column: 'employee', direction: 'asc' },
        { column: 'component', direction: 'asc' },
      ],
      limit: 10000,
    },
  },
  {
    slug: 'payroll-parallel-run-totals',
    name: 'Parallel run totals by component',
    description:
      'The same reconciliation rolled up: per component, what the prior provider paid in total, what this payroll calculates, and the difference — so a period-level variance is attributed to the components that produced it rather than left as one number. The employee counts on each row state how much was actually compared. Requires the payroll permission.',
    query: {
      entity: 'payroll_parallel_findings',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'line_kind' }, { column: 'component' }],
      measures: [
        { fn: 'sum', column: 'prior_amount', label: 'Prior system' },
        { fn: 'sum', column: 'our_amount', label: 'This system' },
        { fn: 'sum', column: 'difference', label: 'Difference' },
        { fn: 'max', column: 'tolerance_applied', label: 'Tolerance allowed' },
        { fn: 'latest', column: 'employees_compared', label: 'Employees compared' },
        { fn: 'count', label: 'Cells' },
      ],
      groupBy: 'line_kind',
      totals: { sections: true, grand: true },
      filters: {
        combinator: 'and',
        rules: [{ field: 'pay_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      sorts: [{ column: 'component', direction: 'asc' }],
      limit: 10000,
    },
  },
  {
    slug: 'entitlement-balances',
    name: 'Entitlement balances',
    description:
      'Every employee pay bank — banked time, vacation, benefit recoup — sectioned by plan, with the limit resolved for that person and an over/near-limit state. Balances are the entitlement ledger sum; a negative balance is money the employee owes back. Requires the payroll permission.',
    query: {
      entity: 'entitlement_balances',
      mode: 'rows',
      columns: [
        'employee', 'job_title', 'balance', 'max_balance', 'headroom',
        'limit_state', 'limit_scope', 'last_movement_date',
      ],
      breakouts: [],
      measures: [],
      groupBy: 'plan',
      sorts: [{ column: 'balance', direction: 'desc' }],
      limit: 5000,
    },
  },
  {
    slug: 'entitlement-service-milestones',
    name: 'Service milestones reached',
    description:
      'Service anniversaries an entitlement tier acts on this fiscal year — benefits eligibility, RRSP eligibility, and each rung of the vacation ladder — with the date every employee reaches it. The list the milestone letters go out from. Requires the payroll permission.',
    query: {
      entity: 'entitlement_service_milestones',
      mode: 'rows',
      columns: [
        'employee', 'milestone_date', 'milestone', 'milestone_kind',
        'after_years', 'accrual_value', 'hired_on', 'department',
      ],
      breakouts: [],
      measures: [],
      groupBy: 'milestone_kind',
      filters: {
        combinator: 'and',
        rules: [{ field: 'milestone_date', op: 'period_preset', value: 'this_fiscal_year' }],
      },
      sorts: [{ column: 'milestone_date', direction: 'asc' }],
      limit: 5000,
    },
  },

]
