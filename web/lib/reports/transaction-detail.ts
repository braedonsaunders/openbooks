import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { resolveOrgId } from "../org-scope";
import type { ExactDecimal } from "../statement-format";
import { statementBookExpr } from "../gl-summary";
import { CREDIT_NORMAL } from "./statements";
import { type DimFilter, dimWhere } from "./filters";

// ---------------------------------------------------------------------------
// Transaction detail — the journal lines behind any statement value (drill-down)
// ---------------------------------------------------------------------------

export interface TxnDetailLine {
  lineId: string
  entryId: string
  entryNumber: string | null
  date: string
  accountNumber: string | null
  accountName: string
  accountType: string
  party: string | null
  memo: string | null
  amount: ExactDecimal // debit-signed
  /** Source-document kind (vendor_bill, customer_invoice, journal, …) for the
   *  transaction-type pill; null for system-generated GL entries. */
  docKind: string | null
  /** Source-document id → opens the native module drawer; null when none. */
  docId: string | null
}

export interface TxnDetailResult {
  lines: TxnDetailLine[]
  totalDebit: ExactDecimal
  totalCredit: ExactDecimal
  /** Reader-signed net (credit-normal types flipped) — ties to the clicked cell. */
  net: ExactDecimal
  count: number
  truncated: boolean
}

/**
 * The posted journal lines that make up a single statement value. `accountIds`
 * drills a specific account AND its descendants (matching how the matrix rolls
 * children into parents); `accountTypes` drills a section/subtotal (every
 * account of those types). `mode: 'flow'` sums the [from,to] window; 'balance'
 * is cumulative up to `to`. Basis/dims mirror the matrix engine so the `net`
 * ties out to the cell the user clicked.
 */
