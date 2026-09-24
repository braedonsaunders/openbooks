'use client'

// Approval history sublist for the record flyout — the source platform "Workflow
// History" subtab, compacted into a collapsible "Approvals" section: one line
// per event (submitted / requested / approved / rejected / escalated /
// delegated) with an icon, the actor, relative time, and the comment or
// rejection reason. Renders nothing until the record has any approval
// history. Data comes from /api/flows/record-state via the shared
// useRecordApprovalState hook, so a decision made in the header refreshes
// this list too.

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Send,
  UserCheck,
  UserPlus,
  XCircle,
} from 'lucide-react'
import { Badge } from '@openbooks/ui'
import { useRecordApprovalState } from './approval-actions'
import type { ApprovalEventType } from '../app/api/flows/record-state/route'

const EVENT_ICON: Record<ApprovalEventType, React.ComponentType<{ className?: string }>> = {
  submitted: Send,
  requested: UserPlus,
  approved: CheckCircle2,
  rejected: XCircle,
  escalated: ArrowUpRight,
  delegated: UserCheck,
}

const EVENT_TONE: Record<ApprovalEventType, string> = {
  submitted: 'text-slate-500 dark:text-slate-400',
  requested: 'text-slate-500 dark:text-slate-400',
  approved: 'text-emerald-600 dark:text-emerald-400',
  rejected: 'text-red-600 dark:text-red-400',
  escalated: 'text-amber-600 dark:text-amber-400',
  delegated: 'text-slate-500 dark:text-slate-400',
}

const REL_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

function relativeTime(iso: string, locale: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  if (Number.isNaN(seconds)) return ''
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of REL_UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return rtf.format(Math.round(seconds), 'second')
}

export type ApprovalTabBodyKind = 'loading' | 'pending' | 'empty' | 'history' | 'unsubmitted'

/**
 * Which body the Approvals surface shows (F-t02-003: the tab rendered a
 * completely blank panel while loading and when no flow applied). History
 * wins over a concurrent pending gate; a pending flow with no events yet
 * still names who holds it. A record whose status still claims it awaits
 * approval, but which no flow run ever fired for (F-t04-004 residual:
 * pre-flow bank details), is neither history nor genuinely empty — it gets
 * its own body naming the stale state.
 */
export function approvalTabBody(state: {
  history: unknown[]
  approvalState: { pendingWith: unknown[]; status?: string }
  neverSubmitted?: boolean
} | null): ApprovalTabBodyKind {
  if (!state) return 'loading'
  if (state.history.length > 0) return 'history'
  if (state.approvalState.pendingWith.length > 0) return 'pending'
  if (state.neverSubmitted && state.approvalState.status === 'pending') return 'unsubmitted'
  return 'empty'
}

export function ApprovalHistory({
  subjectKind,
  subjectId,
  showEmptyState = false,
}: {
  subjectKind: string
  subjectId: string
  /**
   * Render loading / pending / empty bodies instead of nothing. Set for tab
   * surfaces (a blank tab looks broken); inline Details sections keep the
   * default so records without a flow stay compact.
   */
  showEmptyState?: boolean
}) {
  const t = useTranslations('common')
  const locale = useLocale()
  const { state, loadError } = useRecordApprovalState(subjectKind, subjectId)
  const [open, setOpen] = useState(true)

  const history = state?.history ?? []
  if (history.length === 0) {
    // A failed load is not an empty record (F1-11): name it instead of
    // vanishing (inline) or spinning forever (tab loading state).
    if (!state && loadError) {
      return (
        <p className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">
          {loadError}
        </p>
      )
    }
    if (!showEmptyState) return null
    const kind = approvalTabBody(state)
    if (kind === 'loading') {
      return (
        <div role="status" className="flex items-center gap-2 px-1 py-6 text-sm text-slate-500 dark:text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600 dark:border-slate-600 dark:border-t-teal-400" aria-hidden />
          {t('feedback.loading')}
        </div>
      )
    }
    if (kind === 'pending' && state) {
      const names = state.approvalState.pendingWith
        .map((entry) => entry.name)
        .filter((name) => name.length > 0)
        .join(', ')
      return (
        <p className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">
          {t('approvalFlow.pendingWith', { names: names || '—' })}
        </p>
      )
    }
    if (kind === 'unsubmitted') {
      return (
        <p className="px-1 py-6 text-sm text-slate-600 dark:text-slate-300">
          {t('approvalFlow.historyNeverSubmitted')}
        </p>
      )
    }
    return (
      <p className="px-1 py-6 text-sm text-slate-500 dark:text-slate-400">
        {t('approvalFlow.historyEmpty')}
      </p>
    )
  }

  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-slate-900 hover:bg-slate-50 dark:text-slate-100 dark:hover:bg-slate-800/60"
      >
        <Chevron className="h-4 w-4 text-slate-400" aria-hidden />
        {t('approvalFlow.historyTitle')}
        <span className="text-xs font-normal text-slate-400 dark:text-slate-500">
          {history.length}
        </span>
      </button>
      {open ? (
        <ol className="divide-y divide-slate-100 border-t border-slate-200 dark:divide-slate-800/60 dark:border-slate-800">
          {history.map((e) => {
            const Icon = EVENT_ICON[e.type] ?? Send
            return (
              <li key={e.id} className="flex items-start gap-2.5 px-3 py-2">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${EVENT_TONE[e.type] ?? ''}`} aria-hidden />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {t(`approvalFlow.events.${e.type}`)}
                    </span>
                    {e.actor ? (
                      <span className="text-slate-600 dark:text-slate-300">{e.actor}</span>
                    ) : null}
                    {e.title ? (
                      <span className="truncate text-xs text-slate-400 dark:text-slate-500">
                        {e.title}
                      </span>
                    ) : null}
                    {e.delegated ? (
                      <Badge variant="outline">{t('approvalFlow.badges.delegated')}</Badge>
                    ) : null}
                    {e.type === 'escalated' ? (
                      <Badge variant="warning">{t('approvalFlow.badges.escalated')}</Badge>
                    ) : null}
                    <span
                      className="ml-auto shrink-0 text-xs text-slate-400 dark:text-slate-500"
                      title={new Date(e.at).toLocaleString(locale)}
                    >
                      {relativeTime(e.at, locale)}
                    </span>
                  </div>
                  {e.comment ? (
                    <p
                      className={
                        'mt-0.5 text-xs ' +
                        (e.type === 'rejected'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-slate-500 dark:text-slate-400')
                      }
                    >
                      {e.comment}
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ol>
      ) : null}
    </section>
  )
}
