// Built-in report definitions — plain ReportCustomQuery plans against the
// entity catalog, seeded per-org by engine/src/provisioning/seed-reports.ts (kind =
// 'built_in'). Users can run/schedule them as-is or clone them in the studio.
//
// Year-wide windows use the `period_preset` operator with value
// 'this_fiscal_year': the web executor (web/lib/custom-reports.ts) resolves it
// to concrete gte/lte bounds against the org's fiscal calendar before the
// DB-free compiler runs, so the window honours fiscalYearStartMonth instead of
// silently reading as the calendar year. Every definition run path (interactive,
// export, drill, scheduled) funnels through that executor.

import { defaultRowsQuery } from './custom-query'
import { HRM_REPORT_ENTITIES, REPORT_ENTITY_MAP, entityColumn } from './entities'
import type { ReportCustomQuery, ReportFilterOperator, ReportRule } from './types'

export type BuiltInReportUrlFilter = {
  /** Stable URL/search-view parameter name. */
  param: string
  /** Catalog field receiving the effective filter. */
  field: string
  op: ReportFilterOperator
  /** Input validation and activation semantics. */
  valueKind: 'text' | 'uuid' | 'date' | 'flag'
  /** Exact value that activates a no-value flag operator (for example `1`). */
  activeValue?: string
}

export type BuiltInReportUrlValues =
  | Readonly<Record<string, string | readonly string[] | null | undefined>>
  | { get(name: string): string | null }

export type BuiltInReportDefinition = {
  slug: string
  name: string
  description: string
  query: ReportCustomQuery
  /** Built-in-only URL controls. Kept outside persisted query JSON so screen,
   *  saved-view and export consumers can apply one authoritative filter set
   *  without changing the ReportCustomQuery storage contract. */
  urlFilters?: readonly BuiltInReportUrlFilter[]
}

/**
 * The former HRM reports page treated every HRM report entity as a separate
 * side catalog. That made the sources discoverable, but they were not actual
 * report definitions and disappeared when the page was retired.
 *
 * Materialise them as ordinary built-ins instead. They now use the same
 * definition catalog, executor, exports, schedules, permission gate and
 * feature gate as every other report. Headcount keeps its curated summary
 * definition below; every other governed source gets a practical rows-mode
 * definition generated from its declared columns and stable sort.
 */
export const WORKFORCE_BUILT_IN_REPORT_DEFINITIONS: BuiltInReportDefinition[] =
  HRM_REPORT_ENTITIES.filter((entity) => entity.key !== 'hrm_headcount').map((entity) => ({
    slug: `workforce-${entity.key.replace(/^hrm_/, '').replaceAll('_', '-')}`,
    name: entity.label,
    description: entity.description,
    query: defaultRowsQuery(entity),
  }))

