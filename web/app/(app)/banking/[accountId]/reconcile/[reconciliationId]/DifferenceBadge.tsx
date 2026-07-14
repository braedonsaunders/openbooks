import { cn } from '@openbooks/ui'
import { money } from '../../../../../../lib/format'

export const isZeroAmount = (v: string) => /^-?0(\.0+)?$/.test(v.trim())

/** The workspace's headline number: green only at exactly 0.00. */
export function DifferenceBadge({ difference, className }: { difference: string; className?: string }) {
  const zero = isZeroAmount(difference)
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-semibold tabular-nums',
        zero
          ? 'border-green-200/80 bg-green-50 text-green-800 dark:border-green-800/60 dark:bg-green-950/40 dark:text-green-300'
          : 'border-amber-200/80 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300',
        className,
      )}
    >
      {money(difference)}
    </span>
  )
}
