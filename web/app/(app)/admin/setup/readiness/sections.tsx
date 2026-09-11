import Link from 'next/link'
import { CheckCircle2, CircleAlert, CircleDashed, Sparkles } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@openbooks/ui'

/**
 * Composite cells in the setup readiness guide.
 *
 * Two of these are genuinely more than one element, so each is a component
 * rather than block vocabulary:
 *
 * - `SetupReadinessHero` — the icon tile, kicker, title, description, badge
 *   AND the progress bar. The progress label, bar segments and counts are all
 *   loader-formatted data; the component only binds them.
 * - `SetupReadinessCheckCard` — the state icon tile, index, title,
 *   description and action link. The conditional pair (which icon, which
 *   wrapper classes) is the loader's `state` field, resolved to a closed
 *   vocabulary the component switches on — never spec branching.
 *
 * The native page imports them from here so the page and the widget registry share one
 * implementation and cannot drift.
 */

export type SetupReadinessCheckState = 'complete' | 'review' | 'waiting'

export interface SetupReadinessCheck {
  indexLabel: string
  title: string
  description: string
  href: string
  action: string
  state: SetupReadinessCheckState
  stateLabel: string
}

const STATE_ICON = {
  complete: CheckCircle2,
  review: CircleAlert,
  waiting: CircleDashed,
} as const

const STATE_TILE_CLASS = {
  complete: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950',
  review: 'bg-amber-100 text-amber-700 dark:bg-amber-950',
  waiting: 'bg-slate-100 text-slate-500 dark:bg-slate-800',
} as const

/** The hero card: go-live guide header, foundation badge, and progress bar. */
export function SetupReadinessHero({
  kicker,
  title,
  description,
  badgeLabel,
  badgeReady,
  progressLabel,
  progressCount,
  progressTotal,
  progressPercent,
  progressMin,
  progressMax,
  progressNow,
}: {
  kicker: string
  title: string
  description: string
  badgeLabel: string
  badgeReady: boolean
  progressLabel: string
  progressCount: number
  progressTotal: number
  progressPercent: number
  progressMin: number
  progressMax: number
  progressNow: number
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="space-y-5 p-6 sm:p-7">
        <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="flex min-w-0 items-start gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
              <Sparkles size={20} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">{kicker}</p>
              <CardTitle className="mt-1 text-xl">{title}</CardTitle>
              <CardDescription className="mt-2 max-w-2xl leading-relaxed">{description}</CardDescription>
            </div>
          </div>
          <Badge variant={badgeReady ? 'success' : 'warning'} className="shrink-0 self-start">
            {badgeLabel}
          </Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-slate-700 dark:text-slate-200">{progressLabel}</span>
            <span className="tabular-nums text-slate-500 dark:text-slate-400">
              {progressCount} of {progressTotal} areas prepared
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
            role="progressbar"
            aria-label={progressLabel}
            aria-valuemin={progressMin}
            aria-valuemax={progressMax}
            aria-valuenow={progressNow}
          >
            <div className="h-full rounded-full bg-teal-600 transition-[width]" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </CardHeader>
    </Card>
  )
}

/**
 * One readiness check card: state icon, index, title, description, action.
 * Flat props so the spec threads per-item field refs straight through — the
 * same threading the admin hub cards use.
 */
export function SetupReadinessCheckCard(check: SetupReadinessCheck) {
  const Icon = STATE_ICON[check.state]
  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-4">
          <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${STATE_TILE_CLASS[check.state]}`}>
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-400">{check.indexLabel}</span>
              <CardTitle className="text-base">{check.title}</CardTitle>
            </div>
            <CardDescription className="mt-1">{check.description}</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href={check.href as never}>{check.action}</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="sr-only">{check.stateLabel}</CardContent>
    </Card>
  )
}
