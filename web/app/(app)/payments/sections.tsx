import Link from 'next/link'
import { cn } from '@openbooks/ui'

/**
 * The payments/runs pill switch. A tab whose treatment changes when it is the
 * active one is a conditional pair, so it is a component and the loader
 * decides which is active.
 */
export function ViewTabs({
  view,
  labels,
}: {
  view: 'payments' | 'runs'
  labels: { payments: string; runs: string }
}) {
  const tab = (active: boolean) =>
    cn(
      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
      active
        ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
        : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
    )
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
      <Link href="/payments" className={tab(view === 'payments')}>
        {labels.payments}
      </Link>
      <Link href={('/payments?view=runs')} className={tab(view === 'runs')}>
        {labels.runs}
      </Link>
    </div>
  )
}
