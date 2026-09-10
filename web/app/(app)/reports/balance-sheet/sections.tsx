import { Badge } from '@openbooks/ui'

/**
 * The accounting-equation check under the filter bar.
 *
 * A conditional pair — "Balanced" in green or "Off by <amount>" in red — so
 * the LOADER decides which, and this renders the decision it is given.
 */
export function BalanceCheck({
  equation,
  balanced,
  label,
}: {
  equation: string
  balanced: boolean
  label: string
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>{equation}</span>
      <Badge variant={balanced ? 'success' : 'destructive'}>{label}</Badge>
    </div>
  )
}
