import { Badge } from '@openbooks/ui'

/**
 * One pack's last-run cell for the Agents overview table: the run-status
 * badge with the relative run instant on line one, the scheduled next run
 * muted on line two. Every string is loader-resolved (relative instants via
 * `Intl.RelativeTimeFormat`, absolute dates via the shared `dateTime`).
 */
export function AgentsLastRunCell({
  hasRun,
  statusLabel,
  statusVariant,
  dateLine,
  nextLine,
}: {
  hasRun: boolean
  statusLabel: string
  statusVariant: 'success' | 'destructive' | 'secondary' | 'outline'
  dateLine: string
  nextLine: string | null
}) {
  if (!hasRun) {
    return (
      <span className="block text-sm text-slate-500 dark:text-slate-400">
        {dateLine}
        {nextLine ? <span className="mt-0.5 block text-xs">{nextLine}</span> : null}
      </span>
    )
  }
  return (
    <span className="block">
      <Badge variant={statusVariant}>{statusLabel}</Badge>
      <span className="mt-1 block text-sm whitespace-nowrap text-slate-700 dark:text-slate-200">{dateLine}</span>
      {nextLine ? (
        <span className="mt-0.5 block text-xs whitespace-nowrap text-slate-500 dark:text-slate-400">{nextLine}</span>
      ) : null}
    </span>
  )
}
