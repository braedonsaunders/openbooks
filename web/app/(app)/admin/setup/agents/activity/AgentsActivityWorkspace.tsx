'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button } from '@openbooks/ui'

/** Serializable run envelope — the JSON the loader and the activity API hand over. */
export type AgentActivityRun = {
  id: string
  agentKey: string
  trigger: 'manual' | 'scheduler'
  status: 'completed' | 'failed' | 'skipped' | 'running'
  detectorVersion: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  detected: number
  autoResolved: number
  errorCode: string | null
}

const STATUS_BADGE: Record<AgentActivityRun['status'], 'success' | 'destructive' | 'secondary' | 'outline'> = {
  completed: 'success',
  failed: 'destructive',
  skipped: 'secondary',
  running: 'outline',
}

const PAGE_SIZE = 50

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * The Agents activity — runs across packs, newest first: pack, trigger,
 * status (with the error code on failures), started time, duration, findings
 * produced and auto-resolved, with re-run per row and a link into findings.
 * The pack filter and show-more paging re-query the activity API; re-run
 * POSTs to the per-pack run route and toasts like the overview run-now.
 */
export function AgentsActivityWorkspace({
  runs: initialRuns,
  total: initialTotal,
  truncated: initialTruncated,
  packs,
}: {
  runs: AgentActivityRun[]
  total: number
  truncated: boolean
  packs: string[]
}) {
  const t = useTranslations('admin')
  const router = useRouter()
  const [filter, setFilter] = useState('')
  const [runs, setRuns] = useState(initialRuns)
  const [total, setTotal] = useState(initialTotal)
  const [truncated, setTruncated] = useState(initialTruncated)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState<string | null>(null)

  async function query(agentKey: string, limit: number) {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: String(limit) })
      if (agentKey) params.set('agent', agentKey)
      const res = await fetch(`/api/admin/setup/agents/activity?${params.toString()}`)
      if (!res.ok) throw new Error(t('setup.agents.activity.loadFailed'))
      const payload = (await res.json()) as { runs: AgentActivityRun[]; total: number; truncated: boolean }
      setRuns(payload.runs)
      setTotal(payload.total)
      setTruncated(payload.truncated)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function changeFilter(agentKey: string) {
    setFilter(agentKey)
    void query(agentKey, PAGE_SIZE)
  }

  async function rerun(agentKey: string) {
    if (running) return
    setRunning(agentKey)
    try {
      const res = await fetch(`/api/admin/setup/agents/${agentKey}/run`, { method: 'POST' })
      const payload = (await res.json().catch(() => ({}))) as { detected?: number }
      if (!res.ok) throw new Error(t('setup.agents.overview.scanFailed'))
      toast.success(t('setup.agents.overview.scanComplete', { count: payload.detected ?? 0 }))
      router.refresh()
      await query(filter, PAGE_SIZE)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('setup.agents.activity.title')}</h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
              {t('setup.agents.activity.description')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              aria-label={t('setup.agents.activity.packColumn')}
              value={filter}
              disabled={loading}
              onChange={(event) => changeFilter(event.target.value)}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              <option value="">{t('setup.agents.activity.allPacks')}</option>
              {packs.map((agentKey) => (
                <option key={agentKey} value={agentKey}>
                  {t(`setup.agents.packs.${agentKey}.title`)}
                </option>
              ))}
            </select>
            <Link
              href="/admin/setup/agents"
              className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <ArrowLeft size={15} /> {t('setup.agents.nav.overview')}
            </Link>
          </div>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('setup.agents.activity.empty')}</p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('setup.agents.activity.emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th scope="col" className="px-3 py-2 font-semibold">{t('setup.agents.activity.packColumn')}</th>
                <th scope="col" className="px-3 py-2 font-semibold">{t('setup.agents.activity.triggerColumn')}</th>
                <th scope="col" className="px-3 py-2 font-semibold">{t('setup.agents.activity.statusColumn')}</th>
                <th scope="col" className="px-3 py-2 font-semibold">{t('setup.agents.activity.startedColumn')}</th>
                <th scope="col" className="px-3 py-2 font-semibold">{t('setup.agents.activity.durationColumn')}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t('setup.agents.activity.detectedColumn')}</th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">{t('setup.agents.activity.resolvedColumn')}</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">{t('setup.agents.activity.actionsColumn')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {runs.map((run) => (
                <tr key={run.id} className="text-slate-700 dark:text-slate-300">
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                    {t(`setup.agents.packs.${run.agentKey}.title`)}
                  </td>
                  <td className="px-3 py-2">{t(`setup.agents.activity.triggers.${run.trigger}`)}</td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_BADGE[run.status]}>
                      {t(`setup.agents.overview.runStatus.${run.status}`)}
                    </Badge>
                    {run.errorCode ? <span className="ml-1.5 text-slate-400">· {run.errorCode}</span> : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {new Date(run.startedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatDuration(run.durationMs) ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{run.detected}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{run.autoResolved}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Link
                      href="/continuous-close"
                      className="mr-3 font-medium text-teal-700 underline dark:text-teal-300"
                    >
                      {t('setup.agents.activity.viewFindings')}
                    </Link>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={running !== null || loading}
                      onClick={() => void rerun(run.agentKey)}
                    >
                      {running === run.agentKey ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                      {t('setup.agents.activity.rerun')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-3">
        <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
          {truncated
            ? t('setup.agents.activity.truncatedNote', { shown: runs.length, total })
            : t('setup.agents.activity.totalNote', { count: total })}
        </span>
        <span className="flex-1" />
        {truncated ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void query(filter, runs.length + PAGE_SIZE)}
          >
            {t('setup.agents.activity.showMore')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
