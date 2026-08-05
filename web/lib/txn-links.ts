// Where each source-document kind lives, so a report can open a transaction in
// its REAL native view/edit drawer (with the org's custom form applied) instead
// of a generic read-only flyout. The module list pages read these params and
// mount their own document/journal drawer.

const DOC_MODULE: Record<string, { path: string; param: string }> = {
  vendor_bill: { path: '/ap', param: 'doc' },
  vendor_credit: { path: '/ap', param: 'doc' },
  customer_invoice: { path: '/ar', param: 'doc' },
  customer_credit: { path: '/ar', param: 'doc' },
  card_charge: { path: '/banking/transactions', param: 'doc' },
  card_refund: { path: '/banking/transactions', param: 'doc' },
  check: { path: '/banking/transactions', param: 'doc' },
  deposit: { path: '/banking/transactions', param: 'doc' },
  transfer: { path: '/banking/transactions', param: 'doc' },
  vendor_payment: { path: '/payments', param: 'payment' },
  customer_payment: { path: '/payments', param: 'payment' },
  expense_report: { path: '/expenses/reports', param: 'expense' },
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

/**
 * Builds the app-wide, in-context drawer URL for a posted GL entry. Source
 * documents open their native drawer; GL-only entries open the ledger drawer.
 */
export function transactionDrawerHref({
  pathname,
  query,
  entryId,
  docKind,
  docId,
}: {
  pathname: string
  query: string
  entryId: string
  docKind?: string | null
  docId?: string | null
}) {
  const params = new URLSearchParams(query)
  params.delete('reportRecord')
  params.delete('reportRecordKind')
  params.delete('txn')
  params.delete('drawerReturn')
  params.delete('form')
  params.delete('transactionTab')
  const baseQuery = params.toString()
  const returnHref = baseQuery ? `${pathname}?${baseQuery}` : pathname
  if (docKind && docId) {
    params.set('reportRecord', docId)
    params.set('reportRecordKind', docKind)
    params.set('drawerReturn', returnHref)
  } else {
    params.set('txn', entryId)
  }
  return `${pathname}?${params}`
}
