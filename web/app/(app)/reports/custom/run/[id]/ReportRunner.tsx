'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Download, Play, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button } from '@openbooks/ui'
import type { ReportCustomQuery, ReportRunResult } from '@openbooks/reports'
import { DetailPageLayout } from '../../../../../../components/page-layout'
import { ResultView } from '../../ResultView'
import { ScheduleEditor, type ScheduleRow } from './ScheduleEditor'

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

export function ReportRunner({
  definition,
  schedules,
  recentRuns,
  canCreate,
  canSchedule,
}: {
  definition: {
    id: string
    kind: 'built_in' | 'custom'
    name: string
    description: string | null
    query: ReportCustomQuery
  }
  schedules: ScheduleRow[]
  recentRuns: RunRow[]
  canCreate: boolean
  canSchedule: boolean
}) {
  const router = useRouter()
  const [result, setResult] = useState<ReportRunResult | null>(null)
  const [lastRunId, setLastRunId] = useState<string | null>(null)
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
      toast.error(data.error ?? 'Report run failed')
      setRunning(false)
      router.refresh()
      return
    }
    setResult(data.result)
    setLastRunId(data.runId)
    toast.success('Report run complete')
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
                {definition.name}
              </h1>
              {definition.kind === 'built_in' ? <Badge variant="secondary">Built-in</Badge> : null}
            </div>
            {definition.description ? (
              <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
                {definition.description}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {canCreate ? (
              <Button variant="outline" asChild>
                <Link href={`/reports/custom/builder/${definition.id}`}>Edit</Link>
              </Button>
            ) : null}
            {lastRunId ? (
              <Button variant="outline" asChild>
                <a href={`/api/reports/runs/${lastRunId}/csv`}>
                  <Download size={15} /> Download CSV
                </a>
              </Button>
            ) : null}
            <Button disabled={running} onClick={runNow}>
              <Play size={15} /> {running ? 'Running…' : 'Run now'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-8">
        {/* --- result --- */}
        <section>
          {result ? (
            <ResultView result={result} />
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-12 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
              Run the report to see results here. Runs are saved and downloadable as CSV.
            </div>
          )}
        </section>

        {/* --- schedules --- */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Scheduled delivery</h2>
          <ScheduleEditor
            definitionId={definition.id}
            schedules={schedules}
            canSchedule={canSchedule}
          />
        </section>

        {/* --- recent runs --- */}
        {recentRuns.length > 0 ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Recent runs</h2>
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500 dark:bg-slate-900/60 dark:text-slate-400">
                  <tr>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Trigger</th>
                    <th className="px-3 py-2 font-medium">Rows</th>
                    <th className="px-3 py-2 font-medium">Finished</th>
                    <th className="px-3 py-2 font-medium">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="px-3 py-2">
                        <Badge variant={RUN_VARIANT[run.status] ?? 'secondary'}>{run.status}</Badge>
                        {run.error ? (
                          <span className="ml-2 text-xs text-red-600 dark:text-red-400">{run.error}</span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{run.trigger}</td>
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
                            CSV
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
