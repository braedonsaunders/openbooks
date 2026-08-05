'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { transactionDrawerHref } from '../../../lib/txn-links'

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
 *   open the read-only EntryFlyout in place.
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
  const href = transactionDrawerHref({
    pathname,
    query: current.toString(),
    entryId,
    docKind,
    docId,
  })
  return (
    <Link href={href as never} className={className} scroll={false}>
      {children}
    </Link>
  )
}
