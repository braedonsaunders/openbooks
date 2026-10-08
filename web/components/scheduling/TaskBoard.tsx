'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { SchedulingAlert } from './SchedulingAlert'
import { Search } from 'lucide-react'
import { Input, cn } from '@openbooks/ui'
import { ScheduleTab } from '../../app/(app)/projects/tabs/ScheduleTab'
import { projectProgress, SchedulingRequestError } from './api'
import type { ProjectProgress, TaskProgress } from '@openbooks/engine/src/schedule-boards/progress.ts'

export interface TaskBoardProject {
  readonly id: string
  readonly code: string | null
  readonly name: string
  readonly customerName: string | null
  readonly startsOn: string | null
  readonly endsOn: string | null
}

/**
 * A task board: the projects in the board's scope on the left, the selected
 * project's schedule on the right. The Gantt is the project's own schedule,
 * so editing it here and on the project are the same edit.
 */
export function TaskBoard({ boardId, view, projects, selectedProjectId, onSelectProject, canManage }: {
  boardId: string
  view: 'gantt' | 'progress'
  projects: readonly TaskBoardProject[]
  selectedProjectId: string | null
  onSelectProject: (id: string) => void
  canManage: boolean
}) {
  const t = useTranslations('scheduling')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? projects.filter((project) => `${project.code ?? ''} ${project.name} ${project.customerName ?? ''}`.toLowerCase().includes(q)) : projects
  }, [projects, query])
  const selected = projects.find((project) => project.id === selectedProjectId) ?? null

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {projects.length > 1 ? (
        <aside className="hidden w-64 shrink-0 flex-col rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 md:flex">
          <div className="relative border-b border-slate-100 p-2 dark:border-slate-800">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('tasks.searchProjects')} className="h-8 pl-7 text-xs" />
          </div>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {shown.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => onSelectProject(project.id)}
                  className={cn('w-full rounded-lg px-2.5 py-2 text-left', project.id === selectedProjectId ? 'bg-teal-50 ring-1 ring-teal-200 dark:bg-teal-950/40 dark:ring-teal-900' : 'hover:bg-slate-50 dark:hover:bg-slate-900')}
                >
                  <span className="block truncate text-xs font-semibold text-slate-900 dark:text-slate-100">{project.code ? `${project.code} · ${project.name}` : project.name}</span>
                  <span className="block truncate text-[11px] text-slate-500">{project.customerName ?? t('tasks.noCustomer')}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 ? <li className="px-2 py-6 text-center text-xs text-slate-500">{t('tasks.noProjects')}</li> : null}
          </ul>
        </aside>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {!selected ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-12 text-center text-sm text-slate-500 dark:border-slate-700">{projects.length ? t('tasks.pickProject') : t('tasks.noProjects')}</div>
        ) : view === 'gantt' ? (
          <ScheduleTab key={selected.id} projectId={selected.id} projectStart={selected.startsOn} projectEnd={selected.endsOn} canManage={canManage} locale={locale} showBoardLink={false} />
        ) : (
          <ProgressView key={selected.id} boardId={boardId} projectId={selected.id} canManage={canManage} />
        )}
      </div>
    </div>
  )
}

const hours = (value: string | null, digits = 1) => (value === null ? '—' : Number(value).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }))
const percent = (value: string | null) => (value === null ? '—' : `${Math.round(Number(value) * 100)}%`)

function factorTone(value: string | null): string {
  if (value === null) return 'text-slate-400'
  const factor = Number(value)
  return factor >= 1 ? 'text-emerald-700 dark:text-emerald-300' : factor >= 0.85 ? 'text-amber-700 dark:text-amber-300' : 'text-rose-700 dark:text-rose-300'
}

/**
 * Production progress for one project: percent complete per task against
 * the hours charged to it, with earned hours, productivity and the hours
 * still needed at the pace achieved so far.
 */
