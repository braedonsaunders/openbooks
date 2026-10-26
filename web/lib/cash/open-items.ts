import 'server-only'
import { sql } from 'drizzle-orm'
import { activePostingPrimaryBookId } from '@openbooks/engine/platform/database'
import { ambientTenantOrgId, pinnedTransactionExecutor } from '@openbooks/engine/platform/db'
import { analyticsQuery } from '../analytics/query'
import { mulDecimal } from '@openbooks/engine/money'
// Relative (not the bare workspace specifier): worktree node_modules resolves
// bare @openbooks/* to the main checkout, so a new engine module would not
// resolve until merge; a relative import binds this checkout everywhere.
import { AP_OPEN_ITEM_KINDS, AR_OPEN_ITEM_KINDS } from '@openbooks/engine/records/open-item-kinds'
import { datedAppliedAmountSql } from '@openbooks/engine/records/balance-due'
import { asOfPostedEntryLateral } from '@openbooks/engine/records/open-item-scopes'
import { lineFunctional, presentationCurrency, presentationRates } from '../fx-presentation'
import { apOpenAccountScope, arOpenAccountScope } from '../ledger-scope'
import { normalizeMoneyValue, parseISO, type OpenItem, type Side } from './core'

function subScope(col: ReturnType<typeof sql>, subIds?: string[]) {
  return subIds !== undefined
    ? sql` and ${col} = any(${`{${subIds.join(',')}}`}::uuid[])`
    : sql``
}

/**
 * Operational AR/AP items follow the document's posting AS OF the forecast
 * date, reconstructed from journal history (shared engine helper) — never
 * the live posted_entry_id/status, which a later correction or void would
 * rewrite. Reversed historical entries remain in the general ledger forever,
 * but must not become a second collectible/payable item after append-only
 * correction.
 */
interface OpenItemQueryRow extends Record<string, unknown> {
  id: string
  entry_id: string
  doc_id: string | null
  doc_kind: string | null
  doc_number: string | null
  party_id: string | null
  party_name: string
  tran_date: string
  due_date: string | null
  remaining: string
  func: string | null
}

/** Shared historical control-line population. Consumers aggregate in SQL
 * before transferring data; scope, reversals and dated applications remain
 * identical to the operational cash reader. */
export async function openItemSourceQuery(
  orgId: string,
  side: Side,
  asOf: string,
  subIds?: string[],
  partyId?: string,
) {
  const creditKind = side === 'ap' ? 'vendor_credit' : 'customer_credit'
  // Bills/invoices carry the side's normal sign; credit memos carry the
  // opposite sign on the same control account. Both are open items: an
  // unapplied credit is a negative payable/receivable that nets against the
  // party's bills (the aging report already nets it — the forecast must too,
  // or scheduled outflow overstates cash need).
  const lineFilter = side === 'ap'
    ? sql`((d.kind = ${creditKind} and jl.amount > 0) or (d.kind <> ${creditKind} and jl.amount < 0))`
    : sql`((d.kind = ${creditKind} and jl.amount < 0) or (d.kind <> ${creditKind} and jl.amount > 0))`
  // Population is the shared open-item kinds const — never a local list (P5.1:
  // a kind added here and not in the aging (or vice versa) silently un-ties
  // same-labeled AP/AR figures; the source-text guard forbids literals).
  const kinds = side === 'ap' ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS
  const kindFilter = sql`d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})`
  const bookId = await activePostingPrimaryBookId(orgId)
  // `remaining` reconstructs what was still collectible AS OF the forecast
  // date — gross line minus applications dated on/before it (an application
  // unapplied only after the date still counted then). Netting live
  // applications instead would let a later settlement rewrite a past forecast,
  // and gating on the live cached open_balance would hide documents settled
  // after the date that were open on it. The applied sum reads each leg
  // through its own carrying column (shared engine helper — never a bare
  // sum for both legs, which mixes denominations on cross-currency credits).
  // Both the result and its nonzero filter consume remaining. Materializing
  // the scoped rows evaluates the dated application sum once per control line.
  //
  // Only documents that can still be open on the date are reconstructed. A
  // line's as-of remaining differs from its live remaining (maintained in
  // open_item_balances) only through applications applied after the date or
  // unapplied at any time, so the candidates are the lines open today plus
  // the lines those applications touch, and the documents that own them.
  // Every other document's chosen entry nets to zero on the date.
  return sql`
    with candidate_lines as materialized (
      select b.line_id from open_item_balances b where b.org_id = ${orgId} and b.is_open
      union
      select x.from_line_id from applications x
       where x.org_id = ${orgId} and x.unapplied_at is null and x.applied_on > ${asOf}
      union
      select x.to_line_id from applications x
       where x.org_id = ${orgId} and x.unapplied_at is null and x.applied_on > ${asOf}
      union
      select x.from_line_id from applications x
       where x.org_id = ${orgId} and x.unapplied_at is not null and x.unapplied_at::date > ${asOf}::date
      union
      select x.to_line_id from applications x
       where x.org_id = ${orgId} and x.unapplied_at is not null and x.unapplied_at::date > ${asOf}::date
    ),
    -- A candidate line counts only on an entry that can be in effect on the
    -- date — the same eligibility the as-of entry choice applies — so lines
    -- left open on entries reversed by then never widen the reconstruction.
    candidate_entries as materialized (
      select distinct cl.entry_id as id
        from candidate_lines c
        join journal_lines cl on cl.id = c.line_id and cl.org_id = ${orgId}
        join journal_entries je on je.id = cl.entry_id and je.org_id = cl.org_id
       where je.status in ('posted', 'reversed')
         and je.reverses_entry_id is null
         and je.posting_date <= ${asOf}
         and not exists (
           select 1 from journal_entries r
            where r.org_id = ${orgId} and r.reverses_entry_id = je.id and r.posting_date <= ${asOf}
         )
    ),
    candidate_docs as materialized (
      select je.source_document_id as id
        from candidate_entries ce
        join journal_entries je on je.id = ce.id and je.org_id = ${orgId}
       where je.source_document_id is not null
      union
      select d.id
        from candidate_entries ce
        join documents d on d.posted_entry_id = ce.id and d.org_id = ${orgId}
    ),
    oi as materialized (
      select jl.id, jl.party_id, jl.entry_id, je.posting_date as tran_date, jl.due_date,
             d.id as doc_id, d.kind as doc_kind, d.document_number as doc_number,
             sub.base_currency as func,
             (case when d.kind = ${creditKind} then -1 else 1 end) * (abs(jl.amount) - ${datedAppliedAmountSql(orgId, sql`jl.id`, asOf)}) as remaining
        from documents d
        ${asOfPostedEntryLateral(orgId, asOf)}
        join journal_entries book_entry on book_entry.id = je.id and book_entry.org_id = je.org_id and book_entry.book_id = ${bookId}
        join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and ${lineFilter}
        join accounts a on a.id = jl.account_id and a.org_id = ${orgId}
         and ${side === 'ap' ? apOpenAccountScope(sql`a`, orgId) : arOpenAccountScope(sql`a`)}
        left join subsidiaries sub on sub.id = jl.subsidiary_id and sub.org_id = ${orgId}
       where d.org_id = ${orgId}
         and d.id in (select id from candidate_docs)
         and (d.status = 'posted' or (d.voided_at is not null and d.voided_at::date > ${asOf}::date))
         and ${kindFilter}
         ${subScope(sql`jl.subsidiary_id`, subIds)}
         ${partyId === undefined ? sql`` : sql`and jl.party_id = ${partyId}`}
    )
    select oi.id, oi.entry_id, oi.doc_id, oi.doc_kind, oi.doc_number, oi.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           oi.tran_date, oi.due_date, oi.remaining, oi.func
      from oi
      left join parties p on p.id = oi.party_id and p.org_id = ${orgId}
     where oi.remaining <> 0
  `
}

