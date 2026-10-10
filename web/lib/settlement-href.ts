import { canonicalDecimal, compareDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'

/**
 * Where a party or open document is settled: the new customer receipt
 * (Receive payment) or the new vendor payment (Pay bills), opened for the
 * party and, when given, preselecting that document's open items. The
 * payment drawer re-validates both ids against the caller's own party list
 * and the party's open items, so the link carries no authority of its own.
 */
export function settlementHrefFor(side: 'ar' | 'ap', partyId: string, documentId?: string): string {
  const params = new URLSearchParams({ paymentNew: '1', mode: 'edit', partyId })
  if (documentId) params.set('applyTo', documentId)
  return `${side === 'ar' ? '/receipts' : '/payments'}?${params.toString()}`
}

/**
 * Settlement link for an open document drawer: a posted customer invoice or
 * vendor bill with a party and a positive open balance, for a user holding
 * the payment permission of its side. Null otherwise.
 */
export function documentSettlementHref(
  doc: Record<string, unknown> | null | undefined,
  canPay: { ar: boolean; ap: boolean },
): string | null {
  if (!doc || doc.status !== 'posted' || typeof doc.party_id !== 'string' || typeof doc.id !== 'string') return null
  const side = doc.kind === 'customer_invoice' ? 'ar' : doc.kind === 'vendor_bill' ? 'ap' : null
  if (!side || !canPay[side]) return null
  const open = doc.open_balance == null ? null : canonicalDecimal(String(doc.open_balance), 4)
  if (open === null || compareDecimal(open, '0') <= 0) return null
  return settlementHrefFor(side, doc.party_id, doc.id)
}
