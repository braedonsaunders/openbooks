'use client'

import Link from 'next/link'
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
  const href = moduleDrawerHref(docKind, docId) ?? `/journal?txn=${entryId}`
  return (
    <Link href={href as never} className={className}>
      {children}
    </Link>
  )
}
