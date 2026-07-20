'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FileText, Play, Sheet } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button } from '@openbooks/ui'
import type { ReportCustomQuery, ReportRunResult } from '@openbooks/reports'
import { DetailPageLayout } from '../../../../../../components/page-layout'
import { ResultView } from '../../ResultView'
import { ScheduleEditor, type ScheduleRow } from './ScheduleEditor'
import { ReportPaper } from '../../../ReportPaper'

type RunRow = {
  id: string
  trigger: string
  status: string
  error: string | null
  row_count: number | null
  started_at: string | null
  finished_at: string | null
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

export function ReportRunner({
  definition,
  schedules,
  recentRuns,
  company,
  canCreate,
  canSchedule,
}: {
  definition: {
    id: string
    kind: 'built_in' | 'custom'
    slug: string
    name: string
    description: string | null
    query: ReportCustomQuery
  }
  schedules: ScheduleRow[]
  recentRuns: RunRow[]
  company: string
  canCreate: boolean
  canSchedule: boolean
}) {
  const t = useTranslations('reports.custom.runner')
  const tk = useTranslations('reports.custom')
  const tc = useTranslations('common')
  const tReports = useTranslations('reports')
  const router = useRouter()

  // Built-in definitions localize by slug; custom slugs fall back to stored text.
  const displayName =
    definition.kind === 'built_in' && tReports.has(`builtIns.${definition.slug}.name`)
      ? tReports(`builtIns.${definition.slug}.name`)
      : definition.name
  const displayDescription =
    definition.kind === 'built_in' && tReports.has(`builtIns.${definition.slug}.description`)
      ? tReports(`builtIns.${definition.slug}.description`)
      : definition.description
  const [result, setResult] = useState<ReportRunResult | null>(null)
  const [running, setRunning] = useState(false)

  async function runNow() {
    setRunning(true)
    const res = await fetch('/api/reports/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ definitionId: definition.id }),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('runFailed'))
      setRunning(false)
      router.refresh()
      return
    }
    setResult(data.result)
    toast.success(t('runComplete'))
    setRunning(false)
    router.refresh()
  }

  return (
    <DetailPageLayout
      header={
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-slate-900 dark:text-slate-100">
                {displayName}
              </h1>
              {definition.kind === 'built_in' ? <Badge variant="secondary">{tk('kind.builtIn')}</Badge> : null}
            </div>
            {displayDescription ? (
              <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
                {displayDescription}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {canCreate ? (
              <Button variant="outline" asChild>
                <Link href={`/reports/custom/builder/${definition.id}`}>{tc('actions.edit')}</Link>
              </Button>
            ) : null}
            <Button variant="outline" asChild>
              <a href={`/api/reports/definitions/${definition.id}/export?format=pdf`}>
                <FileText size={15} /> {t('downloadPdf')}
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={`/api/reports/definitions/${definition.id}/export?format=xlsx`}>
                <Sheet size={15} /> {t('downloadXlsx')}
              </a>
            </Button>
            <Button disabled={running} onClick={runNow}>
              <Play size={15} /> {running ? tk('running') : t('runNow')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-8">
        {/* --- result --- */}
        <section>
          {result ? (
            <ResultView company={company} title={displayName} description={displayDescription} result={result} />
          ) : (
            <ReportPaper company={company} title={displayName} periodPhrase={displayDescription || undefined}>
              <p className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">{t('emptyHint')}</p>
            </ReportPaper>
          )}
        </section>

        {/* --- schedules --- */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('scheduledDelivery')}</h2>
          <ScheduleEditor
            definitionId={definition.id}
            schedules={schedules}
            canSchedule={canSchedule}
          />
        </section>

        {/* --- recent runs --- */}
        {recentRuns.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('recentRuns')}</h2>
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">{tc('labels.status')}</th>
                    <th className="px-3 py-2 font-medium">{t('columns.trigger')}</th>
                    <th className="px-3 py-2 font-medium">{t('columns.rows')}</th>
                    <th className="px-3 py-2 font-medium">{t('columns.finished')}</th>
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
                      <td className="px-3 py-2">
                        {run.status === 'succeeded' ? (
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
          </section>
        ) : null}
      </div>
    </DetailPageLayout>
  )
}
