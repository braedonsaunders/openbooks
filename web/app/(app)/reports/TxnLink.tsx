'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { moduleDrawerHref } from '../../../lib/txn-links'

/**
 * Opens a transaction in its REAL native flyout — never a read-only overlay,
 * and never by navigating away from the page you're on:
 *
 * - Source-document transactions (bill, invoice, payment, manual journal, …)
 *   stay on the CURRENT page and open the record's native drawer over it via
 *   the shell-level GlobalReportDrawerHost (?reportRecord= / ?reportRecordKind=
 *   with the org's custom form applied). This works everywhere — reports,
 *   analytics drills, the cash/AP/AR cockpit flyouts.
 * - System-generated GL entries with no document (depreciation, closing, fx)
 *   open the read-only EntryFlyout in place on report surfaces (where it is
 *   mounted); elsewhere they fall back to the Journal module's ledger view
 *   (`/journal?txn=<entryId>`).
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
  const hasDoc = !!(docKind && docId)
  let href = moduleDrawerHref(docKind, docId) ?? `/journal?txn=${entryId}`
  if (hasDoc || inReport) {
    const params = new URLSearchParams(current.toString())
    params.delete('reportRecord')
    params.delete('reportRecordKind')
    params.delete('txn')
    params.delete('drawerReturn')
    params.delete('form')
    params.delete('transactionTab')
    const baseQuery = params.toString()
    const returnHref = baseQuery ? `${pathname}?${baseQuery}` : pathname
    if (hasDoc) {
      params.set('reportRecord', docId!)
      params.set('reportRecordKind', docKind!)
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
