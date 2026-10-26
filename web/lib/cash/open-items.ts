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
import { openItemsAsOfSql } from '@openbooks/engine/records/open-item-scopes'
import { lineFunctional, presentationCurrency, presentationRates } from '../fx-presentation'
import { apOpenAccountScope, arOpenAccountScope } from '../ledger-scope'
import { normalizeMoneyValue, parseISO, type OpenItem, type Side } from './core'

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
  // Bills/invoices carry the side's normal sign; credit memos carry the
  // opposite sign on the same control account. Both are open items: an
  // unapplied credit is a negative payable/receivable that nets against the
  // party's bills (the aging report already nets it — the forecast must too,
  // or scheduled outflow overstates cash need). Population is the shared
  // open-item kinds const, never a local list, so the aging and these
  // figures tie.
  //
  // `remaining` is what was still collectible AS OF the forecast date: a
  // later settlement must not rewrite a past forecast, and a document
  // settled after the date was open on it. The open-item index answers that
  // from the lines open today plus the lines later applications touched.
  const items = openItemsAsOfSql({
    orgId,
    asOf,
    bookId: await activePostingPrimaryBookId(orgId),
    accounts: side === 'ap' ? apOpenAccountScope(sql`a`, orgId) : arOpenAccountScope(sql`a`),
    kinds: side === 'ap' ? AP_OPEN_ITEM_KINDS : AR_OPEN_ITEM_KINDS,
    creditKind: side === 'ap' ? 'vendor_credit' : 'customer_credit',
    normalSign: side === 'ap' ? 'credit' : 'debit',
    subsidiaryIds: subIds,
    partyId,
  })
  return sql`
    with oi as materialized (${items})
    select oi.id, oi.entry_id, oi.doc_id, oi.doc_kind, oi.doc_number, oi.party_id,
           coalesce(p.display_name, 'Unspecified') as party_name,
           oi.tran_date, oi.due_date, oi.remaining, sub.base_currency as func
      from oi
      left join parties p on p.id = oi.party_id and p.org_id = ${orgId}
      left join subsidiaries sub on sub.id = oi.subsidiary_id and sub.org_id = ${orgId}
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
