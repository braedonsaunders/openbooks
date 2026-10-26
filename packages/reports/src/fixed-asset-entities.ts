import type { ReportEntity } from "./entities";
import { REPORT_AS_OF } from "./report-as-of";

// Fixed-asset reports read the asset subledger: the register and its
// per-book carrying values, the movements that build them (additions,
// depreciation, remeasurements, partial disposals and transfers, disposals,
// construction in progress), the unposted depreciation plan, the proposal
// queue, maintenance and insurance. Every asset belongs to one legal entity,
// so amounts are that entity's functional currency and scope by it.

const shared = {
  category: "fixed_assets",
  featureKey: "fixedAssets",
  requiredPermission: "assets.read",
  baseCurrencyColumn: "base_currency",
} as const;

const ASSET_STATUSES = [
  "draft",
  "in_service",
  "fully_depreciated",
  "disposed",
  "written_off",
  "construction",
  "capitalized",
];

/**
 * One row per movement of an asset's cost or accumulated depreciation in a
 * book. Cost and accumulated depreciation are both stated as positive
 * balances: an addition raises cost, depreciation raises accumulated
 * depreciation, a disposal lowers both. Construction in progress moves cost
 * in the primary book as GL lines are linked and capitalized.
 */
const MOVEMENTS = `
  select a.org_id, a.id as asset_id, b.id as book_id, a.in_service_on as moved_on,
         case when a.transferred_from_asset_id is null then 'addition' else 'transfer_in' end as kind,
         a.acquisition_cost as cost_delta, coalesce(a.opening_accumulated_depreciation, 0) as accumulated_delta
    from fixed_assets a
    join accounting_books b on b.org_id = a.org_id and b.is_active
   where a.in_service_on is not null and a.status in ('in_service', 'fully_depreciated', 'disposed', 'written_off')
  union all
  select s.org_id, s.asset_id, s.book_id, coalesce(e.posting_date, p.ends_on), 'depreciation', 0, l.posted_amount
    from depreciation_schedule_lines l
    join depreciation_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
    join accounting_periods p on p.org_id = l.org_id and p.id = l.period_id
    left join journal_entries e on e.org_id = l.org_id and e.id = l.journal_entry_id
   where l.posted_amount is not null
  union all
  select x.org_id, x.asset_id, x.book_id, x.effective_on, 'partial_disposal', x.cost_delta, x.accumulated_delta
    from asset_basis_changes x
  union all
  select v.org_id, v.asset_id, e.book_id, v.occurred_on, 'remeasurement', 0, -v.amount
    from asset_events v
    join journal_entries e on e.org_id = v.org_id and e.id = v.journal_entry_id
   where v.kind in ('impaired', 'revalued')
  union all
  select r.org_id, r.asset_id, e.book_id, r.occurred_on, 'remeasurement', 0, src.amount
    from asset_events r
    join asset_events src on src.org_id = r.org_id and src.id = r.reverses_event_id and src.kind in ('impaired', 'revalued')
    join journal_entries e on e.org_id = r.org_id and e.id = r.journal_entry_id
   where r.kind = 'reversed'
  union all
  select v.org_id, v.asset_id, e.book_id, v.occurred_on, 'disposal',
         coalesce(sum(jl.amount) filter (where jl.account_id = coalesce(a.asset_account_id, c.asset_account_id)), 0),
         -coalesce(sum(jl.amount) filter (where jl.account_id = coalesce(a.accumulated_depreciation_account_id, c.accumulated_depreciation_account_id)), 0)
    from asset_events v
    left join asset_events src on src.org_id = v.org_id and src.id = v.reverses_event_id
    join fixed_assets a on a.org_id = v.org_id and a.id = v.asset_id
    join asset_categories c on c.org_id = a.org_id and c.id = a.category_id
    join journal_entries e on e.org_id = v.org_id and e.id = v.journal_entry_id
    join journal_lines jl on jl.org_id = e.org_id and jl.entry_id = e.id
   where v.kind in ('disposed', 'written_off') or (v.kind = 'reversed' and src.kind in ('disposed', 'written_off'))
   group by v.org_id, v.asset_id, e.book_id, v.occurred_on, v.id
  union all
  select c.org_id, c.cip_asset_id, b.id, c.posting_date, 'cip_cost', c.amount, 0
    from asset_cip_costs c
    join accounting_books b on b.org_id = c.org_id and b.is_primary and b.is_active and b.posts_gl
   where c.status = 'linked'
  union all
  select k.org_id, k.cip_asset_id, b.id, k.capitalized_on, 'cip_capitalization', -(k.capitalized_amount + k.expensed_amount), 0
    from asset_cip_capitalizations k
    join accounting_books b on b.org_id = k.org_id and b.is_primary and b.is_active and b.posts_gl
  union all
  select k.org_id, k.cip_asset_id, b.id, rev.posting_date, 'cip_capitalization', k.capitalized_amount + k.expensed_amount, 0
    from asset_cip_capitalizations k
    join journal_entries rev on rev.org_id = k.org_id and rev.id = k.reversal_entry_id
    join accounting_books b on b.org_id = k.org_id and b.is_primary and b.is_active and b.posts_gl
   where k.status = 'reversed'`;

