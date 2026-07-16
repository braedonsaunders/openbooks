// Where each source-document kind lives, so a report can open a transaction in
// its REAL native view/edit drawer (with the org's custom form applied) instead
// of a generic read-only flyout. The module list pages read these params and
// mount their own document/journal drawer.

const DOC_MODULE: Record<string, { path: string; param: string }> = {
  vendor_bill: { path: '/ap', param: 'doc' },
  vendor_credit: { path: '/ap', param: 'doc' },
  customer_invoice: { path: '/ar', param: 'doc' },
  customer_credit: { path: '/ar', param: 'doc' },
  card_charge: { path: '/banking', param: 'doc' },
  card_refund: { path: '/banking', param: 'doc' },
  check: { path: '/banking', param: 'doc' },
  transfer: { path: '/banking', param: 'doc' },
  vendor_payment: { path: '/payments', param: 'payment' },
  customer_payment: { path: '/payments', param: 'payment' },
  expense_report: { path: '/expenses', param: 'expense' },
  journal: { path: '/journal', param: 'entry' },
}

/**
 * The URL that opens a transaction's native module drawer, or null when the
 * entry has no source document (system-generated GL entries — depreciation,
 * closing, fx revaluation — which only have the read-only ledger flyout).
 */
export function moduleDrawerHref(docKind: string | null | undefined, docId: string | null | undefined): string | null {
  if (!docKind || !docId) return null
  const m = DOC_MODULE[docKind]
  return m ? `${m.path}?${m.param}=${docId}` : null
}
