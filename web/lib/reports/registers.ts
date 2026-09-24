import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { PAYROLL_RESTRICTED_PARTY_LABEL, collapseRestrictedPayrollLines } from "../payroll-confidentiality";
// Never ../authz here: that module pulls next/navigation, which breaks
// plain-node consumers of the ledger readers (spawned test children
// without the react-server condition) — same rule as payroll-confidentiality.
import { subsidiaryScopeAllows } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import { functionalReportReader } from "./currency-basis";
import { statementBookExpr } from "../gl-summary";
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

/** Selected row: the output shape plus the collapse inputs (stripped before return). */
interface AccountRegisterSelectRow extends AccountRegisterLine {
  party_id: string | null;
  account_id: string;
  entry_origin: string;
}

export async function accountRegister(
  orgId: string,
  accountId: string,
  limit = 100,
  offset = 0,
  period?: { from?: string; to?: string; search?: string },
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
  // Explicit book scope; the org's primary book when omitted — the same
  // one-book contract as every other journal reader (see gl-summary).
  bookId?: string | null,
  // True when the reader holds payroll.read and may see per-employee pay
  // detail. Defaults to false (fail closed): without it, party-tagged
  // payroll lines collapse into one restricted line per entry per account.
  canSeePayroll?: boolean,
) {
  const acct = (await db.execute<AccountRegisterAccount & { subsidiary_id: string | null }>(sql`
    select id, number, name, type, is_summary, subsidiary_id from accounts
     where id = ${accountId} and org_id = ${orgId}
  `));
  if (!acct.rows[0]) return { account: undefined, lines: [], total: 0, balance: '0' };
  // The header carries the account's number, name and balance: an
  // out-of-scope account is indistinguishable from a missing one, even when
  // the line filter below would already return zero rows. The shared chart
  // (null subsidiary) reads for every caller.
  if (!subsidiaryScopeAllows(allowedSubsidiaryIds ?? null, acct.rows[0].subsidiary_id, { orgWideNull: true })) {
    return { account: undefined, lines: [], total: 0, balance: '0' };
  }
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
      // Intercompany entries carry the origin subsidiary on the header while
      // each legal-entity leg is stamped on its journal line. Filtering the
      // header as well hides every child leg of an otherwise visible entry.
      ? sql` and l.subsidiary_id in ${[...allowedSubsidiaryIds]}`
      : sql` and false`
    : sql``;
  const bookFilter = sql` and e.book_id = ${statementBookExpr(orgId, bookId)}`;
  const reportDb = functionalReportReader(orgId, sql`l.account_id in (
    with recursive account_scope as (
      select id from accounts where id = ${accountId} and org_id = ${orgId}
      union select child.id from accounts child join account_scope parent on child.parent_id = parent.id where child.org_id = ${orgId}
    ) select id from account_scope
  ) ${dateFilter} ${searchFilter} ${subsidiaryFilter} ${bookFilter}`);
  const r = (await reportDb.execute<AccountRegisterSelectRow>(sql`
    with recursive account_scope as (
      select id from accounts where id = ${accountId} and org_id = ${orgId}
      union
      select child.id
        from accounts child
        join account_scope parent on child.parent_id = parent.id
       where child.org_id = ${orgId}
    )
    select ${reportDb.censusColumn}, e.id as entry_id, e.entry_number, e.posting_date::text as posting_date, e.memo as entry_memo,
           l.line_number, l.amount, l.memo, p.display_name as party, l.party_id, l.account_id,
           d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number, e.origin as entry_origin
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where l.account_id in (select id from account_scope)
       and l.org_id = ${orgId} and e.org_id = ${orgId} ${dateFilter} ${searchFilter} ${subsidiaryFilter} ${bookFilter}
     order by e.posting_date desc, e.entry_number desc, l.line_number
     limit ${limit} offset ${offset}
  `));
  // Confidentiality collapses BEFORE shaping below; the balance above is over
  // the same posted set, so it still ties out. Without payroll.read the
  // collapsed line keeps the account and the summed amount but names no
  // employee and shows no per-employee memo (cheque numbers) or amount.
  const mapped = r.rows.map((x) => ({
    ...x,
    entryId: x.entry_id,
    accountId: x.account_id,
    partyId: x.party_id,
    payrollOrigin: x.doc_kind === 'pay_run' || x.entry_origin === 'payroll',
  }))
  const collapsed = canSeePayroll === true ? mapped : collapseRestrictedPayrollLines(
    mapped,
    // party_id is nulled on the collapsed line: the row object is serialized
    // to API responses, and keeping the first grouped employee's id would
    // defeat the collapse. Untouched rows keep their true party.
    (first, total) => ({
      ...first, party: PAYROLL_RESTRICTED_PARTY_LABEL, party_id: null, memo: null, amount: total,
    }),
  )
  // Strip every collapse input/output key so rows keep their original shape:
  // no helper uuids (the mapped partyId would otherwise carry a real employee
  // id past the collapse) and no origin markers reach callers.
  const confidential: AccountRegisterLine[] = collapsed.map((row) => {
    // party_id never appeared in this output before: strip it alongside every
    // collapse input/output key so rows keep their original shape.
    const {
      account_id: _accountId, party_id: _partyId, entry_origin: _entryOrigin,
      entryId: _entryId, accountId: _accountUuid, partyId: _partyUuid, payrollOrigin: _payrollOrigin,
      ...rest
    } = row
    return rest
  })
  const c = (await reportDb.execute<{ n: string; bal: string }>(sql`
    with recursive account_scope as (
      select id from accounts where id = ${accountId} and org_id = ${orgId}
      union
      select child.id
        from accounts child
        join account_scope parent on child.parent_id = parent.id
       where child.org_id = ${orgId}
    )
    select ${reportDb.censusColumn}, count(*) as n, coalesce(sum(amount),0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      left join parties p on p.id = l.party_id and p.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where l.account_id in (select id from account_scope)
       and l.org_id = ${orgId} and e.org_id = ${orgId} ${dateFilter} ${searchFilter} ${subsidiaryFilter} ${bookFilter}
  `));
  const totals = c.rows[0] ?? { n: "0", bal: "0" };
  // `total` counts raw posted lines (the pagination/truncation basis);
  // `lines` may be shorter after a confidentiality collapse, while `balance`
  // always covers the full posted set.
  return { account: acct.rows[0], lines: confidential, total: Number(totals.n), balance: totals.bal };
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
 *
 * Payroll confidentiality remaps (not filters): the net-pay payable may
 * legally be a `liability_payable` account, so per-employee net-pay lines can
 * appear on the AP side. Without payroll.read those lines are attributed to
 * the NULL (unassigned) section — party, name, and memo all null — in the
 * opening, activity, and detail reads alike, so section closings still tie to
 * the control while no employee section, name, or per-employee amount
 * survives. A payroll.read reader sees the true per-party sections.
 */
export async function partyRegister(
  side: AgingSide,
  opts: {
    from: string; to: string; partyId?: string; orgId?: string; dims?: DimFilter; maxLines?: number; bookId?: string | null;
    /**
     * True when the reader holds payroll.read and may see per-employee pay
     * detail. Defaults to false (fail closed): without it, party-tagged
     * payroll lines merge into the unassigned section.
     */
    canSeePayroll?: boolean;
  },
): Promise<RegisterResult> {
  const resolvedOrgId = await resolveOrgId(opts.orgId)
  const acctType = side === "ap" ? "liability_payable" : "asset_receivable"
  const maxLines = opts.maxLines ?? 4000
  const partyFilter = opts.partyId ? sql` and l.party_id = ${opts.partyId}` : sql``
  // One accounting book per read (primary when omitted) — without this a
  // parallel book's mirror entries fuse into the register while the sibling
  // statement readers stay primary-only.
  const bookFilter = sql` and e.book_id = ${statementBookExpr(resolvedOrgId, opts.bookId)}`
  const reportDb = functionalReportReader(resolvedOrgId, sql`e.posting_date <= ${opts.to} and a.type = ${acctType} and ${dimWhere(opts.dims)} ${partyFilter} ${bookFilter}`)
  // Party attribution with the confidentiality remap folded in: restricted
  // readers see payroll-party lines under NULL (the unassigned section) in
  // every read below, so openings, activity, and detail agree by
  // construction. Full-detail readers group by the true party.
  const masked = opts.canSeePayroll === true
  const payrollParty = sql`(d.kind = 'pay_run' or e.origin = 'payroll') and l.party_id is not null`
  const partyIdExpr = masked
    ? sql`l.party_id`
    : sql`case when ${payrollParty} then null else l.party_id end`
  const partyNameExpr = masked
    ? sql`pt.display_name`
    : sql`case when ${payrollParty} then null else pt.display_name end`
  const lineMemoExpr = masked
    ? sql`l.memo`
    : sql`case when ${payrollParty} then null else l.memo end`

  const opening = (await reportDb.execute<{ party_id: string | null; bal: string }>(sql`
    select ${reportDb.censusColumn}, ${partyIdExpr} as party_id, coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where a.type = ${acctType} and e.posting_date < ${opts.from}
       and l.org_id = ${resolvedOrgId} and ${dimWhere(opts.dims)}${partyFilter} ${bookFilter}
     group by ${partyIdExpr}
  `))
  const openingByParty = new Map(opening.rows.map((r) => [r.party_id, r.bal]))

  // Keep the detail cap presentation-only. Closing balances must include all
  // posted activity in the report window, including lines omitted by `limit`.
  const periodActivity = (await reportDb.execute<{ party_id: string | null; activity: string }>(sql`
    select ${reportDb.censusColumn}, ${partyIdExpr} as party_id, coalesce(sum(l.amount), 0) as activity
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where a.type = ${acctType} and e.posting_date >= ${opts.from} and e.posting_date <= ${opts.to}
       and l.org_id = ${resolvedOrgId} and ${dimWhere(opts.dims)}${partyFilter} ${bookFilter}
     group by ${partyIdExpr}
  `))
  const activityByParty = new Map(periodActivity.rows.map((r) => [r.party_id, r.activity]))

  const lines = (await reportDb.execute<{
      party_id: string | null; party_name: string | null
      entry_id: string; entry_number: string | null; date: string; memo: string | null; amount: string
      doc_kind: string | null; doc_id: string | null
    }>(sql`
    select ${reportDb.censusColumn}, ${partyIdExpr} as party_id, ${partyNameExpr} as party_name,
           e.id as entry_id, e.entry_number, e.posting_date::text as date, ${lineMemoExpr} as memo, l.amount,
           d.kind as doc_kind, d.id as doc_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join parties pt on pt.id = l.party_id and pt.org_id = l.org_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where a.type = ${acctType} and e.posting_date >= ${opts.from} and e.posting_date <= ${opts.to}
       and l.org_id = ${resolvedOrgId} and ${dimWhere(opts.dims)}${partyFilter} ${bookFilter}
     order by ${partyNameExpr} nulls last, e.posting_date, e.entry_number, l.line_number
     limit ${maxLines + 1}
  `))
  const truncated = lines.rows.length > maxLines
  const rows = truncated ? lines.rows.slice(0, maxLines) : lines.rows

  // Sections come from the union of the opening and activity populations,
  // never from the capped detail rows alone: the line cap is
  // presentation-only, so a party whose lines are capped out (or who has no
  // window lines at all) still gets its section with the exact closing
  // (F-t08-005 — capped-out vendors lost their sections and the closings
  // summed CA$293,617.43 short of the AP control).
  const lineGroups = new Map<string | null, typeof rows>()
  for (const x of rows) {
    const group = lineGroups.get(x.party_id) ?? []
    group.push(x)
    lineGroups.set(x.party_id, group)
  }
  const partyIds = new Set<string | null>([
    ...openingByParty.keys(),
    ...activityByParty.keys(),
    ...lineGroups.keys(),
  ])
  const knownNames = new Map<string | null, string | null>(rows.map((x) => [x.party_id, x.party_name]))
  const unnamed = [...partyIds].filter((id): id is string => id !== null && !knownNames.has(id))
  if (unnamed.length > 0) {
    const named = (await reportDb.execute<{ id: string; display_name: string | null }>(sql`
      select ${reportDb.censusColumn}, p.id, p.display_name
        from parties p
       where p.org_id = ${resolvedOrgId} and p.id = any(${`{${unnamed.join(",")}}`}::uuid[])
    `)).rows
    for (const n of named) knownNames.set(n.id, n.display_name)
    for (const id of unnamed) if (!knownNames.has(id)) knownNames.set(id, null)
  }
  const parties: RegisterParty[] = []
  for (const partyId of partyIds) {
    const opening = openingByParty.get(partyId) ?? ZERO
    const activity = activityByParty.get(partyId) ?? ZERO
    const current: RegisterParty = {
      partyId,
      partyName: partyId === null ? null : (knownNames.get(partyId) ?? null),
      opening,
      closing: decimalAdd(opening, activity),
      lines: [],
    }
    let running = opening
    for (const x of lineGroups.get(partyId) ?? []) {
      if (current.partyName === null) current.partyName = x.party_name
      running = decimalAdd(running, x.amount)
      current.lines.push({
        entryId: x.entry_id,
        entryNumber: x.entry_number,
        date: x.date,
        memo: x.memo,
        debit: decimalCmp(x.amount, ZERO) > 0 ? x.amount : ZERO,
        credit: decimalCmp(x.amount, ZERO) < 0 ? decimalNeg(x.amount) : ZERO,
        balance: running,
        docKind: x.doc_kind,
        docId: x.doc_id,
      })
    }
    parties.push(current)
  }
  // Display-name order with unassigned last, matching the old detail order.
  parties.sort((a, b) => {
    if (a.partyName === null && b.partyName === null) return 0
    if (a.partyName === null) return 1
    if (b.partyName === null) return -1
    return a.partyName < b.partyName ? -1 : a.partyName > b.partyName ? 1 : 0
  })
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
  truncated: boolean
}

/** Account statement for a single party: opening balance on the control
 *  account, dated activity with a running balance, closing balance, and an
 *  aged-summary footer as of `to` (reusing the open-item aging logic). */
export async function partnerStatement(
  partyId: string,
  orgId: string,
  opts: {
    from: string; to: string; side: AgingSide; dims?: DimFilter; bookId?: string | null;
    /**
     * True when the reader holds payroll.read and may see per-employee pay
     * detail. Defaults to false (fail closed): without it, party-tagged
     * payroll lines merge into the unassigned section and never into this
     * party's opening, activity, or closing.
     */
    canSeePayroll?: boolean;
  },
): Promise<PartnerStatementResult> {
  const reg = await partyRegister(opts.side, {
    from: opts.from, to: opts.to, partyId, orgId, dims: opts.dims, bookId: opts.bookId,
    canSeePayroll: opts.canSeePayroll,
  })
  // The addressed party's own section — never parties[0]: under the
  // confidentiality remap a party whose only lines are masked payroll has no
  // section of its own, and the unassigned section's amounts must not stand
  // in as its opening or closing.
  const p = reg.parties.find((section) => section.partyId === partyId)
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
  const aging = await agingDetail(opts.side, opts.to, opts.dims, orgId, { bookId: opts.bookId })
  const agingTotals: Record<AgingBucket, ExactDecimal> & { total: ExactDecimal } = { current: ZERO, b1: ZERO, b2: ZERO, b3: ZERO, b4: ZERO, total: ZERO }
  for (const row of aging.rows) {
    if (row.partyId !== partyId) continue
    agingTotals[row.bucket] = decimalAdd(agingTotals[row.bucket], row.open)
    agingTotals.total = decimalAdd(agingTotals.total, row.open)
  }
  // The register only surfaces parties with window lines, but a statement is
  // addressed to one party: with no window activity the opening (= closing)
  // is still the pre-window control balance, never zero.
  const opening = p?.opening ?? (await preWindowBalance(opts.side, opts.from, partyId, orgId, opts.dims, opts.bookId, opts.canSeePayroll))
  return {
    party: { id: partyId, name: nameRow.rows[0]?.display_name ?? p?.partyName ?? null },
    side: opts.side,
    from: opts.from,
    to: opts.to,
    opening,
    closing: p?.closing ?? opening,
    lines: p?.lines ?? [],
    aging: agingTotals,
    truncated: reg.truncated,
  }
}

/** Pre-window control-account balance for one party — the same posted set the
 *  register's opening read uses, for statements with no window activity. */
async function preWindowBalance(
  side: AgingSide,
  from: string,
  partyId: string,
  orgId: string,
  dims: DimFilter | undefined,
  bookId?: string | null,
  canSeePayroll?: boolean,
): Promise<ExactDecimal> {
  const acctType = side === 'ap' ? 'liability_payable' : 'asset_receivable'
  // Restricted readers remap payroll-party lines to the unassigned section in
  // the register, so the same lines must not count toward this party's
  // fallback opening either — or the remap would leak through the balance.
  const payrollExclusion = canSeePayroll === true
    ? sql``
    : sql`and not ((d.kind = 'pay_run' or e.origin = 'payroll') and l.party_id is not null)`
  const rows = (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(l.amount), 0) as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where l.org_id = ${orgId} and e.org_id = ${orgId} and a.org_id = ${orgId}
       and e.status in ('posted', 'reversed') and a.type = ${acctType}
       and e.posting_date < ${from}
       and e.book_id = ${statementBookExpr(orgId, bookId)}
       and l.party_id = ${partyId}
       ${payrollExclusion}
       and ${dimWhere(dims, sql`l`)}
  `))
  return (rows.rows[0]?.balance ?? '0') as ExactDecimal
}
