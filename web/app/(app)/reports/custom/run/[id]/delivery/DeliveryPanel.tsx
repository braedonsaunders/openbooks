'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Play } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button } from '@openbooks/ui'
import { ScheduleEditor, type ScheduleRow } from '../../../../ScheduleEditor'

type RunRow = {
  id: string
  trigger: string
  status: string
  error: string | null
  row_count: number | null
  started_at: string | null
  finished_at: string | null
  artifact_available: boolean
  delivery_total: number
  delivery_sent: number
  delivery_failed: number
  delivery_suppressed: number
}

const RUN_VARIANT: Record<string, 'success' | 'warning' | 'secondary' | 'outline'> = {
  succeeded: 'success',
  running: 'warning',
  queued: 'secondary',
  failed: 'outline',
}

// Message keys under reports.custom.runner — unknown enum values render verbatim.
const RUN_STATUS_KEY: Record<string, string> = {
  succeeded: 'status.succeeded',
  running: 'status.running',
  queued: 'status.queued',
  failed: 'status.failed',
}
const RUN_TRIGGER_KEY: Record<string, string> = {
  manual: 'trigger.manual',
  scheduled: 'trigger.scheduled',
}

/** Schedules + recorded run history for one definition (management surface). */
export function DeliveryPanel({
  definitionId,
  schedules,
  recentRuns,
  canSchedule,
}: {
  definitionId: string
  schedules: ScheduleRow[]
  recentRuns: RunRow[]
  canSchedule: boolean
}) {
  const t = useTranslations('reports.custom.runner')
  const tk = useTranslations('reports.custom')
  const tc = useTranslations('common')
  const router = useRouter()
  const [running, setRunning] = useState(false)

  // Records a run row + CSV artifact — the report screen itself never does.
  async function runNow() {
    setRunning(true)
    const res = await fetch('/api/reports/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definitionId }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('runFailed'))
    else toast.success(t('runComplete'))
    setRunning(false)
    router.refresh()
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('scheduledDelivery')}</h2>
        <ScheduleEditor
          definitionId={definitionId}
          schedules={schedules}
          canSchedule={canSchedule}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('recentRuns')}</h2>
          <Button size="sm" variant="outline" disabled={running} onClick={runNow}>
            <Play size={15} /> {running ? tk('running') : t('runNow')}
          </Button>
        </div>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('emptyHint')}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-medium">{tc('labels.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('columns.trigger')}</th>
                  <th className="px-3 py-2 font-medium">{t('columns.rows')}</th>
                  <th className="px-3 py-2 font-medium">{t('columns.finished')}</th>
                  <th className="px-3 py-2 font-medium">{t('columns.delivery')}</th>
                  <th className="px-3 py-2 font-medium">{tc('actions.download')}</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-2">
                      <Badge variant={RUN_VARIANT[run.status] ?? 'secondary'}>
                        {RUN_STATUS_KEY[run.status] ? t(RUN_STATUS_KEY[run.status]) : run.status}
                      </Badge>
                      {run.error ? (
                        <span className="ml-2 text-xs text-red-600 dark:text-red-400">{run.error}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">
                      {RUN_TRIGGER_KEY[run.trigger] ? t(RUN_TRIGGER_KEY[run.trigger]) : run.trigger}
                    </td>
                    <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-300">
                      {run.row_count ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                      {run.finished_at ? String(run.finished_at).slice(0, 19).replace('T', ' ') : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                      {run.trigger !== 'scheduled' ? '—' : t('deliveryEvidence', {
                        sent: run.delivery_sent,
                        total: run.delivery_total,
                        failed: run.delivery_failed,
                        suppressed: run.delivery_suppressed,
                      })}
                    </td>
                    <td className="px-3 py-2">
                      {run.artifact_available ? (
                        <a
                          href={`/api/reports/runs/${run.id}/artifact`}
                          className="text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {t('pdf')}
                        </a>
                      ) : run.status === 'succeeded' && run.row_count != null ? (
                        <a
                          href={`/api/reports/runs/${run.id}/csv`}
                          className="text-teal-700 hover:underline dark:text-teal-300"
                        >
                          {t('csv')}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