/**
 * Month-end balances per asset and book: every month from the asset's first
 * movement through the current month (through its last movement once its
 * balances are fully cleared), so opening and closing balances of any
 * window sum over every asset held — not only those that moved.
 */
const MONTHLY_BALANCES = `(
  with movements as (${MOVEMENTS}),
  monthly as (
    select org_id, asset_id, book_id, date_trunc('month', moved_on)::date as month,
           sum(cost_delta) filter (where kind in ('addition', 'cip_cost')) as additions,
           sum(cost_delta) filter (where kind in ('transfer_in', 'partial_disposal')) as transfers,
           sum(cost_delta) filter (where kind = 'disposal') as disposals,
           sum(cost_delta) filter (where kind = 'cip_capitalization') as capitalized,
           sum(cost_delta) as cost_change,
           sum(accumulated_delta) filter (where kind = 'depreciation') as depreciation,
           sum(accumulated_delta) filter (where kind = 'remeasurement') as remeasurement,
           sum(accumulated_delta) filter (where kind in ('disposal', 'partial_disposal', 'transfer_in', 'addition')) as accumulated_other,
           sum(accumulated_delta) as accumulated_change
      from movements
     group by org_id, asset_id, book_id, date_trunc('month', moved_on)::date
  ),
  spans as (
    select org_id, asset_id, book_id, min(month) as first_month,
           case when sum(cost_change) = 0 and sum(accumulated_change) = 0 then max(month)
                else greatest(max(month), date_trunc('month', current_date)::date) end as last_month
      from monthly
     group by org_id, asset_id, book_id
  ),
  grid as (
    select s.org_id, s.asset_id, s.book_id, gs::date as month
      from spans s
      cross join lateral generate_series(s.first_month, s.last_month, interval '1 month') gs
  )
  select g.org_id, g.asset_id, g.book_id, g.month,
         coalesce(m.additions, 0) as additions, coalesce(m.transfers, 0) as transfers,
         coalesce(m.disposals, 0) as disposals, coalesce(m.capitalized, 0) as capitalized,
         coalesce(m.depreciation, 0) as depreciation, coalesce(m.remeasurement, 0) as remeasurement,
         coalesce(m.accumulated_other, 0) as accumulated_other,
         coalesce(sum(m.cost_change) over w, 0) - coalesce(m.cost_change, 0) as cost_opening,
         coalesce(sum(m.cost_change) over w, 0) as cost_closing,
         coalesce(sum(m.accumulated_change) over w, 0) - coalesce(m.accumulated_change, 0) as accumulated_opening,
         coalesce(sum(m.accumulated_change) over w, 0) as accumulated_closing
    from grid g
    left join monthly m on m.org_id = g.org_id and m.asset_id = g.asset_id and m.book_id = g.book_id and m.month = g.month
  window w as (partition by g.org_id, g.asset_id, g.book_id order by g.month rows between unbounded preceding and current row)
) rf`;

