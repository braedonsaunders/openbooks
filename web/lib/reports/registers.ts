import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { resolveOrgId } from "../org-scope";
import { decimalAdd, decimalCmp, decimalNeg, type ExactDecimal } from "../statement-format";
import { ZERO } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";
import { type AgingBucket, agingDetail, type AgingSide } from "./aging";

interface AccountRegisterAccount extends Record<string, unknown> {
  id: string;
  number: string | null;
  name: string;
  type: string;
  is_summary: boolean;
}

interface AccountRegisterLine extends Record<string, unknown> {
  entry_id: string;
  entry_number: string | null;
  posting_date: string;
  entry_memo: string | null;
  line_number: number;
  amount: string;
  memo: string | null;
  party: string | null;
  doc_id: string | null;
  doc_kind: string | null;
  doc_number: string | null;
}

export async function accountRegister(
  orgId: string,
  accountId: string,
  limit = 100,
  offset = 0,
  period?: { from?: string; to?: string; search?: string },
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
) {
  const acct = (await db.execute<AccountRegisterAccount>(sql`
    select id, number, name, type, is_summary from accounts
     where id = ${accountId} and org_id = ${orgId}
  `));
  if (!acct.rows[0]) return { account: undefined, lines: [], total: 0, balance: '0' };
  const dateFilter =
    period?.from || period?.to
      ? sql` and e.posting_date >= ${period?.from ?? '0001-01-01'} and e.posting_date <= ${period?.to ?? '9999-12-31'}`
      : sql``;
  const search = period?.search?.trim().slice(0, 200) ?? '';
  const like = `%${search.replace(/[%_\\]/g, (character) => `\\${character}`)}%`;
  const searchFilter = search
    ? sql` and (
        coalesce(e.entry_number, '') ilike ${like}
        or coalesce(e.memo, '') ilike ${like}
        or coalesce(l.memo, '') ilike ${like}
        or coalesce(p.display_name, '') ilike ${like}
        or coalesce(d.document_number, '') ilike ${like}
        or replace(coalesce(d.kind, 'journal'), '_', ' ') ilike ${like}
      )`
    : sql``;
  const subsidiaryFilter = allowedSubsidiaryIds
    ? allowedSubsidiaryIds.size > 0
      ? sql` and e.subsidiary_id in ${[...allowedSubsidiaryIds]}`
      : sql` and false`
    : sql``;
  const r = (await db.execute<AccountRegisterLine>(sql`
    with recursive account_scope as (
      select id from accounts where id = ${accountId} and org_id = ${orgId}
      union
      select child.id
        from accounts child
        join account_scope parent on child.parent_id = parent.id
       where child.org_id = ${orgId}
    )
    select e.id as entry_id, e.entry_number, e.posting_date::text as posting_date, e.memo as entry_memo,
           l.line_number, l.amount, l.memo, p.display_name as party,
           d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where l.account_id in (select id from account_scope)
       and l.org_id = ${orgId} and e.org_id = ${orgId} ${dateFilter} ${searchFilter} ${subsidiaryFilter}
     order by e.posting_date desc, e.entry_number desc, l.line_number
     limit ${limit} offset ${offset}
  `));
  const c = (await db.execute<{ n: string; bal: string }>(sql`
    with recursive account_scope as (
      select id from accounts where id = ${accountId} and org_id = ${orgId}
      union
      select child.id
        from accounts child
        join account_scope parent on child.parent_id = parent.id
       where child.org_id = ${orgId}
    )
    select count(*) as n, coalesce(sum(amount),0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where l.account_id in (select id from account_scope)
       and l.org_id = ${orgId} and e.org_id = ${orgId} ${dateFilter} ${searchFilter} ${subsidiaryFilter}
  `));
  const totals = c.rows[0] ?? { n: "0", bal: "0" };
  return { account: acct.rows[0], lines: r.rows, total: Number(totals.n), balance: totals.bal };
}

// ---------------------------------------------------------------------------
// AR / AP Register — per-party transaction register on the control account
// ---------------------------------------------------------------------------

export interface RegisterLine {
  entryId: string
  entryNumber: string | null
  date: string
  memo: string | null
  debit: ExactDecimal
  credit: ExactDecimal
  balance: ExactDecimal
  docKind: string | null
  docId: string | null
}
export interface RegisterParty {
  partyId: string | null
  partyName: string | null
  opening: ExactDecimal
  closing: ExactDecimal
  lines: RegisterLine[]
}
export interface RegisterResult {
  parties: RegisterParty[]
  from: string
  to: string
  side: AgingSide
  truncated: boolean
}

/**
 * AR/AP register: for each party, its opening balance on the control account
 * (all posted lines before `from`), every posted line in the period with a
 * running balance, and the closing balance. Balances are debit-signed. AR uses
 * the `asset_receivable` control accounts, AP `liability_payable`.
 */
