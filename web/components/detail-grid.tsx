import { cn } from '@openbooks/ui'

/**
 * Two-column key/value grid for record detail headers.
 */
export function DetailGrid({
  rows,
  className,
}: {
  rows: { label: string; value: React.ReactNode }[]
  className?: string
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-900',
        className,
      )}
    >
      {rows.map((row, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <dt className="text-xs tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {row.label}
          </dt>
          <dd className="text-slate-900 dark:text-slate-100">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}
