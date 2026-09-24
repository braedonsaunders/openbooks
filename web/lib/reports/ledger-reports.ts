import "server-only";
import { sql } from "drizzle-orm";
import { PAYROLL_RESTRICTED_PARTY_LABEL, collapseRestrictedPayrollLines } from "../payroll-confidentiality";
import { functionalReportReader } from "./currency-basis";
import { bucketSubsidiaryFilter, glSummaryEligibleDims, statementBookExpr } from "../gl-summary";
import { resolveOrgId } from "../org-scope";
import { fiscalYearStartOn } from "@openbooks/reports";
import { decimalAdd, decimalCmp, decimalNeg, type ExactDecimal } from "../statement-format";
import { PNL_TYPES } from "../account-types";
import { fiscalStartMonth } from "../fiscal";
import { ZERO } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";

// ---------------------------------------------------------------------------
// General Ledger — per-account transaction listing with a running balance
// ---------------------------------------------------------------------------

export interface GeneralLedgerLine {
  entryId: string
  entryNumber: string | null
  date: string
  memo: string | null
  party: string | null
  debit: ExactDecimal
  credit: ExactDecimal
  balance: ExactDecimal // running (debit-signed) within the account
  docKind: string | null
  docId: string | null
}

export interface GeneralLedgerAccount {
  id: string
  number: string | null
  name: string
  type: string
  opening: ExactDecimal
  closing: ExactDecimal
  lines: GeneralLedgerLine[]
}

export interface GeneralLedgerResult {
  accounts: GeneralLedgerAccount[]
  from: string
  to: string
  truncated: boolean
}

/**
 * General Ledger: for each account with activity in the period, its opening
 * balance (posted lines before `from`; P&L only from the fiscal-year start
 * of `from`), every posted line in the period in date order with a running
 * balance, and the closing balance. Balances are debit-signed (matches the
 * account register). Capped at `maxLines` posted lines overall so a
 * full-ledger run stays bounded.
 */