export async function partyRegister(
  side: AgingSide,
  opts: { from: string; to: string; partyId?: string; orgId?: string; dims?: DimFilter; maxLines?: number },
): Promise<RegisterResult> {
  const resolvedOrgId = await resolveOrgId(opts.orgId)
  const acctType = side === "ap" ? "liability_payable" : "asset_receivable"
  const maxLines = opts.maxLines ?? 4000
  const partyFilter = opts.partyId ? sql` and l.party_id = ${opts.partyId}` : sql``

  const opening = (await db.execute<{ party_id: string | null; bal: string }>(sql`
    select l.party_id, coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where a.type = ${acctType} and e.posting_date < ${opts.from}
       and l.org_id = ${resolvedOrgId} and ${dimWhere(opts.dims)}${partyFilter}
     group by l.party_id
  `))
  const openingByParty = new Map(opening.rows.map((r) => [r.party_id, r.bal]))

  const lines = (await db.execute<{
      party_id: string | null; party_name: string | null
      entry_id: string; entry_number: string | null; date: string; memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }>(sql`
    select l.party_id, pt.display_name as party_name,
           e.id as entry_id, e.entry_number, e.posting_date::text as date, l.memo, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties pt on pt.id = l.party_id and pt.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where a.type = ${acctType} and e.posting_date >= ${opts.from} and e.posting_date <= ${opts.to}
       and l.org_id = ${resolvedOrgId} and ${dimWhere(opts.dims)}${partyFilter}
     order by pt.display_name nulls last, e.posting_date, e.entry_number, l.line_number
     limit ${maxLines + 1}
  `))
  const truncated = lines.rows.length > maxLines
  const rows = truncated ? lines.rows.slice(0, maxLines) : lines.rows

  const parties: RegisterParty[] = []
  let current: RegisterParty | null = null
  for (const x of rows) {
    if (!current || current.partyId !== x.party_id) {
      const open = openingByParty.get(x.party_id) ?? ZERO
      current = { partyId: x.party_id, partyName: x.party_name, opening: open, closing: open, lines: [] }
      parties.push(current)
    }
    const amt = x.amount
    current.closing = decimalAdd(current.closing, amt)
    current.lines.push({
      entryId: x.entry_id,
      entryNumber: x.entry_number,
      date: x.date,
      memo: x.memo,
      debit: decimalCmp(amt, ZERO) > 0 ? amt : ZERO,
      credit: decimalCmp(amt, ZERO) < 0 ? decimalNeg(amt) : ZERO,
      balance: current.closing,
      docKind: x.doc_kind,
      docId: x.doc_id,
    })
  }
  return { parties, from: opts.from, to: opts.to, side, truncated }
}

// ---------------------------------------------------------------------------
// Partner statement — one party: opening, dated activity, closing + aged summary
// ---------------------------------------------------------------------------

export interface PartnerStatementResult {
  party: { id: string; name: string | null }
  side: AgingSide
  from: string
  to: string
  opening: ExactDecimal
  closing: ExactDecimal
  lines: RegisterLine[]
  aging: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal }
}

/** Account statement for a single party: opening balance on the control
 *  account, dated activity with a running balance, closing balance, and an
 *  aged-summary footer as of `to` (reusing the open-item aging logic). */
export async function partnerStatement(
  partyId: string,
  orgId: string,
  opts: { from: string; to: string; side: AgingSide; dims?: DimFilter },
): Promise<PartnerStatementResult> {
  const reg = await partyRegister(opts.side, { from: opts.from, to: opts.to, partyId, orgId, dims: opts.dims })
  const p = reg.parties[0]
  const partySubsidiaryFilter = opts.dims?.subsidiaryIds
    ? opts.dims.subsidiaryIds.length > 0
      ? sql` and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${opts.dims.subsidiaryIds.join(",")}}`}::uuid[]))`
      : sql` and false`
    : sql``
  const nameRow = (await db.execute<{ display_name: string | null }>(sql`
    select p.display_name
      from parties p
     where p.id = ${partyId} and p.org_id = ${orgId}${partySubsidiaryFilter}
  `))
  const aging = await agingDetail(opts.side, opts.to, opts.dims, orgId)
  const agingTotals: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal } = { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO }
  for (const row of aging.rows) {
    if (row.partyId !== partyId) continue
    agingTotals[row.bucket] = decimalAdd(agingTotals[row.bucket], row.open)
    agingTotals.total = decimalAdd(agingTotals.total, row.open)
  }
  return {
    party: { id: partyId, name: nameRow.rows[0]?.display_name ?? p?.partyName ?? null },
    side: opts.side,
    from: opts.from,
    to: opts.to,
    opening: p?.opening ?? ZERO,
    closing: p?.closing ?? ZERO,
    lines: p?.lines ?? [],
    aging: agingTotals,
  }
}