export const FIXED_ASSET_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "fixed_asset_register",
    label: "Fixed asset register by book",
    description:
      "Every fixed asset in every active book — including construction in progress and component assets — with status, parent, cost, accumulated depreciation and carrying value today.",
    from: `fixed_assets fa
      JOIN accounting_books b ON b.org_id = fa.org_id AND b.is_active
      JOIN asset_book_carrying_values v ON v.org_id = fa.org_id AND v.asset_id = fa.id AND v.book_id = b.id
      JOIN subsidiaries sub ON sub.org_id = fa.org_id AND sub.id = fa.subsidiary_id
      LEFT JOIN asset_categories c ON c.org_id = fa.org_id AND c.id = fa.category_id
      LEFT JOIN fixed_assets parent ON parent.org_id = fa.org_id AND parent.id = fa.parent_asset_id`,
    orgColumn: "fa.org_id",
    subsidiaryScope: { column: "fa.subsidiary_id" },
    bookScope: { column: "b.id" },
    timeKey: "in_service_on",
    defaultPeriodField: null,
    defaultSort: { column: "asset_number", direction: "asc" },
    columns: [
      { key: "book_id", label: "Book key", kind: "uuid", expr: "b.id" },
      { key: "book", label: "Book", kind: "text", expr: "b.name" },
      { key: "asset_number", label: "Asset number", kind: "text", expr: "fa.asset_number" },
      { key: "name", label: "Name", kind: "text", expr: "fa.name" },
      { key: "status", label: "Status", kind: "enum", expr: "fa.status", options: ASSET_STATUSES },
      { key: "category", label: "Category", kind: "text", expr: "c.name" },
      { key: "parent_asset", label: "Parent asset", kind: "text", expr: "parent.asset_number" },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      { key: "acquired_on", label: "Acquired on", kind: "date", expr: "fa.acquired_on" },
      { key: "in_service_on", label: "In service on", kind: "date", expr: "fa.in_service_on" },
      { key: "cost", label: "Cost", kind: "money", expr: "v.cost", baseMoney: true },
      {
        key: "accumulated_depreciation",
        label: "Accumulated depreciation",
        kind: "money",
        expr: "v.accumulated",
        baseMoney: true,
      },
      {
        key: "carrying_value",
        label: "Carrying value",
        kind: "money",
        expr: "v.carrying_value",
        baseMoney: true,
      },
      { key: "id", label: "Asset key", kind: "uuid", expr: "fa.id" },
    ],
  },
  {
    ...shared,
    key: "fixed_asset_rollforward",
    label: "Fixed asset roll-forward",
    description:
      "Month-end cost and accumulated depreciation per asset and book: opening, additions, transfers, disposals, construction capitalized, depreciation, remeasurement and closing. Summarize by book and category for the roll-forward.",
    from: `${MONTHLY_BALANCES}
      JOIN fixed_assets fa ON fa.org_id = rf.org_id AND fa.id = rf.asset_id
      JOIN accounting_books b ON b.org_id = rf.org_id AND b.id = rf.book_id
      JOIN subsidiaries sub ON sub.org_id = fa.org_id AND sub.id = fa.subsidiary_id
      LEFT JOIN asset_categories c ON c.org_id = fa.org_id AND c.id = fa.category_id`,
    orgColumn: "rf.org_id",
    subsidiaryScope: { column: "fa.subsidiary_id" },
    bookScope: { column: "rf.book_id" },
    timeKey: "month",
    defaultPeriodField: "month",
    defaultSort: { column: "month", direction: "asc" },
    columns: [
      { key: "book_id", label: "Book key", kind: "uuid", expr: "rf.book_id" },
      { key: "book", label: "Book", kind: "text", expr: "b.name" },
      { key: "month", label: "Month", kind: "date", expr: "rf.month" },
      { key: "asset_number", label: "Asset number", kind: "text", expr: "fa.asset_number" },
      { key: "name", label: "Name", kind: "text", expr: "fa.name" },
      { key: "status", label: "Status", kind: "enum", expr: "fa.status", options: ASSET_STATUSES },
      { key: "category", label: "Category", kind: "text", expr: "c.name" },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      {
        key: "cost_opening",
        label: "Opening cost",
        kind: "money",
        expr: "rf.cost_opening",
        baseMoney: true,
        snapshot: true,
      },
      {
        key: "additions",
        label: "Additions",
        kind: "money",
        expr: "rf.additions",
        baseMoney: true,
      },
      {
        key: "transfers",
        label: "Transfers and partial disposals",
        kind: "money",
        expr: "rf.transfers",
        baseMoney: true,
      },
      {
        key: "disposals",
        label: "Disposals",
        kind: "money",
        expr: "rf.disposals",
        baseMoney: true,
      },
      {
        key: "capitalized",
        label: "Construction capitalized",
        kind: "money",
        expr: "rf.capitalized",
        baseMoney: true,
      },
      {
        key: "cost_closing",
        label: "Closing cost",
        kind: "money",
        expr: "rf.cost_closing",
        baseMoney: true,
        snapshot: true,
      },
      {
        key: "accumulated_opening",
        label: "Opening accumulated depreciation",
        kind: "money",
        expr: "rf.accumulated_opening",
        baseMoney: true,
        snapshot: true,
      },
      {
        key: "depreciation",
        label: "Depreciation",
        kind: "money",
        expr: "rf.depreciation",
        baseMoney: true,
      },
      {
        key: "remeasurement",
        label: "Impairment and revaluation",
        kind: "money",
        expr: "rf.remeasurement",
        baseMoney: true,
      },
      {
        key: "accumulated_other",
        label: "Accumulated depreciation on additions, transfers and disposals",
        kind: "money",
        expr: "rf.accumulated_other",
        baseMoney: true,
      },
      {
        key: "accumulated_closing",
        label: "Closing accumulated depreciation",
        kind: "money",
        expr: "rf.accumulated_closing",
        baseMoney: true,
        snapshot: true,
      },
      { key: "asset_id", label: "Asset key", kind: "uuid", expr: "rf.asset_id" },
    ],
  },
  {
    ...shared,
    key: "fixed_asset_depreciation_forecast",
    label: "Depreciation forecast",
    description:
      "Planned depreciation not yet posted, per asset, book and period, from each asset's current schedule.",
    from: `depreciation_schedule_lines l
      JOIN depreciation_schedules s ON s.org_id = l.org_id AND s.id = l.schedule_id
      JOIN accounting_periods p ON p.org_id = l.org_id AND p.id = l.period_id
      JOIN fixed_assets fa ON fa.org_id = s.org_id AND fa.id = s.asset_id AND fa.status IN ('in_service', 'fully_depreciated')
      JOIN accounting_books b ON b.org_id = s.org_id AND b.id = s.book_id AND b.is_active
      JOIN subsidiaries sub ON sub.org_id = fa.org_id AND sub.id = fa.subsidiary_id
      LEFT JOIN asset_categories c ON c.org_id = fa.org_id AND c.id = fa.category_id`,
    orgColumn: "l.org_id",
    subsidiaryScope: { column: "fa.subsidiary_id" },
    bookScope: { column: "s.book_id" },
    baseFilter: { combinator: "and", rules: [{ field: "posted", op: "is_false" }] },
    timeKey: "period_ends_on",
    defaultPeriodField: "period_ends_on",
    defaultSort: { column: "period_ends_on", direction: "asc" },
    columns: [
      { key: "book_id", label: "Book key", kind: "uuid", expr: "s.book_id" },
      { key: "book", label: "Book", kind: "text", expr: "b.name" },
      { key: "period", label: "Period", kind: "text", expr: "p.name" },
      { key: "period_ends_on", label: "Period ends", kind: "date", expr: "p.ends_on" },
      { key: "asset_number", label: "Asset number", kind: "text", expr: "fa.asset_number" },
      { key: "name", label: "Name", kind: "text", expr: "fa.name" },
      { key: "category", label: "Category", kind: "text", expr: "c.name" },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      { key: "posted", label: "Posted", kind: "boolean", expr: "(l.posted_amount IS NOT NULL)" },
      {
        key: "planned",
        label: "Planned depreciation",
        kind: "money",
        expr: "l.planned_amount",
        baseMoney: true,
      },
      { key: "asset_id", label: "Asset key", kind: "uuid", expr: "fa.id" },
    ],
  },
  {
    ...shared,
    featureKey: "assetProposals",
    key: "asset_proposals",
    label: "Asset proposals",
    description:
      "Posted purchase lines proposed for capitalization, with their source, vendor, account, rule, amount and decision.",
    from: `asset_proposals ap
      JOIN accounts acct ON acct.org_id = ap.org_id AND acct.id = ap.account_id
      JOIN journal_entries je ON je.org_id = ap.org_id AND je.id = ap.source_entry_id
      JOIN subsidiaries sub ON sub.org_id = ap.org_id AND sub.id = ap.subsidiary_id
      LEFT JOIN documents d ON d.org_id = ap.org_id AND d.id = ap.source_document_id
      LEFT JOIN parties vendor ON vendor.org_id = ap.org_id AND vendor.id = ap.vendor_party_id
      LEFT JOIN asset_capitalization_rules r ON r.org_id = ap.org_id AND r.id = ap.rule_id`,
    orgColumn: "ap.org_id",
    subsidiaryScope: { column: "ap.subsidiary_id" },
    timeKey: "posting_date",
    defaultPeriodField: "posting_date",
    defaultSort: { column: "posting_date", direction: "desc" },
    columns: [
      { key: "posting_date", label: "Posted on", kind: "date", expr: "ap.posting_date" },
      {
        key: "source",
        label: "Source",
        kind: "text",
        expr: "coalesce(d.document_number, je.entry_number)",
      },
      { key: "description", label: "Description", kind: "text", expr: "ap.description" },
      { key: "vendor", label: "Vendor", kind: "text", expr: "vendor.display_name" },
      {
        key: "account",
        label: "Account",
        kind: "text",
        expr: "concat_ws(' · ', acct.number, acct.name)",
      },
      { key: "rule", label: "Rule", kind: "text", expr: "r.name" },
      {
        key: "status",
        label: "Status",
        kind: "enum",
        expr: "ap.status",
        options: ["pending", "accepted", "rejected", "voided"],
      },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      { key: "amount", label: "Amount", kind: "money", expr: "ap.amount", baseMoney: true },
      {
        key: "resolution_reason",
        label: "Decision note",
        kind: "text",
        expr: "ap.resolution_reason",
      },
      { key: "id", label: "Proposal key", kind: "uuid", expr: "ap.id" },
    ],
  },
  {
    ...shared,
    featureKey: "assetMaintenance",
    key: "asset_maintenance_due",
    label: "Asset maintenance due",
    description:
      "Active maintenance schedules with their next due date and meter value, the latest reading, and whether each is scheduled, due or overdue on the report date.",
    from: `asset_maintenance_schedules ms
      JOIN fixed_assets fa ON fa.org_id = ms.org_id AND fa.id = ms.asset_id
      JOIN subsidiaries sub ON sub.org_id = fa.org_id AND sub.id = fa.subsidiary_id
      LEFT JOIN parties vendor ON vendor.org_id = ms.org_id AND vendor.id = ms.vendor_party_id
      LEFT JOIN LATERAL (
        SELECT max(r.reading) AS reading FROM asset_usage_readings r
         WHERE r.org_id = ms.org_id AND r.asset_id = ms.asset_id AND lower(r.unit) = lower(ms.usage_unit)
           AND r.read_on <= ${REPORT_AS_OF}::date
      ) meter ON true`,
    orgColumn: "ms.org_id",
    subsidiaryScope: { column: "fa.subsidiary_id" },
    baseFilter: { combinator: "and", rules: [{ field: "is_active", op: "is_true" }] },
    timeKey: "next_due_on",
    defaultPeriodField: null,
    defaultSort: { column: "next_due_on", direction: "asc" },
    columns: [
      { key: "asset_number", label: "Asset number", kind: "text", expr: "fa.asset_number" },
      { key: "asset", label: "Asset", kind: "text", expr: "fa.name" },
      { key: "task", label: "Task", kind: "text", expr: "ms.name" },
      { key: "vendor", label: "Vendor", kind: "text", expr: "vendor.display_name" },
      { key: "next_due_on", label: "Next due on", kind: "date", expr: "ms.next_due_on" },
      {
        key: "next_due_usage",
        label: "Next due at meter",
        kind: "number",
        expr: "ms.next_due_usage",
      },
      {
        key: "current_usage",
        label: "Latest meter reading",
        kind: "number",
        expr: "meter.reading",
      },
      { key: "usage_unit", label: "Meter unit", kind: "text", expr: "ms.usage_unit" },
      {
        key: "standing",
        label: "Standing",
        kind: "enum",
        options: ["scheduled", "due", "overdue"],
        expr: `CASE
          WHEN ms.next_due_on < ${REPORT_AS_OF}::date OR meter.reading > ms.next_due_usage THEN 'overdue'
          WHEN ms.next_due_on <= ${REPORT_AS_OF}::date + ms.lead_days OR meter.reading = ms.next_due_usage THEN 'due'
          ELSE 'scheduled' END`,
      },
      { key: "is_active", label: "Active", kind: "boolean", expr: "ms.is_active" },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      {
        key: "estimated_cost",
        label: "Estimated cost",
        kind: "money",
        expr: "ms.estimated_cost",
        baseMoney: true,
      },
      { key: "id", label: "Schedule key", kind: "uuid", expr: "ms.id" },
    ],
  },
  {
    ...shared,
    featureKey: "assetInsurance",
    key: "asset_insured_values",
    label: "Insured value against net book value",
    description:
      "Every asset covered by a policy in force on the report date, with its insured and replacement value against its primary-book carrying value and the gap.",
    from: `asset_insurance_coverages cov
      JOIN asset_insurance_policies pol ON pol.org_id = cov.org_id AND pol.id = cov.policy_id
        AND pol.status = 'active' AND pol.coverage_starts_on <= ${REPORT_AS_OF}::date AND pol.coverage_ends_on >= ${REPORT_AS_OF}::date
      JOIN fixed_assets fa ON fa.org_id = cov.org_id AND fa.id = cov.asset_id
      JOIN subsidiaries sub ON sub.org_id = fa.org_id AND sub.id = fa.subsidiary_id
      JOIN parties insurer ON insurer.org_id = pol.org_id AND insurer.id = pol.insurer_party_id
      LEFT JOIN accounting_books b ON b.org_id = cov.org_id AND b.is_primary AND b.is_active AND b.posts_gl
      LEFT JOIN asset_book_carrying_values v ON v.org_id = cov.org_id AND v.asset_id = fa.id AND v.book_id = b.id`,
    orgColumn: "cov.org_id",
    subsidiaryScope: { column: "fa.subsidiary_id" },
    timeKey: "coverage_ends_on",
    defaultPeriodField: null,
    defaultSort: { column: "gap", direction: "asc" },
    columns: [
      { key: "policy_number", label: "Policy", kind: "text", expr: "pol.policy_number" },
      { key: "insurer", label: "Insurer", kind: "text", expr: "insurer.display_name" },
      {
        key: "coverage_ends_on",
        label: "Coverage ends",
        kind: "date",
        expr: "pol.coverage_ends_on",
      },
      { key: "asset_number", label: "Asset number", kind: "text", expr: "fa.asset_number" },
      { key: "asset", label: "Asset", kind: "text", expr: "fa.name" },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      {
        key: "insured_value",
        label: "Insured value",
        kind: "money",
        expr: "cov.insured_value",
        baseMoney: true,
      },
      {
        key: "replacement_value",
        label: "Replacement value",
        kind: "money",
        expr: "cov.replacement_value",
        baseMoney: true,
      },
      {
        key: "net_book_value",
        label: "Net book value",
        kind: "money",
        expr: "coalesce(v.carrying_value, 0)",
        baseMoney: true,
      },
      {
        key: "gap",
        label: "Insured less net book value",
        kind: "money",
        expr: "cov.insured_value - coalesce(v.carrying_value, 0)",
        baseMoney: true,
      },
      { key: "asset_id", label: "Asset key", kind: "uuid", expr: "fa.id" },
    ],
  },
  {
    ...shared,
    featureKey: "constructionInProgress",
    key: "asset_cip_costs",
    label: "Construction-in-progress costs",
    description:
      "Every GL line linked to a construction-in-progress record — bills, journals and project costs — with its record, account, project and amount, for tying the subledger to the CIP accounts.",
    from: `asset_cip_costs cc
      JOIN fixed_assets fa ON fa.org_id = cc.org_id AND fa.id = cc.cip_asset_id
      JOIN accounts acct ON acct.org_id = cc.org_id AND acct.id = cc.account_id
      JOIN journal_entries je ON je.org_id = cc.org_id AND je.id = cc.source_entry_id
      JOIN subsidiaries sub ON sub.org_id = cc.org_id AND sub.id = cc.subsidiary_id
      LEFT JOIN projects proj ON proj.org_id = cc.org_id AND proj.id = cc.project_id`,
    orgColumn: "cc.org_id",
    subsidiaryScope: { column: "cc.subsidiary_id" },
    timeKey: "posting_date",
    defaultPeriodField: "posting_date",
    defaultSort: { column: "posting_date", direction: "asc" },
    columns: [
      { key: "cip_number", label: "Construction record", kind: "text", expr: "fa.asset_number" },
      { key: "cip_name", label: "Construction name", kind: "text", expr: "fa.name" },
      {
        key: "cip_status",
        label: "Record status",
        kind: "enum",
        expr: "fa.status",
        options: ["construction", "capitalized"],
      },
      {
        key: "account",
        label: "Account",
        kind: "text",
        expr: "concat_ws(' · ', acct.number, acct.name)",
      },
      { key: "entry_number", label: "Journal", kind: "text", expr: "je.entry_number" },
      { key: "posting_date", label: "Posted on", kind: "date", expr: "cc.posting_date" },
      { key: "project", label: "Project", kind: "text", expr: "proj.name" },
      { key: "memo", label: "Memo", kind: "text", expr: "cc.memo" },
      {
        key: "link_status",
        label: "Link status",
        kind: "enum",
        expr: "cc.status",
        options: ["linked", "unlinked"],
      },
      { key: "subsidiary", label: "Legal entity", kind: "text", expr: "sub.name" },
      { key: "base_currency", label: "Base currency", kind: "text", expr: "sub.base_currency" },
      { key: "amount", label: "Amount", kind: "money", expr: "cc.amount", baseMoney: true },
      { key: "id", label: "Cost key", kind: "uuid", expr: "cc.id" },
    ],
  },
];
