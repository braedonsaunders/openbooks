'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Drawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'
import { useDirtyClose } from '../../../lib/use-dirty-close'
import { ScheduleEditor, type ScheduleRow } from './ScheduleEditor'

/**
 * THE schedule affordance for every report page — statement or query alike.
 * One outline button in the ReportFilterBar actions row opens a drawer with
 * the shared ScheduleEditor over the report's definition. Self-fetching, so a
 * page only needs the definition id (and, for statement pages, the current
 * URL params to snapshot onto new schedules).
 */
export function ScheduleReportButton({
  definitionId,
  statementParams,
  historyHref,
}: {
  definitionId: string
  /** Statement pages pass their current filters; stored on the schedule and
   *  applied at render time so the emailed report matches what was on screen. */
  statementParams?: Record<string, string>
  /** Query reports link their recorded-run history page from the drawer. */
  historyHref?: string
}) {
  const t = useTranslations('reports.schedule')
  const tk = useTranslations('reports.custom.runner')
  const tc = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null)
  const [canSchedule, setCanSchedule] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draftDirty, setDraftDirty] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const closeDrawer = useCallback(() => {
    setOpen(false)
    setDraftDirty(false)
    setDraftBusy(false)
  }, [])
  const { close, beforeClose } = useDirtyClose({
    dirty: draftDirty,
    busy: draftBusy,
    onClose: closeDrawer,
    message: tc('feedback.unsavedChanges'),
    confirmLabel: tc('confirm.discardChanges'),
  })

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body — the previous refusal
  // clears once the reload answers, so opening the drawer never cascades.
  const refetch = useCallback(() => {
    return fetch(`/api/reports/schedules?definitionId=${definitionId}`, { cache: 'no-store' })
      .then(async (res) => {
        setLoadError(null)
        // The status is checked before the body is parsed. A refusal leaves
        // the drawer in a named error state with a retry — never stuck on
        // Loading with the failure swallowed.
        if (!res.ok) throw new Error(await readApiErrorMessage(res, tc('feedback.loadFailed')))
        const data = (await res.json().catch(() => null)) as {
          schedules?: unknown
          canSchedule?: unknown
        } | null
        if (!data || !Array.isArray(data.schedules)) throw new Error(tc('feedback.loadFailed'))
        setSchedules(data.schedules as ScheduleRow[])
        setCanSchedule(Boolean(data.canSchedule))
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error && error.message ? error.message : tc('feedback.loadFailed'))
      })
  }, [definitionId, tc])

  useEffect(() => {
    if (open && schedules === null) void refetch()
  }, [open, schedules, refetch])

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <CalendarClock size={14} /> {tk('scheduledDelivery')}
      </Button>
      <Drawer
        open={open}
        onClose={close}
        title={tk('scheduledDelivery')}
        description={t('drawerDescription')}
        size="lg"
        footer={historyHref ? (
          <Link
            href={historyHref as never}
            className="text-sm text-teal-700 hover:underline dark:text-teal-300"
          >
            {tk('recentRuns')} →
          </Link>
        ) : undefined}
      >
        {open && loadError ? (
          <div className="py-8 text-center">
            <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>
              {tc('actions.retry')}
            </Button>
          </div>
        ) : open && schedules === null ? (
          <p className="py-8 text-center text-sm text-slate-400">{t('loading')}</p>
        ) : open && Array.isArray(schedules) ? (
          <ScheduleEditor
            definitionId={definitionId}
            schedules={schedules}
            canSchedule={canSchedule}
            statementParams={statementParams}
            onChanged={refetch}
            onDraftStateChange={({ dirty, busy }) => { setDraftDirty(dirty); setDraftBusy(busy) }}
            beforeDiscardDraft={beforeClose}
          />
        ) : null}
      </Drawer>
    </>
  )
}
