/**
 * Pre-save defaults in the document drawer, resolved by the server through
 * POST /api/documents/defaults (engine/src/ledger/document-defaults.ts).
 *
 * A defaulted field stays visible and editable. It keeps following its
 * source — the line's item, the party, the document date — only while the
 * operator has not changed it: a field follows when it is blank or still
 * holds the value the drawer last applied.
 */

export interface DefaultsLine {
  clientKey: string
  lineId: string
  itemId: string
  accountId: string
  taxProfileId: string
}

/** Server-resolved defaults for one item. */
export interface ResolvedLineDefault {
  itemId: string
  accountId: string | null
  taxCodeId: string | null
}

/** What the drawer last applied to a line, so later changes can tell an
 *  untouched default from an operator's choice. */
export interface AppliedLineDefault {
  itemId: string
  accountId: string
  taxProfileId: string
}

export interface LineDefaultsContext {
  /** Accounts the line picker offers; a default outside it is not applied. */
  accountIds: ReadonlySet<string>
  /** Tax profile values the picker offers (`code:<id>` / `group:<id>`). */
  taxProfileValues: ReadonlySet<string>
  /** False when the kind has no tax or tax resolves automatically. */
  applyTax: boolean
}

/**
 * Lines whose item was just chosen or changed. A line first seen with an item
 * is a request only when it is unsaved: persisted lines load with their saved
 * coding, which a redraw must never overwrite.
 */
export function itemChangeRequests(
  seen: ReadonlyMap<string, string>,
  rows: readonly DefaultsLine[],
): { requests: { clientKey: string; itemId: string }[]; seen: Map<string, string> } {
  const next = new Map<string, string>()
  const requests: { clientKey: string; itemId: string }[] = []
  for (const row of rows) {
    const before = seen.get(row.clientKey)
    next.set(row.clientKey, row.itemId)
    if (!row.itemId) continue
    if (before === undefined ? row.lineId === '' : before !== row.itemId) {
      requests.push({ clientKey: row.clientKey, itemId: row.itemId })
    }
  }
  return { requests, seen: next }
}

/**
 * Apply an item's defaults to a line. Account and tax each follow the
 * default while blank or still equal to the previously applied default; a
 * missing or unofferable default clears a following field rather than leave
 * the previous item's coding behind.
 */
export function applyLineDefault<R extends DefaultsLine>(
  row: R,
  resolved: ResolvedLineDefault,
  previous: AppliedLineDefault | undefined,
  ctx: LineDefaultsContext,
): { row: R; applied: AppliedLineDefault } {
  const follows = (value: string, applied: string | undefined) => value === '' || (applied !== undefined && value === applied)
  const account = resolved.accountId && ctx.accountIds.has(resolved.accountId) ? resolved.accountId : ''
  const taxValue = resolved.taxCodeId ? `code:${resolved.taxCodeId}` : ''
  const tax = taxValue && ctx.taxProfileValues.has(taxValue) ? taxValue : ''
  const next = { ...row }
  if (follows(row.accountId, previous?.accountId)) next.accountId = account
  if (ctx.applyTax && follows(row.taxProfileId, previous?.taxProfileId)) next.taxProfileId = tax
  return {
    row: next,
    applied: { itemId: resolved.itemId, accountId: next.accountId, taxProfileId: next.taxProfileId },
  }
}

/**
 * The due date after the party's terms resolve for the current party and
 * document date. `lastDerived` is the due date the drawer last derived; a due
 * date the operator typed (anything else, including an explicit clear) is
 * kept.
 */
export function followTermsDueDate(input: {
  dueDate: string
  overridden: boolean
  lastDerived: string | null
  derived: string | null
}): string {
  const { dueDate, overridden, lastDerived, derived } = input
  const following = !overridden || (lastDerived !== null && dueDate === lastDerived)
  if (!following) return dueDate
  if (derived !== null) return derived
  // The new party has no terms: drop only a due date the old terms implied.
  return lastDerived !== null && dueDate === lastDerived ? '' : dueDate
}
