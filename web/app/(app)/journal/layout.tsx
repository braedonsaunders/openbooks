import { Suspense } from 'react'
import { EntryFlyout } from '../reports/EntryFlyout'

/**
 * Journal layout. Mounts the shared entry flyout so a GL-native journal entry
 * (no source document — closing, depreciation, allocation, fx, …) opens as a
 * read-only drawer via `?txn=<entryId>` instead of the bare /journal/[id] page.
 * Manual journals still open the editable JournalDrawer via `?entry=<docId>`.
 */
export default function JournalLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Suspense fallback={null}>
        <EntryFlyout />
      </Suspense>
    </>
  )
}
