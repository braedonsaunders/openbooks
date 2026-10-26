import type { ReportEntity } from "./entities";

const shared = {
  category: "general_ledger" as const,
  featureKey: "expenseAmortization",
  requiredPermission: "amortization.read",
  currencyColumn: "currency",
};

/**
 * Expense amortization reports.
 *
 * The plan source lists every live schedule period — what amortized and
 * what is still scheduled — so the waterfall summarizes it by month. The
 * reconciliation source lists every movement of a deferral account twice
 * over: as the general ledger recorded it and as the schedules account for
 * it (deferrals, credits, catch-ups, write-offs, cancellations and posted
 * periods). Summed through a date, ledger and subledger agree by book,
 * subsidiary, currency and account; a difference is a posting to the
 * deferral account that no schedule explains.
 */
export const AMORTIZATION_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "prepaid_amortization_plan",
    label: "Prepaid expense amortization plan",
    description: "Scheduled and amortized prepaid expense periods by month, account and schedule.",
    from: `expense_amortization_schedule_lines l
      join expense_amortization_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
      join accounts deferral on deferral.org_id = s.org_id and deferral.id = s.deferral_account_id
      join accounts destination on destination.org_id = l.org_id and destination.id = l.destination_account_id
      left join subsidiaries sub on sub.org_id = s.org_id and sub.id = s.subsidiary_id`,
    orgColumn: "l.org_id",
    subsidiaryScope: { column: "s.subsidiary_id" },
    bookScope: { column: "s.book_id" },
    timeKey: "month",
    baseFilter: {
      combinator: "and",
      rules: [{ field: "line_status", op: "in", value: ["planned", "posted"] }],
    },
    columns: [
      { key: "month", label: "Month", kind: "date", expr: "l.period_start" },
      { key: "schedule_number", label: "Schedule", kind: "text", expr: "s.schedule_number" },
      {
        key: "schedule_status",
        label: "Schedule status",
        kind: "enum",
        expr: "s.status",
        options: ["draft", "active", "on_hold", "completed", "cancelled"],
      },
      {
        key: "line_status",
        label: "Period status",
        kind: "enum",
        expr: "l.status",
        options: ["planned", "posted", "superseded", "cancelled"],
      },
      {
        key: "deferral_account",
        label: "Deferral account",
        kind: "text",
        expr: "concat_ws(' · ', deferral.number, deferral.name)",
      },
      {
        key: "destination_account",
        label: "Expense account",
        kind: "text",
        expr: "concat_ws(' · ', destination.number, destination.name)",
      },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "sub.name" },
      { key: "currency", label: "Currency", kind: "text", expr: "s.currency" },
      {
        key: "amortized",
        label: "Amortized",
        kind: "money",
        expr: "case when l.status = 'posted' then l.planned_amount else 0 end",
        txnCurrency: true,
      },
      {
        key: "scheduled",
        label: "Scheduled",
        kind: "money",
        expr: "case when l.status = 'planned' and s.status in ('active', 'on_hold', 'draft') then l.planned_amount else 0 end",
        txnCurrency: true,
      },
      { key: "schedule_id", label: "Schedule (id)", kind: "uuid", expr: "s.id" },
      {
        key: "journal_entry_id",
        label: "Journal entry (id)",
        kind: "uuid",
        expr: "l.journal_entry_id",
      },
      { key: "book_id", label: "Book (id)", kind: "uuid", expr: "s.book_id" },
    ],
    defaultSort: { column: "month", direction: "asc" },
  },
  {
    ...shared,
    key: "prepaid_amortization_reconciliation",
    label: "Prepaid expense reconciliation",
    description:
      "Deferral account ledger movements beside their schedules, with the difference to a date.",
    from: `(
        select e.org_id, s.book_id, s.subsidiary_id, s.currency, s.deferral_account_id as account_id,
               e.effective_on as moved_on, 'schedule'::text as source, 0::numeric as ledger_amount,
               e.balance_delta as subledger_amount
          from expense_amortization_schedule_events e
          join expense_amortization_schedules s on s.org_id = e.org_id and s.id = e.schedule_id
         where e.balance_delta <> 0
        union all
        select l.org_id, s.book_id, s.subsidiary_id, s.currency, s.deferral_account_id,
               l.period_end, 'schedule'::text, 0::numeric, -l.planned_amount
          from expense_amortization_schedule_lines l
          join expense_amortization_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
         where l.status = 'posted'
        union all
        select jl.org_id, je.book_id, jl.subsidiary_id, sub.base_currency, jl.account_id,
               je.posting_date, 'ledger'::text, jl.amount, 0::numeric
          from journal_lines jl
          join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id and je.status in ('posted','reversed')
          join subsidiaries sub on sub.org_id = jl.org_id and sub.id = jl.subsidiary_id
         where jl.account_id in (
           select x.deferral_account_id from expense_amortization_schedules x where x.org_id = jl.org_id
           union
           select y.deferral_account_id from expense_amortization_templates y where y.org_id = jl.org_id)
      ) r
      join accounts a on a.org_id = r.org_id and a.id = r.account_id
      left join subsidiaries rsub on rsub.org_id = r.org_id and rsub.id = r.subsidiary_id
      left join accounting_books b on b.org_id = r.org_id and b.id = r.book_id`,
    orgColumn: "r.org_id",
    subsidiaryScope: { column: "r.subsidiary_id" },
    bookScope: { column: "r.book_id" },
    timeKey: "moved_on",
    columns: [
      { key: "moved_on", label: "Date", kind: "date", expr: "r.moved_on" },
      {
        key: "deferral_account",
        label: "Deferral account",
        kind: "text",
        expr: "concat_ws(' · ', a.number, a.name)",
      },
      { key: "subsidiary", label: "Subsidiary", kind: "text", expr: "rsub.name" },
      { key: "book", label: "Book", kind: "text", expr: "b.name" },
      { key: "currency", label: "Currency", kind: "text", expr: "r.currency" },
      {
        key: "source",
        label: "Source",
        kind: "enum",
        expr: "r.source",
        options: ["ledger", "schedule"],
      },
      {
        key: "ledger",
        label: "General ledger",
        kind: "money",
        expr: "r.ledger_amount",
        txnCurrency: true,
      },
      {
        key: "subledger",
        label: "Schedules",
        kind: "money",
        expr: "r.subledger_amount",
        txnCurrency: true,
      },
      {
        key: "difference",
        label: "Difference",
        kind: "money",
        expr: "r.ledger_amount - r.subledger_amount",
        txnCurrency: true,
      },
      { key: "account_id", label: "Account (id)", kind: "uuid", expr: "r.account_id" },
      { key: "book_id", label: "Book (id)", kind: "uuid", expr: "r.book_id" },
    ],
    defaultSort: { column: "moved_on", direction: "asc" },
  },
];
