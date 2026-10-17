import type { ReportEntity } from './entities'

const shared = {
  category: 'general_ledger' as const,
  featureKey: 'equity',
  requiredPermission: 'equity.read',
  currencyColumn: 'currency',
}

/**
 * Equity reports.
 *
 * The compensation source lists every posted stock compensation run line —
 * the award's cumulative cost recognized through the run date, what earlier
 * runs posted and the change this run posted — so the expense schedule sums
 * the change by period and the latest cumulative per award is the cost
 * recognized to date. The register lists every security as issued, with its
 * terms; positions as of a date (after splits, events and vesting) are the
 * cap table's to compute, so the register states issued terms only.
 */
export const EQUITY_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: 'equity_compensation_run_lines',
    label: 'Stock compensation run lines',
    description: 'Every posted stock compensation run line: the award, its cumulative cost through the run date, the amount earlier runs posted and the change this run posted.',
    from: `equity_compensation_run_lines l
      join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
      join equity_securities s on s.org_id = l.org_id and s.id = l.security_id
      left join parties holder on holder.org_id = s.org_id and holder.id = s.holder_party_id
      left join equity_share_classes c on c.org_id = s.org_id and c.id = s.share_class_id
      left join equity_plans p on p.org_id = s.org_id and p.id = s.plan_id
      left join subsidiaries sub on sub.org_id = r.org_id and sub.id = r.subsidiary_id`,
    orgColumn: 'l.org_id',
    subsidiaryScope: { column: 'r.subsidiary_id' },
    timeKey: 'through_date',
    columns: [
      { key: 'through_date', label: 'Run through', kind: 'date', expr: 'r.through_date' },
      { key: 'security_number', label: 'Security', kind: 'text', expr: 's.security_number' },
      { key: 'security_kind', label: 'Kind', kind: 'enum', expr: 's.kind', options: ['option', 'rsu'] },
      { key: 'holder', label: 'Holder', kind: 'text', expr: 'holder.display_name' },
      { key: 'share_class', label: 'Share class', kind: 'text', expr: 'c.code' },
      { key: 'plan', label: 'Plan', kind: 'text', expr: 'p.code' },
      { key: 'subsidiary', label: 'Subsidiary', kind: 'text', expr: 'sub.name' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 'r.currency' },
      { key: 'cumulative', label: 'Recognized to date', kind: 'money', expr: 'l.cumulative_amount', txnCurrency: true, snapshot: true },
      { key: 'previous', label: 'Previously posted', kind: 'money', expr: 'l.previous_amount', txnCurrency: true, snapshot: true },
      { key: 'period', label: 'Posted this run', kind: 'money', expr: 'l.period_amount', txnCurrency: true },
      { key: 'run_id', label: 'Run (id)', kind: 'uuid', expr: 'r.id' },
      { key: 'security_id', label: 'Security (id)', kind: 'uuid', expr: 's.id' },
      { key: 'journal_entry_id', label: 'Journal entry (id)', kind: 'uuid', expr: 'r.journal_entry_id' },
    ],
    defaultSort: { column: 'through_date', direction: 'asc' },
  },
  {
    ...shared,
    key: 'equity_securities_register',
    label: 'Equity securities register',
    description: 'Every share certificate, option, RSU, warrant, SAFE and convertible note as issued: holder, class, plan, round, quantity, price and consideration.',
    from: `equity_securities s
      left join parties holder on holder.org_id = s.org_id and holder.id = s.holder_party_id
      left join equity_share_classes c on c.org_id = s.org_id and c.id = s.share_class_id
      left join equity_plans p on p.org_id = s.org_id and p.id = s.plan_id
      left join equity_financing_rounds rd on rd.org_id = s.org_id and rd.id = s.round_id
      left join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id`,
    orgColumn: 's.org_id',
    subsidiaryScope: { column: 's.subsidiary_id' },
    timeKey: 'issue_date',
    columns: [
      { key: 'issue_date', label: 'Issue date', kind: 'date', expr: 's.issue_date' },
      { key: 'security_number', label: 'Security', kind: 'text', expr: 's.security_number' },
      { key: 'security_kind', label: 'Kind', kind: 'enum', expr: 's.kind', options: ['share', 'option', 'rsu', 'warrant', 'safe', 'note'] },
      { key: 'holder', label: 'Holder', kind: 'text', expr: 'holder.display_name' },
      { key: 'share_class', label: 'Share class', kind: 'text', expr: 'c.code' },
      { key: 'plan', label: 'Plan', kind: 'text', expr: 'p.code' },
      { key: 'round', label: 'Round', kind: 'text', expr: 'rd.name' },
      { key: 'subsidiary', label: 'Subsidiary', kind: 'text', expr: 'sub.name' },
      { key: 'quantity_issued', label: 'Quantity issued', kind: 'number', expr: 's.quantity' },
      { key: 'price_per_share', label: 'Price per share', kind: 'number', expr: 's.price_per_share' },
      { key: 'currency', label: 'Currency', kind: 'text', expr: 's.currency' },
      { key: 'consideration', label: 'Consideration', kind: 'money', expr: 'coalesce(s.consideration_amount, 0)', txnCurrency: true },
      { key: 'fair_value_per_unit', label: 'Fair value per unit', kind: 'number', expr: 's.fair_value_per_unit' },
      { key: 'voided', label: 'Voided', kind: 'boolean', expr: "exists (select 1 from equity_security_events v where v.org_id = s.org_id and v.security_id = s.id and v.kind = 'void')" },
      { key: 'security_id', label: 'Security (id)', kind: 'uuid', expr: 's.id' },
      { key: 'journal_entry_id', label: 'Issuance entry (id)', kind: 'uuid', expr: 's.journal_entry_id' },
    ],
    defaultSort: { column: 'issue_date', direction: 'asc' },
  },
]