export async function transactionDetail(opts: {
  accountIds?: string[]
  accountTypes?: string[]
  from?: string | null
  to: string
  mode: "flow" | "balance"
  dims?: DimFilter
  basis?: "accrual" | "cash"
  partyIds?: string[]
  /** Project-customer scope used by customer subtotal drill-downs. */
  projectCustomerId?: string
  /** Project rows without a customer, kept separate from an unfiltered total. */
  unassignedProjectCustomer?: boolean
  projectSearch?: string
  /** Restrict supporting entries to projects whose authoritative active flag is on. */
  activeProjectsOnly?: boolean
  profitSigned?: boolean
  cashOnly?: boolean
  limit?: number
  offset?: number
  orgId?: string
  /** Restrict the drill-down to the statement's accounting book. */
  bookId?: string | null
}): Promise<TxnDetailResult> {
  const orgId = await resolveOrgId(opts.orgId)
  const limit = opts.limit ?? 2000
  const offset = opts.offset ?? 0
  const acctFilter =
    opts.accountIds && opts.accountIds.length
      ? sql`a.id in (
          with recursive sub as (
            select id from accounts where org_id = ${orgId} and id in ${opts.accountIds}
            union all
            select c.id from accounts c join sub on c.parent_id = sub.id where c.org_id = ${orgId}
          ) select id from sub
        )`
      : opts.accountTypes && opts.accountTypes.length
        ? sql`a.type in ${opts.accountTypes}`
        : sql`true`
  const dateFilter =
    opts.mode === "balance"
      ? sql`e.posting_date <= ${opts.to}`
      : sql`e.posting_date >= ${opts.from ?? "0001-01-01"} and e.posting_date <= ${opts.to}`
  const cashFilter =
    opts.cashOnly
      ? sql` and e.id in (select l2.entry_id from journal_lines l2 join accounts a2 on a2.id = l2.account_id and a2.org_id = l2.org_id where l2.org_id = ${orgId} and a2.type = 'asset_bank')`
      : sql``
  const partyFilter = opts.partyIds?.length ? sql` and l.party_id in ${opts.partyIds}` : sql``
  const projectCustomerFilter = opts.projectCustomerId
    ? sql` and l.project_id in (
        select p.id from projects p
         where p.org_id = ${orgId} and p.customer_id = ${opts.projectCustomerId}
      )`
    : opts.unassignedProjectCustomer
      ? sql` and l.project_id in (
          select p.id from projects p
           where p.org_id = ${orgId} and p.customer_id is null
        )`
      : sql``
  const projectSearchFilter = opts.projectSearch?.trim()
    ? sql` and l.project_id in (
        select p.id
          from projects p
          left join parties cu on cu.id = p.customer_id and cu.org_id = p.org_id
         where p.org_id = ${orgId}
           and (p.name ilike ${`%${opts.projectSearch.trim()}%`} or cu.display_name ilike ${`%${opts.projectSearch.trim()}%`})
      )`
    : sql``
  const activeProjectFilter = opts.activeProjectsOnly
    ? sql` and l.project_id in (
        select p.id from projects p
         where p.org_id = ${orgId} and p.is_active
      )`
    : sql``

  const bookFilter = sql`e.book_id = ${statementBookExpr(orgId, opts.bookId)}`
  // Cash-basis statements recognize accrual documents at their settled share
  // (see statementMatrix): bank-backed and settlement-FX entries count in
  // full, a settled document counts at min(settled share, 1), everything else
  // contributes zero. The drill must value lines the same way or its net
  // cannot tie to the cell. This is deliberately separate from `cashOnly`
  // (the cash-flow section drill, which keeps the bank-touch filter).
  const cashBasis = opts.basis === "cash" && !opts.cashOnly
  const cashCtes = cashBasis
    ? sql`with bank_entries as materialized (
          select distinct bl.entry_id
            from journal_lines bl
            join accounts ba on ba.id = bl.account_id and ba.org_id = bl.org_id
           where bl.org_id = ${orgId} and ba.type = 'asset_bank'
        ),
        cash_settled as materialized (
          select ctl.entry_id,
                 sum(app.amount)::numeric /
                   nullif((select coalesce(sum(abs(cl.amount)), 0)
                             from journal_lines cl
                             join accounts ca on ca.id = cl.account_id and ca.org_id = cl.org_id
                            where cl.entry_id = ctl.entry_id and cl.org_id = ctl.org_id
                              and ca.type in ('asset_receivable', 'liability_payable')
                              and cl.is_open_item), 0) as share
            from applications app
            join journal_lines ctl on ctl.id = app.to_line_id and ctl.org_id = app.org_id
            join accounts cta on cta.id = ctl.account_id and cta.org_id = ctl.org_id
            join journal_lines src on src.id = app.from_line_id and src.org_id = app.org_id
           where app.org_id = ${orgId}
             and app.unapplied_at is null
             and cta.type in ('asset_receivable', 'liability_payable')
             and exists (
               select 1 from journal_lines sb
                 join accounts sba on sba.id = sb.account_id and sba.org_id = sb.org_id
                where sb.entry_id = src.entry_id and sb.org_id = src.org_id
                  and sba.type = 'asset_bank')
           group by ctl.entry_id, ctl.org_id
        ),
        settlement_fx_entries as materialized (
          select distinct app.fx_gain_loss_entry_id as entry_id
            from applications app
            join journal_lines src on src.id = app.from_line_id and src.org_id = app.org_id
           where app.org_id = ${orgId}
             and app.unapplied_at is null
             and app.fx_gain_loss_entry_id is not null
             and exists (
               select 1 from journal_lines sb
                 join accounts sba on sba.id = sb.account_id and sba.org_id = sb.org_id
                where sb.entry_id = src.entry_id and sb.org_id = src.org_id
                  and sba.type = 'asset_bank')
        )`
    : sql``
  const cashJoins = cashBasis
    ? sql`
            left join bank_entries bn on bn.entry_id = e.id
            left join cash_settled cs on cs.entry_id = e.id
            left join settlement_fx_entries sf on sf.entry_id = e.id`
    : sql``
  const cashValue = cashBasis
    ? sql`(case
            when bn.entry_id is not null or sf.entry_id is not null then l.amount
            else l.amount * least(coalesce(cs.share, 0::numeric), 1::numeric)
          end)`
    : sql`l.amount`
  const where = sql`l.org_id = ${orgId} and e.org_id = ${orgId} and a.org_id = ${orgId} and ${bookFilter} and ${acctFilter} and ${dateFilter} and ${dimWhere(opts.dims)}${cashFilter}${partyFilter}${projectCustomerFilter}${projectSearchFilter}${activeProjectFilter}${cashBasis ? sql` and ${cashValue} <> 0` : sql``}`
  // Cash-basis lines are valued at their recognized (settled-share) amount so
  // the debit/credit/net split ties to the matrix cell, not to gross lines.
  const v = cashBasis ? cashValue : sql`l.amount`
  const readerNet = opts.profitSigned
    ? sql`-${v}`
    : sql`case when a.type in ${[...CREDIT_NORMAL]} then -${v} else ${v} end`

  // Totals over the FULL set (independent of the display limit), so `net` ties
  // out to the clicked cell even when the line list is truncated. `net` is
  // reader-signed by default; profit subtotals instead negate every included
  // line so debit-normal costs subtract from credit-normal revenue.
  const agg = (await db.execute<{ n: number; debit: string; credit: string; net: string }>(sql`
    ${cashCtes}
    select count(*)::int as n,
           coalesce(sum(case when ${v} > 0 then ${v} else 0 end), 0) as debit,
           coalesce(sum(case when ${v} < 0 then -${v} else 0 end), 0) as credit,
           coalesce(sum(${readerNet}), 0) as net
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')${cashJoins}
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where ${where}
  `))
  const totals = agg.rows[0] ?? { n: 0, debit: '0', credit: '0', net: '0' }

  const r = (await db.execute<{
      line_id: string; entry_id: string; entry_number: string | null; date: string
      acct_number: string | null; acct_name: string; acct_type: string
      party: string | null; memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }>(sql`
    ${cashCtes}
    select l.id as line_id, e.id as entry_id, e.entry_number, e.posting_date::text as date,
           a.number as acct_number, a.name as acct_name, a.type as acct_type,
           p.display_name as party, l.memo, ${v} as amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')${cashJoins}
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where ${where}
     order by e.posting_date, e.entry_number, l.line_number
     limit ${limit} offset ${offset}
  `))
  const lines: TxnDetailLine[] = r.rows.map((x) => ({
    lineId: x.line_id,
    entryId: x.entry_id,
    entryNumber: x.entry_number,
    date: x.date,
    accountNumber: x.acct_number,
    accountName: x.acct_name,
    accountType: x.acct_type,
    party: x.party,
    memo: x.memo,
    amount: x.amount,
    docKind: x.doc_kind,
    docId: x.doc_id,
  }))
  return {
    lines,
    totalDebit: totals.debit,
    totalCredit: totals.credit,
    net: totals.net,
    count: totals.n,
    truncated: totals.n > lines.length,
  }
}