/**
 * Identical reads already in flight share one execution. Every tile, cockpit
 * and forecast that opens at once asks for the same population; running each
 * copy separately makes them contend for the same pages until all of them
 * time out. Only in-flight work is shared: a call that starts after the
 * shared read settles runs fresh, so nothing is served from a stale result.
 * The key carries every argument that shapes the rows — organization,
 * side, as-of date, subsidiary scope and party — plus the caller's tenant
 * context, so a read never answers for a different tenant or authorization
 * scope. Reads inside a transaction never share: they must see that
 * transaction's own writes.
 */
const inFlight = new Map<string, Promise<OpenItem[]>>()

export function openItems(
  orgId: string,
  side: Side,
  asOf: string,
  subIds?: string[],
  partyId?: string,
): Promise<OpenItem[]> {
  if (pinnedTransactionExecutor()) return readOpenItems(orgId, side, asOf, subIds, partyId)
  const key = JSON.stringify([ambientTenantOrgId(), orgId, side, asOf, subIds ? [...subIds].sort() : null, partyId ?? null])
  let read = inFlight.get(key)
  if (!read) {
    read = readOpenItems(orgId, side, asOf, subIds, partyId).finally(() => inFlight.delete(key))
    inFlight.set(key, read)
  }
  // Each caller owns its rows: forecasts annotate and reorder them.
  return read.then((items) => items.map((item) => ({ ...item })))
}

async function readOpenItems(
  orgId: string,
  side: Side,
  asOf: string,
  subIds?: string[],
  partyId?: string,
): Promise<OpenItem[]> {
  const result = await analyticsQuery<OpenItemQueryRow>(await openItemSourceQuery(orgId, side, asOf, subIds, partyId))
  // `remaining` nets in the line entity's functional currency (legs are
  // stamped functional; the shared leg-split helper reads the target leg in
  // amount and the consumed leg in source_amount, and the sign filter keeps
  // only target-side control lines). A consolidated view spans
  // functionals, so each item translates to the presentation currency at the
  // closing spot — raw functionals would mix subsidiary currencies. One rate
  // lookup per functional in view; missing coverage fails closed.
  const rows = result.rows
  const base = await presentationCurrency(orgId)
  const rates = await presentationRates(orgId, base, rows.map((row) => row.func ?? null), asOf)
  return rows.map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    docKind: row.doc_kind ?? null,
    docNumber: row.doc_number ?? null,
    docId: row.doc_id ?? null,
    partyId: row.party_id,
    partyName: row.party_name,
    tranDate: parseISO(row.tran_date),
    dueDate: row.due_date ? parseISO(row.due_date) : null,
    // PostgreSQL numeric values are returned as decimal text. Keep that text
    // exact at the boundary; converting to Number would round valid
    // numeric(19,4) balances before the forecast has a chance to aggregate
    // them.
    remaining: normalizeMoneyValue(mulDecimal(String(row.remaining), rates.get(lineFunctional(row.func ?? null, base))!)),
  }))
}
