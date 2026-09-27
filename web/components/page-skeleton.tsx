import { Skeleton } from '@openbooks/ui'

/**
 * In-shell content placeholder. The app shell (sidebar/header) stays mounted
 * while a page streams, so this mirrors the shared page chrome instead of
 * replaying the brand splash: a sticky header block (title + actions row,
 * then a chips/strip row) over a body block (table-like rows). Both
 * ListPageLayout and DetailPageLayout share that outer shape — a bordered
 * header with a max-w-screen-2xl column over a scrolling body column — so one
 * placeholder reads correctly under either while the real page loads.
 *
 * Decorative only: hidden from assistive technology, since the loaded page
 * announces itself when it arrives.
 */
export function PageSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="border-b border-slate-200 bg-white px-3 pt-3 pb-2.5 sm:px-6 sm:pt-4 sm:pb-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto max-w-screen-2xl space-y-2 sm:space-y-2.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-48" />
            <div className="flex-1" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-6 w-16" />
          </div>
        </div>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-screen-2xl space-y-2 p-3 sm:p-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      </div>
    </div>
  )
}