export const BUILT_IN_REPORT_DEFINITIONS: BuiltInReportDefinition[] = [
  {
    slug: 'ap-aging-by-vendor',
    name: 'AP aging by vendor',
    description: 'Open payable balances per vendor, by due month.',
    query: {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'party_name' }, { column: 'due_date', bin: 'month' }],
      measures: [
        { fn: 'sum', column: 'open_amount', label: 'Open amount (base)' },
        { fn: 'count', label: 'Open lines' },
      ],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'account_type', op: 'eq', value: 'liability_payable' },
          { field: 'has_open_balance', op: 'is_true' },
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
    description: 'Outstanding receivable balances per customer.',
    query: {
      entity: 'ledger_lines',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'party_name' }],
      measures: [
        { fn: 'sum', column: 'open_amount', label: 'Open balance (base)' },
        { fn: 'count', label: 'Open lines' },
        { fn: 'min', column: 'due_date', label: 'Oldest due date' },
      ],
      filters: {
        combinator: 'and',
        rules: [
          { field: 'account_type', op: 'eq', value: 'asset_receivable' },
          { field: 'has_open_balance', op: 'is_true' },
          { field: 'entry_status', op: 'eq', value: 'posted' },
        ],
      },
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'gl-activity-by-account-fy',
    name: 'GL activity by account',
    description: 'Net movement and line count per account, this fiscal year.',
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
    name: 'Expense detail by department',
    description: 'Expense and COGS lines this fiscal year, by department.',
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
    slug: 'lot-recall',
    name: 'Lot recall',
    description: 'Every movement for a lot — item, location, quantity, expiry.',
    urlFilters: [
      { param: 'lotNumber', field: 'lot_number', op: 'contains', valueKind: 'text' },
      { param: 'itemId', field: 'item_id', op: 'eq', valueKind: 'uuid' },
      { param: 'expiresOnOrBefore', field: 'expires_on', op: 'lte', valueKind: 'date' },
      {
        param: 'expiring',
        field: 'expires_on',
        op: 'is_not_null',
        valueKind: 'flag',
        activeValue: '1',
      },
    ],
    query: {
      entity: 'inventory_lot_movements',
      mode: 'rows',
      columns: [
        'lot_number', 'expires_on', 'item_code', 'item_name', 'kind',
        'moved_at', 'quantity', 'location_code', 'document_number', 'party_name',
      ],
      breakouts: [],
      measures: [],
      filters: null,
      groupBy: null,
      // The second level is the immutable unique tie-breaker that keeps page
      // boundaries deterministic when several movements share a timestamp.
      sorts: [
        { column: 'moved_at', direction: 'desc' },
        { column: 'movement_id', direction: 'desc' },
      ],
      limit: 100,
    },
  },
  {
    slug: 'payroll-register',
    name: 'Payroll register',
    description: 'Pay stubs this fiscal year — gross, withholdings, net, employer cost.',
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
    description: 'Per-employee audit detail — earnings, deductions, amounts and YTD.',
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
    description: 'Withholdings and employer contributions by component, with YTD.',
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
    description: 'Payroll amounts by department and component kind.',
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
    description: 'Gross, tax, net and employer cost per employee, with stub counts.',
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
    description: 'Monthly payroll totals — gross, net, tax and employer cost.',
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
    description: 'One period checked against the prior provider, sectioned by result.',
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
    description: 'Prior-provider vs calculated totals per component, with differences.',
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
    description: 'Time-off and benefit balances per employee, with plan limits.',
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
    slug: 'allocation-summary',
    name: 'Allocation summary',
    description: 'Pooled source, allocated total and residual, per rule and period.',
    query: {
      entity: 'allocation_runs',
      mode: 'summarize',
      columns: [],
      breakouts: [{ column: 'rule_name' }, { column: 'period' }, { column: 'status' }],
      measures: [
        { fn: 'sum', column: 'source_total', label: 'Source total' },
        { fn: 'sum', column: 'allocated_total', label: 'Allocated' },
        { fn: 'sum', column: 'residual', label: 'Residual' },
        { fn: 'count', label: 'Runs' },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
  {
    slug: 'allocation-lineage',
    name: 'Allocation lineage',
    description: 'Allocated lines traced to rule, source, account and share.',
    query: {
      entity: 'allocation_lineage',
      mode: 'rows',
      columns: [
        'rule_name', 'mode', 'period', 'account_number', 'account_name',
        'department', 'share', 'amount', 'residual', 'created_at',
      ],
      breakouts: [],
      measures: [],
      filters: null,
      groupBy: 'rule_name',
      sorts: [{ column: 'created_at', direction: 'desc' }],
      limit: 5000,
    },
  },
  {
    slug: 'entitlement-service-milestones',
    name: 'Service milestones reached',
    description: 'Service anniversaries this fiscal year that change entitlements.',
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
  {
    slug: 'crm-pipeline-summary',
    name: 'Pipeline summary by stage',
    description: 'Open pipeline amounts, counts and weighted values by stage.',
    query: {
      entity: 'crm_opportunities',
      mode: 'summarize',
      breakouts: [
        { column: 'status_name' },
        { column: 'forecast_category' },
        { column: 'currency' },
      ],
      columns: [],
      measures: [
        { column: 'projected_amount', fn: 'sum', label: 'Projected amount' },
        { column: 'weighted_amount', fn: 'sum', label: 'Weighted amount' },
        { fn: 'count', label: 'Opportunities' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'is_closed', op: 'is_false' }],
      },
      sorts: [{ column: 'status_name', direction: 'asc' }],
    },
  },
  {
    slug: 'crm-forecast-by-owner',
    name: 'Pipeline forecast by owner',
    description: 'Projected and weighted pipeline by owner and category.',
    query: {
      entity: 'crm_opportunities',
      mode: 'summarize',
      breakouts: [
        { column: 'owner_name' },
        { column: 'forecast_category' },
        { column: 'currency' },
      ],
      columns: [],
      measures: [
        { column: 'projected_amount', fn: 'sum', label: 'Projected amount' },
        { column: 'weighted_amount', fn: 'sum', label: 'Weighted amount' },
        { fn: 'count', label: 'Opportunities' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'is_closed', op: 'is_false' }],
      },
      sorts: [{ column: 'owner_name', direction: 'asc' }],
    },
  },
  {
    slug: 'crm-win-loss-analysis',
    name: 'Win/loss analysis',
    description: 'Closed deals by outcome and reason, with totals.',
    query: {
      entity: 'crm_opportunities',
      mode: 'summarize',
      breakouts: [
        { column: 'is_won' },
        { column: 'win_loss_reason' },
        { column: 'currency' },
      ],
      columns: [],
      measures: [
        { column: 'projected_amount', fn: 'sum', label: 'Closed amount' },
        { fn: 'count', label: 'Deals' },
      ],
      filters: {
        combinator: 'and',
        rules: [{ field: 'is_closed', op: 'is_true' }],
      },
      sorts: [{ column: 'is_won', direction: 'desc' }],
    },
  },
  {
    slug: 'crm-lead-conversion-funnel',
    name: 'Lead lifecycle & source summary',
    description: 'Accounts by lifecycle stage, status and lead source.',
    query: {
      entity: 'crm_account_profiles',
      mode: 'summarize',
      breakouts: [
        { column: 'lifecycle_stage' },
        { column: 'status_name' },
        { column: 'lead_source_name' },
      ],
      columns: [],
      measures: [
        { fn: 'count', label: 'Accounts' },
      ],
      filters: null,
      sorts: [{ column: 'lifecycle_stage', direction: 'asc' }],
    },
  },
  ...WORKFORCE_BUILT_IN_REPORT_DEFINITIONS,
  {
    slug: 'headcount-statement',
    name: 'Headcount statement',
    description: 'Headcount and FTE by subsidiary and department, with totals.',
    query: {
      entity: 'hrm_headcount',
      mode: 'summarize',
      columns: [],
      // One row per subsidiary × department group. The organization total
      // rides the shared summary band (Total headcount / Total FTE), which
      // the ExportData conversion repeats as footer rows — so the statement
      // PDF, CSV and XLSX all carry it with no bespoke total row.
      breakouts: [{ column: 'subsidiary' }, { column: 'department' }],
      measures: [
        { fn: 'sum', column: 'headcount', label: 'Headcount' },
        { fn: 'sum', column: 'fte_total', label: 'Full-time equivalents' },
      ],
      filters: null,
      groupBy: null,
      limit: 1000,
    },
  },
]

/** O(1) catalog lookup shared by native routes, exports, and saved views. */
export const BUILT_IN_REPORT_DEFINITION_MAP: Readonly<Record<string, BuiltInReportDefinition>> =
  Object.fromEntries(BUILT_IN_REPORT_DEFINITIONS.map((definition) => [definition.slug, definition]))

const VALUE_OPS: Record<BuiltInReportUrlFilter['valueKind'], readonly ReportFilterOperator[]> = {
  text: ['eq', 'neq', 'contains'],
  uuid: ['eq', 'neq'],
  date: ['eq', 'neq', 'gte', 'lte'],
  flag: ['is_null', 'is_not_null', 'is_true', 'is_false'],
}

function readUrlValue(values: BuiltInReportUrlValues, param: string): string | null {
  if ('get' in values && typeof values.get === 'function') return values.get(param)
  const raw = (values as Readonly<Record<string, string | readonly string[] | null | undefined>>)[param]
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : null
  return typeof raw === 'string' ? raw : null
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

/** Apply a built-in's catalog-authored URL controls to its query. Screen,
 *  export, and saved-view paths call this same pure helper, so none can drift
 *  onto a different effective filter set. Invalid active values fail closed;
 *  absent/empty controls simply add no rule. */
export function applyBuiltInUrlFilters(
  definition: BuiltInReportDefinition,
  values: BuiltInReportUrlValues,
): ReportCustomQuery {
  const bindings = definition.urlFilters ?? []
  if (bindings.length > 12) throw new Error(`built-in ${definition.slug} has too many URL filters`)
  const entity = REPORT_ENTITY_MAP[definition.query.entity]
  if (!entity) throw new Error(`built-in ${definition.slug} has an unknown entity`)

  const rules: ReportRule[] = []
  const seen = new Set<string>()
  for (const binding of bindings) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(binding.param) || seen.has(binding.param)) {
      throw new Error(`built-in ${definition.slug} has an invalid URL parameter binding`)
    }
    seen.add(binding.param)
    const column = entityColumn(entity, binding.field)
    if (!column || !VALUE_OPS[binding.valueKind].includes(binding.op)) {
      throw new Error(`built-in ${definition.slug} has an invalid URL filter binding`)
    }
    if (binding.valueKind === 'uuid' && column.kind !== 'uuid') {
      throw new Error(`built-in ${definition.slug} binds a UUID to a non-UUID field`)
    }
    if (binding.valueKind === 'date' && column.kind !== 'date' && column.kind !== 'timestamp') {
      throw new Error(`built-in ${definition.slug} binds a date to a non-date field`)
    }
    if (binding.valueKind === 'flag' && !binding.activeValue) {
      throw new Error(`built-in ${definition.slug} has a flag without an activation value`)
    }

    const raw = readUrlValue(values, binding.param)
    if (raw === null || raw.trim() === '') continue
    const value = raw.trim()
    if (value.length > 500) throw new Error(`Invalid report parameter: ${binding.param}`)
    if (binding.valueKind === 'flag') {
      if (value === binding.activeValue) rules.push({ field: binding.field, op: binding.op })
      continue
    }
    if (binding.valueKind === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error(`Invalid report parameter: ${binding.param}`)
    }
    if (binding.valueKind === 'date' && !isIsoDate(value)) {
      throw new Error(`Invalid report parameter: ${binding.param}`)
    }
    rules.push({ field: binding.field, op: binding.op, value })
  }

  if (rules.length === 0) return definition.query
  return {
    ...definition.query,
    filters: {
      combinator: 'and',
      rules: [
        ...(definition.query.filters ? [definition.query.filters] : []),
        ...rules,
      ],
    },
  }
}
