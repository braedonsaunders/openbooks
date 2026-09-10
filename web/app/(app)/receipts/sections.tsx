import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * The receipts/collections pill switch. Deliberately NOT the payments one:
 * this variant carries no hover treatment and no transition class, and the
 * conformance harness compares class strings exactly.
 */
export function ReceiptsViewTabs({
  view,
  labels,
}: {
  view: 'receipts' | 'runs'
  labels: { receipts: string; collections: string }
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link
        href="/receipts"
        className={cn(
          'rounded-md px-3 py-1.5 text-sm font-medium',
          view === 'receipts'
            ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
            : 'text-slate-600 dark:text-slate-300',
        )}
      >
        {labels.receipts}
      </Link>
      <Link
        href={('/receipts?view=runs')}
        className={cn(
          'rounded-md px-3 py-1.5 text-sm font-medium',
          view === 'runs'
            ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
            : 'text-slate-600 dark:text-slate-300',
        )}
      >
        {labels.collections}
      </Link>
    </div>
  )
}
