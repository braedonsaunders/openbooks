'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

/**
 * Opens a journal entry as a flyout OVER the current report: appends
 * `?txn=<entryId>` to the current URL (the EntryFlyout mounted in the reports
 * layout reads it). Because it's an overlay, closing returns to the exact same
 * report + scroll, and the drill "back" chain is never hijacked.
 */
export function TxnLink({
  entryId,
  className,
  children,
}: {
  entryId: string
  className?: string
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const params = useSearchParams()
  const next = new URLSearchParams(params.toString())
  next.set('txn', entryId)
  return (
    <Link href={`${pathname}?${next.toString()}`} scroll={false} className={className}>
      {children}
    </Link>
  )
}
