import { Suspense } from 'react'
import { EntryFlyout } from './EntryFlyout'

/**
 * Reports layout. Mounts the shared transaction flyout once for the whole
 * reports area, so any report can open a journal entry as a right-side drawer
 * via `?txn=<entryId>` (see TxnLink / EntryFlyout) without a full-page nav.
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <EntryFlyout />
      </Suspense>
    </>
  )
}
