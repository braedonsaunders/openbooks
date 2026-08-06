'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button, Drawer } from '@openbooks/ui'
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
  const [open, setOpen] = useState(false)
  const [schedules, setSchedules] = useState<ScheduleRow[] | null>(null)
  const [canSchedule, setCanSchedule] = useState(false)

  const refetch = useCallback(async () => {
    const res = await fetch(`/api/reports/schedules?definitionId=${definitionId}`, { cache: 'no-store' })
    if (!res.ok) return
    const data = await res.json()
    setSchedules(data.schedules ?? [])
    setCanSchedule(Boolean(data.canSchedule))
  }, [definitionId])

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
        onClose={() => setOpen(false)}
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
        {schedules === null ? (
          <p className="py-8 text-center text-sm text-slate-400">{t('loading')}</p>
        ) : (
          <ScheduleEditor
            definitionId={definitionId}
            schedules={schedules}
            canSchedule={canSchedule}
            statementParams={statementParams}
            onChanged={refetch}
          />
        )}
      </Drawer>
    </>
  )
}
