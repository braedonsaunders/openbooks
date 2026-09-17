import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import { StartCloseButton } from './StartCloseButton'

/**
 * Composite cells in the period close list.
 *
 * Each of these is more than one element — a single-book pill with two spans,
 * a readiness bar beside its percentage, and the resume-link / start-button /
 * em-dash triple — so each is a component rather than block vocabulary. The
 * native page imports them from here so the page and the widget registry share one
 * implementation and cannot drift.
 */

/** The single-book pill shown when the org has at most one active book. */
export function SingleBookLabel({ label, name }: { label: string; name: string }) {
  return (
    <div className="inline-flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
      <span className="text-slate-500 dark:text-slate-400">{label}:</span>
      <span className="truncate font-semibold">{name}</span>
    </div>
  )
}

/** The readiness bar beside its percentage. */
export function CloseReadinessCell({ readiness }: { readiness: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className="h-full bg-teal-500" style={{ width: `${readiness}%` }} />
      </div>
      <span className="text-xs tabular-nums text-slate-500">{readiness}%</span>
    </div>
  )
}

/**
 * The run badge with the enforcement truth beneath it: when the selected
 * book holds closed locks for the period — with or without a run — the lock
 * line names exactly which modules on which book are locked (F-t02-005). The
 * LOADER resolves both strings; the component only stacks them.
 */
export function CloseStatusCell({
  statusLabel,
  statusVariant,
  lockLabel,
}: {
  statusLabel: string
  statusVariant: 'success' | 'warning' | 'outline'
  lockLabel: string | null
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant={statusVariant}>{statusLabel}</Badge>
      {lockLabel ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">{lockLabel}</span>
      ) : null}
    </div>
  )
}

/**
 * The action cell's conditional triple: a resume link when a run exists, the
 * start control when the reader may start one, an em-dash otherwise. The
 * LOADER decides which of the three applies; the component only renders the
 * decision it is given.
 */
export function CloseActionCell({
  actionHref,
  actionLabel,
  actionLinkClassName,
  canStart,
  startPeriodId,
  startBooks,
  startDefaultBookId,
}: {
  actionHref: string | null
  actionLabel: string
  actionLinkClassName: string
  canStart: boolean
  startPeriodId: string
  startBooks: { id: string; name: string }[]
  startDefaultBookId: string
}) {
  if (actionHref) {
    return (
      <Link className={actionLinkClassName} href={actionHref as never}>
        {actionLabel}
      </Link>
    )
  }
  if (canStart) {
    return (
      <StartCloseButton
        periodId={startPeriodId}
        books={startBooks}
        defaultBookId={startDefaultBookId}
      />
    )
  }
  return <>—</>
}