export async function generalLedger(
  from: string,
  to: string,
  opts: {
    accountId?: string; dims?: DimFilter; maxLines?: number; orgId?: string; bookId?: string | null;
    /**
     * True when the reader holds payroll.read and may see per-employee pay
     * detail. Defaults to false (fail closed): without it, party-tagged
     * payroll lines collapse into one restricted line per entry per account.
     */
    canSeePayroll?: boolean;
  } = {},
): Promise<GeneralLedgerResult> {
  const orgId = await resolveOrgId(opts.orgId)
  const maxLines = opts.maxLines ?? 5000
  const fyStart = fiscalYearStartOn(from, await fiscalStartMonth(orgId))
  const acctFilter = opts.accountId ? sql` and l.account_id = ${opts.accountId}` : sql``
  const pnlInYear = sql`a.type not in ${PNL_TYPES} or`
  const reportDb = functionalReportReader(orgId, sql`e.posting_date <= ${to}
    and e.book_id = ${statementBookExpr(orgId, opts.bookId)} and ${dimWhere(opts.dims)} ${acctFilter}`)

  // Opening balances (debit-signed) per account before the period. Balance-
  // sheet accounts are inception-to-date; P&L accounts start at the fiscal
  // year of `from` so a mid-year GL does not carry last year's income.
  const summaryOpening = glSummaryEligibleDims(opts.dims)
  const openingSql = summaryOpening
    ? sql`
        select ${reportDb.censusColumn}, x.account_id, coalesce(sum(x.amt), 0) as bal from (
            select g.account_id, (g.debit_total - g.credit_total) as amt
              from gl_month_activity g
              join accounts a on a.id = g.account_id and a.org_id = g.org_id
           where g.org_id = ${orgId}
             and g.book_id = ${statementBookExpr(orgId, opts.bookId)}
             and g.month < date_trunc('month', ${from}::date)::date
             and (${pnlInYear} g.month >= ${fyStart}::date)
             ${bucketSubsidiaryFilter(opts.dims?.subsidiaryIds, sql`g`)}
             ${opts.accountId ? sql`and g.account_id = ${opts.accountId}` : sql``}
          union all
          select l.account_id, l.amount
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
             and e.status in ('posted', 'reversed')
             and e.book_id = ${statementBookExpr(orgId, opts.bookId)}
             and e.posting_date >= date_trunc('month', ${from}::date)::date
             and e.posting_date < ${from}
            join accounts a on a.id = l.account_id and a.org_id = l.org_id
           where l.org_id = ${orgId} and (${pnlInYear} e.posting_date >= ${fyStart}::date)
             and ${dimWhere(opts.dims)}${acctFilter}
        ) x group by x.account_id`
    : sql`
        select ${reportDb.censusColumn}, l.account_id, coalesce(sum(l.amount), 0) as bal
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
          and e.book_id = ${statementBookExpr(orgId, opts.bookId)}
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where l.org_id = ${orgId} and e.posting_date < ${from}
           and (${pnlInYear} e.posting_date >= ${fyStart}::date)
           and ${dimWhere(opts.dims)}${acctFilter}
         group by l.account_id`
  const opening = (await reportDb.execute<{ account_id: string; bal: string }>(openingSql))
  const openingByAcct = new Map(opening.rows.map((r) => [r.account_id, r.bal]))

  // Keep the detail cap presentation-only. Closing balances must include all
  // posted activity in the report window, including lines omitted by `limit`.
  const periodActivity = (await reportDb.execute<{ account_id: string; activity: string }>(sql`
    select ${reportDb.censusColumn}, l.account_id, coalesce(sum(l.amount), 0) as activity
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
       and e.book_id = ${statementBookExpr(orgId, opts.bookId)}
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and e.posting_date >= ${from} and e.posting_date <= ${to}
       and ${dimWhere(opts.dims)}${acctFilter}
     group by l.account_id
  `))
  const activityByAcct = new Map(periodActivity.rows.map((r) => [r.account_id, r.activity]))

  const lines = (await reportDb.execute<{
      account_id: string; number: string | null; name: string; type: string
      entry_id: string; entry_number: string | null; date: string
      memo: string | null; party: string | null; party_id: string | null; amount: string
      doc_kind: string | null; doc_id: string | null; entry_origin: string
    }>(sql`
    select ${reportDb.censusColumn}, l.account_id, a.number, a.name, a.type,
           e.id as entry_id, e.entry_number, e.posting_date::text as date,
           l.memo, p.display_name as party, l.party_id, l.amount,
           d.kind as doc_kind, d.id as doc_id, e.origin as entry_origin
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
       and e.book_id = ${statementBookExpr(orgId, opts.bookId)}
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where l.org_id = ${orgId} and e.posting_date >= ${from} and e.posting_date <= ${to} and ${dimWhere(opts.dims)}${acctFilter}
     order by a.number nulls last, a.name, e.posting_date, e.entry_number, l.line_number
     limit ${maxLines + 1}
  `))
  const truncated = lines.rows.length > maxLines
  // Confidentiality collapses BEFORE the running balances below accumulate,
  // so opening/closing ties out exactly whether or not the reader holds
  // payroll.read. Without payroll.read the collapsed line keeps the account
  // and the summed amount but names no employee and shows no per-employee
  // memo (cheque numbers) or amount.
  const visible = opts.canSeePayroll === true ? lines.rows.slice(0, maxLines) : collapseRestrictedPayrollLines(
    lines.rows.slice(0, maxLines).map((r) => ({
      ...r,
      entryId: r.entry_id,
      accountId: r.account_id,
      partyId: r.party_id,
      payrollOrigin: r.doc_kind === 'pay_run' || r.entry_origin === 'payroll',
    })),
    (first, total) => ({ ...first, party: PAYROLL_RESTRICTED_PARTY_LABEL, memo: null, amount: total }),
  )
  const rows = visible

  const accounts: GeneralLedgerAccount[] = []
  let current: GeneralLedgerAccount | null = null
  for (const r of rows) {
    if (!current || current.id !== r.account_id) {
      const open = openingByAcct.get(r.account_id) ?? ZERO
      current = { id: r.account_id, number: r.number, name: r.name, type: r.type, opening: open, closing: open, lines: [] }
      accounts.push(current)
    }
    const amt = r.amount
    current.closing = decimalAdd(current.closing, amt)
    current.lines.push({
      entryId: r.entry_id,
      entryNumber: r.entry_number,
      date: r.date,
      memo: r.memo,
      party: r.party,
      debit: decimalCmp(amt, ZERO) > 0 ? amt : ZERO,
      credit: decimalCmp(amt, ZERO) < 0 ? decimalNeg(amt) : ZERO,
      balance: current.closing,
      docKind: r.doc_kind,
      docId: r.doc_id,
    })
  }
  for (const account of accounts) {
    const activity = activityByAcct.get(account.id)
    if (activity !== undefined) account.closing = decimalAdd(account.opening, activity)
  }
  return { accounts, from, to, truncated }
}

// ---------------------------------------------------------------------------
// Journal report — posted journal entries with their lines, over a period
// ---------------------------------------------------------------------------

export interface JournalReportLine {
  accountNumber: string | null
  accountName: string
  party: string | null
  memo: string | null
  debit: ExactDecimal
  credit: ExactDecimal
}
export interface JournalReportEntry {
  id: string
  entryNumber: string | null
  date: string
  memo: string | null
  origin: string
  lines: JournalReportLine[]
  totalDebit: ExactDecimal
  docKind: string | null
  docId: string | null
}
export interface JournalReportResult {
  entries: JournalReportEntry[]
  from: string
  to: string
  truncated: boolean
}

/**
 * Journal report: every posted entry in the period with its lines (debit/credit
 * split), newest first. Capped at `maxLines` journal lines overall so a wide
 * range stays bounded.
 */
