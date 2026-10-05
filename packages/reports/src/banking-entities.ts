import type { ReportEntity } from "./entities";

const payoutShared = {
  category: "transactions" as const,
  featureKey: "banking",
  requiredPermission: "banking.read",
  currencyColumn: "currency",
};

export const BANKING_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...payoutShared,
    key: "payout_reconciliation",
    label: "Payout reconciliation",
    description:
      "Every provider payout broken into settlement lines with the matched native document, the bank-deposit tie-out and any in-transit accrual — one row per line with the payout's status and gap.",
    // One row per settlement line. Stored amounts are 4dp major units, so
    // money columns read directly with no scaling. Match status derives
    // from the stored document link exactly like the payouts workspace:
    // matchable kinds without a link wait in the queue, provider-economics
    // kinds never join it. The deposit tie-out reuses the bank
    // reconciliation matches on the batch's bank legs; every join stays
    // inside the base organization so a restricted subsidiary scope cannot
    // leak rows.
    from: `psp_settlement_batches b join psp_settlement_lines l on l.org_id=b.org_id and l.batch_id=b.id
      left join documents d on d.org_id=l.org_id and d.id=l.document_id
      left join lateral (
        select count(*) as n, coalesce(sum(sl.amount), 0) as total
          from reconciliation_matches m
          join journal_lines jl on jl.org_id=m.org_id and jl.id=m.journal_line_id
          join bank_statement_lines sl on sl.org_id=m.org_id and sl.id=m.statement_line_id
         where m.org_id=b.org_id and jl.entry_id=b.journal_entry_id and jl.account_id=b.bank_account_id
      ) dep on b.status = 'posted' and b.journal_entry_id is not null
      left join psp_payout_accruals a on a.org_id=b.org_id and a.batch_id=b.id and a.status = 'accrued'`,
    orgColumn: "b.org_id",
    subsidiaryScope: { column: "b.subsidiary_id" },
    timeKey: "settlement_day",
    defaultSort: { column: "settlement_day", direction: "desc" },
    columns: [
      { key: "provider", label: "Provider", kind: "text", expr: "b.provider" },
      { key: "payout_ref", label: "Payout", kind: "text", expr: "b.external_ref" },
      { key: "settlement_day", label: "Settlement day", kind: "date", expr: "b.settlement_date" },
      {
        key: "batch_status",
        label: "Payout status",
        kind: "enum",
        expr: "b.status",
        options: ["draft", "posted", "void"],
      },
      { key: "currency", label: "Currency", kind: "text", expr: "b.currency" },
      { key: "line_number", label: "Line", kind: "number", expr: "l.line_number" },
      { key: "line_kind", label: "Line kind", kind: "text", expr: "l.kind" },
      { key: "line_amount", label: "Line amount", kind: "money", expr: "l.amount", txnCurrency: true },
      {
        key: "match_status",
        label: "Match status",
        kind: "enum",
        expr: `case when l.document_id is not null then 'matched'
          when l.kind in ('charge', 'refund', 'dispute', 'dispute_reversal') then 'unmatched'
          else 'not_applicable' end`,
        options: ["matched", "unmatched", "not_applicable"],
      },
      { key: "document_number", label: "Document", kind: "text", expr: "d.document_number" },
      {
        key: "deposit_status",
        label: "Deposit status",
        kind: "enum",
        expr: `case when b.status <> 'posted' or b.journal_entry_id is null then 'not_posted'
          when coalesce(dep.n, 0) = 0 then 'untied' else 'tied' end`,
        options: ["tied", "untied", "not_posted"],
      },
      { key: "deposit_total", label: "Deposit total", kind: "money", expr: "coalesce(dep.total, 0)", txnCurrency: true },
      {
        key: "gap",
        label: "Gap",
        kind: "money",
        expr: `case when b.status = 'posted' and coalesce(dep.n, 0) > 0 then b.net_amount - dep.total
          when b.status = 'posted' then b.net_amount else 0 end`,
        txnCurrency: true,
      },
      { key: "accrued_amount", label: "In-transit accrued", kind: "money", expr: "coalesce(a.amount, 0)", txnCurrency: true },
    ],
  },
];