function ProgressView({ boardId, projectId, canManage }: { boardId: string; projectId: string; canManage: boolean }) {
  const t = useTranslations('scheduling')
  const [data, setData] = useState<ProjectProgress | null>(null)
  const [error, setError] = useState<{ message: string; remedy: string | null } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(() => projectProgress(boardId, projectId, t('errors.load'))
    .then((body) => {
      setData(body)
      setError(null)
    })
    .catch((cause: unknown) => setError({ message: cause instanceof Error ? cause.message : t('errors.load'), remedy: cause instanceof SchedulingRequestError ? cause.remedy : null })), [boardId, projectId, t])

  useEffect(() => {
    void load()
  }, [load])

  async function setPercent(task: TaskProgress, value: string) {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return
    if (Math.round(Number(task.percentComplete) * 100) === Math.round(parsed)) return
    setSaving(task.id)
    const response = await fetch('/api/project-schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, action: 'updateTask', taskId: task.id, patch: { progress: parsed } }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; remedy?: string }
      setError({ message: body.error ?? t('errors.save'), remedy: body.remedy ?? null })
    }
    if (response.ok) await load()
    setSaving(null)
  }

  if (error && !data) return <SchedulingAlert message={error.message} remedy={error.remedy} />
  if (!data) return <div className="h-96 animate-pulse rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900" />
  const totals = data.totals

  const tiles: { label: string; value: string; tone?: string }[] = [
    { label: t('progress.complete'), value: percent(totals.percentComplete) },
    { label: t('progress.earned'), value: `${hours(totals.earnedHours)} / ${hours(totals.budgetHours)}` },
    { label: t('progress.actual'), value: hours(totals.actualHours) },
    { label: t('progress.factor'), value: totals.performanceFactor === null ? '—' : Number(totals.performanceFactor).toFixed(2), tone: factorTone(totals.performanceFactor) },
    { label: t('progress.estimate'), value: hours(totals.estimateAtCompletion) },
    { label: t('progress.variance'), value: hours(totals.varianceAtCompletion), tone: totals.varianceAtCompletion !== null && Number(totals.varianceAtCompletion) < 0 ? 'text-rose-700 dark:text-rose-300' : undefined },
  ]

  return (
    <div className="space-y-4">
      {error ? <SchedulingAlert message={error.message} remedy={error.remedy} /> : null}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
            <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{tile.label}</div>
            <div className={cn('mt-1 text-xl font-semibold tabular-nums text-slate-900 dark:text-slate-100', tile.tone)}>{tile.value}</div>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500 dark:border-slate-800">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">{t('progress.task')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.budget')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.actual')}</th>
              <th className="w-56 px-3 py-2 text-left font-semibold">{t('progress.complete')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.earned')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.factor')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.toComplete')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.estimate')}</th>
              <th className="px-3 py-2 text-right font-semibold">{t('progress.variance')}</th>
            </tr>
          </thead>
          <tbody>
            {data.tasks.map((task) => {
              const done = Math.min(100, Math.round(Number(task.percentComplete) * 100))
              const used = task.hoursUsed === null ? null : Math.min(150, Math.round(Number(task.hoursUsed) * 100))
              return (
                <tr key={task.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 dark:border-slate-800 dark:hover:bg-slate-900/40">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2" style={{ paddingLeft: task.outlineLevel * 14 }}>
                      <span className="truncate font-medium text-slate-900 dark:text-slate-100">{task.code ? `${task.code} · ${task.name}` : task.name}</span>
                    </div>
                    {task.phase ? <div className="text-[11px] text-slate-400" style={{ paddingLeft: task.outlineLevel * 14 }}>{task.phase}</div> : null}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">{hours(task.budgetHours)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {hours(task.actualHours)}
                    {Number(task.pendingHours) > 0 ? <div className="text-[10px] text-slate-400">{t('progress.pending', { hours: hours(task.pendingHours) })}</div> : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800" title={used === null ? undefined : t('progress.used', { percent: used })}>
                        <div className="absolute inset-y-0 left-0 rounded-full bg-teal-500" style={{ width: `${done}%` }} />
                        {used !== null ? <div className={cn('absolute inset-y-0 w-0.5', used > done ? 'bg-rose-500' : 'bg-slate-500')} style={{ left: `${Math.min(100, used)}%` }} /> : null}
                      </div>
                      {canManage ? (
                        <input
                          type="number"
                          min={0}
                          max={100}
                          defaultValue={done}
                          disabled={saving === task.id}
                          onBlur={(event) => void setPercent(task, event.target.value)}
                          onKeyDown={(event) => event.key === 'Enter' && (event.target as HTMLInputElement).blur()}
                          aria-label={t('progress.completeFor', { task: task.name })}
                          className="w-14 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-right text-xs tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      ) : (
                        <span className="w-10 text-right text-xs tabular-nums">{done}%</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{hours(task.earnedHours)}</td>
                  <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', factorTone(task.performanceFactor))}>{task.performanceFactor === null ? '—' : Number(task.performanceFactor).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{hours(task.hoursToComplete)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{hours(task.estimateAtCompletion)}</td>
                  <td className={cn('px-3 py-2 text-right tabular-nums', task.varianceAtCompletion !== null && Number(task.varianceAtCompletion) < 0 && 'text-rose-700 dark:text-rose-300')}>{hours(task.varianceAtCompletion)}</td>
                </tr>
              )
            })}
            {data.tasks.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-10 text-center text-sm text-slate-500">{t('progress.noTasks')}</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-500">{t('progress.explain')}</p>
    </div>
  )
}