export async function journalReport(
  from: string,
  to: string,
  opts: {
    dims?: DimFilter; maxLines?: number; orgId?: string; bookId?: string | null;
    /**
     * True when the reader holds payroll.read and may see per-employee pay
     * detail. Defaults to false (fail closed): without it, party-tagged
     * payroll lines collapse into one restricted line per entry per account.
     */
    canSeePayroll?: boolean;
  } = {},
): Promise<JournalReportResult> {
  const orgId = await resolveOrgId(opts.orgId)
  const maxLines = opts.maxLines ?? 4000
  const reportDb = functionalReportReader(orgId, sql`e.posting_date >= ${from} and e.posting_date <= ${to}
    and e.book_id = ${statementBookExpr(orgId, opts.bookId)} and ${dimWhere(opts.dims)}`)
  // Without a line-level dimension slice, every entry in the window
  // contributes at least one line, so the first `maxLines` lines can only come
  // from the first `maxLines` entries in the same order. Narrowing to those
  // entries first lets the date index supply them directly, instead of sorting
  // every line in the window to throw all but a few thousand away.
  const entryWindow = glSummaryEligibleDims(opts.dims) && !opts.dims?.subsidiaryIds?.length
    ? sql`(
        select id, entry_number, posting_date, memo, origin, source_document_id, org_id
          from journal_entries
         where org_id = ${orgId} and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId, opts.bookId)}
           and posting_date >= ${from} and posting_date <= ${to}
         -- Same key as the outer sort, id tie-break included, so the window is
         -- exactly the first entries the full ordering would have reached.
         order by posting_date desc, entry_number desc, id
         limit ${maxLines}
      )`
    : sql`(
        select id, entry_number, posting_date, memo, origin, source_document_id, org_id
          from journal_entries
         where org_id = ${orgId} and status in ('posted', 'reversed')
           and book_id = ${statementBookExpr(orgId, opts.bookId)}
           and posting_date >= ${from} and posting_date <= ${to}
      )`
  const r = (await reportDb.execute<{
      id: string; entry_number: string | null; date: string; entry_memo: string | null; origin: string
      acct_number: string | null; acct_name: string; acct_id: string; party: string | null; party_id: string | null
      line_memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }>(sql`
    select ${reportDb.censusColumn}, e.id, e.entry_number, e.posting_date::text as date, e.memo as entry_memo, e.origin,
           a.number as acct_number, a.name as acct_name, l.account_id as acct_id, p.display_name as party, l.party_id,
           l.memo as line_memo, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from ${entryWindow} e
      join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where ${dimWhere(opts.dims)}
     order by e.posting_date desc, e.entry_number desc, e.id, l.line_number
     limit ${maxLines + 1}
  `))
  const truncated = r.rows.length > maxLines
  // Confidentiality collapses BEFORE entries are assembled below, so entry
  // totals still balance exactly. Without payroll.read the collapsed line
  // keeps the account and the summed amount but names no employee and shows
  // no per-employee memo (cheque numbers) or amount.
  const confidential = opts.canSeePayroll === true ? r.rows : collapseRestrictedPayrollLines(
    r.rows.map((x) => ({
      ...x,
      entryId: x.id,
      accountId: x.acct_id,
      partyId: x.party_id,
      payrollOrigin: x.doc_kind === 'pay_run' || x.origin === 'payroll',
    })),
    (first, total) => ({ ...first, party: PAYROLL_RESTRICTED_PARTY_LABEL, line_memo: null, amount: total }),
  )
  let rows = truncated ? confidential.slice(0, maxLines) : confidential
  // The line cap must never split a journal entry: the sentinel row tells us
  // whether the first excluded line belongs to the final included entry. Drop
  // that whole entry so a capped report cannot expose an unbalanced partial.
  if (truncated && rows.length > 0 && r.rows[maxLines]?.id === rows[rows.length - 1]?.id) {
    const partialEntryId = rows[rows.length - 1]!.id
    rows = rows.filter((row) => row.id !== partialEntryId)
  }

  const entries: JournalReportEntry[] = []
  const entriesById = new Map<string, JournalReportEntry>()
  for (const x of rows) {
    let entry = entriesById.get(x.id)
    if (!entry) {
      entry = { id: x.id, entryNumber: x.entry_number, date: x.date, memo: x.entry_memo, origin: x.origin, lines: [], totalDebit: ZERO, docKind: x.doc_kind, docId: x.doc_id }
      entriesById.set(x.id, entry)
      entries.push(entry)
    }
    const amt = x.amount
    entry.lines.push({
      accountNumber: x.acct_number,
      accountName: x.acct_name,
      party: x.party,
      memo: x.line_memo,
      debit: decimalCmp(amt, ZERO) > 0 ? amt : ZERO,
      credit: decimalCmp(amt, ZERO) < 0 ? decimalNeg(amt) : ZERO,
    })
    if (decimalCmp(amt, ZERO) > 0) entry.totalDebit = decimalAdd(entry.totalDebit, amt)
  }
  return { entries, from, to, truncated }
}
