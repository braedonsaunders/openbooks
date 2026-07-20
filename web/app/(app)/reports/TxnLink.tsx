'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { moduleDrawerHref } from '../../../lib/txn-links'

/**
 * Opens a report transaction in its REAL native flyout — never a reports-only
 * read-only overlay:
 *
 * - Source-document transactions (bill, invoice, payment, manual journal, …)
 *   open that record's native module drawer with the org's custom form applied
 *   (`/ap?doc=`, `/ar?doc=`, `/banking?doc=`, `/payments?payment=`,
 *   `/expenses?expense=`, `/journal?entry=`).
 * - System-generated GL entries with no document (depreciation, closing, fx)
 *   open in the Journal module's own ledger view (`/journal?txn=<entryId>`).
 */
export function TxnLink({
  entryId,
  docKind,
  docId,
  className,
  children,
}: {
  entryId: string
  docKind?: string | null
  docId?: string | null
  className?: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? '/'
  const current = useSearchParams()
  const inReport = pathname.startsWith('/reports') || pathname.startsWith('/knowledge/views')
  let href = moduleDrawerHref(docKind, docId) ?? `/journal?txn=${entryId}`
  if (inReport) {
    const params = new URLSearchParams(current.toString())
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
    href = `${pathname}?${params}`
  }
  return (
    <Link href={href as never} className={className} scroll={false}>
      {children}
    </Link>
  )
}
