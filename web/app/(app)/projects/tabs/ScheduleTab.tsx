'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { emptySchedule, type ScheduleData } from '@appkit/scheduling'
import { ScheduleWorkspace, SchedulingProvider, type ScheduleAdapter } from '@appkit/scheduling/react'

/**
 * The project Schedule tab.
 *
 * The plan itself is `@appkit/scheduling` (see vendor/appkit); everything here
 * is the host side of that contract: load the project's plan, translate the
 * surface into the tenant's locale, and turn every edit into an authorized API
 * call. After a successful write the whole plan is re-fetched, because a single
 * outline move renumbers many rows and a merged local guess would drift from
 * what the server actually stored.
 */
export function ScheduleTab({
  projectId,
  projectStart,
  projectEnd,
  canManage,
  locale,
}: {
  projectId: string
  projectStart: string | null
  projectEnd: string | null
  canManage: boolean
  locale?: string
}) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [data, setData] = useState<ScheduleData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/project-schedule?projectId=${projectId}`, { cache: 'no-store' })
    if (!res.ok) {
      setError(tCommon('feedback.loadFailed'))
      setData(emptySchedule)
      return
    }
    const body = (await res.json()) as { schedule: ScheduleData }
    setError(null)
    setData(body.schedule)
  }, [projectId, tCommon])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** One mutation call; refreshes on success, surfaces the server's reason otherwise. */
  const mutate = useCallback(
    async (action: string, payload: Record<string, unknown>) => {
      if (!canManage) return false
      setError(null)
      const res = await fetch('/api/project-schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, action, ...payload }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? tCommon('feedback.saveFailed'))
        return false
      }
      await refresh()
      return true
    },
    [canManage, projectId, refresh, tCommon],
  )

  const adapter: ScheduleAdapter = useMemo(
    () => ({
      createTask: (input) => mutate('createTask', { input }),
      updateTask: (taskId, patch) => mutate('updateTask', { taskId, patch }),
      batchUpdateTasks: (updates) => mutate('batchUpdateTasks', { updates }),
      deleteTask: (taskId) => mutate('deleteTask', { taskId }),
      createDependency: (input) => mutate('createDependency', { input }),
      deleteDependency: (id) => mutate('deleteDependency', { id }),
      createCalendar: (input) => mutate('saveCalendar', { input }),
      updateCalendar: (id, patch) => mutate('saveCalendar', { input: { id, ...patch } }),
      deleteCalendar: (id) => mutate('deleteCalendar', { id }),
      createResource: (input) => mutate('saveResource', { input }),
      updateResource: (id, patch) => mutate('saveResource', { input: { id, ...patch } }),
      deleteResource: (id) => mutate('deleteResource', { id }),
      createBaseline: (input) => mutate('createBaseline', { input }),
      deleteBaseline: (id) => mutate('deleteBaseline', { id }),
    }),
    [mutate],
  )

  // The whole surface is translatable: the package ships English defaults and
  // takes overrides, so the tenant's locale drives it like every other screen.
  const labels = useMemo(
    () => ({
      status: {
        not_started: t('schedule.status.not_started'),
        in_progress: t('schedule.status.in_progress'),
        complete: t('schedule.status.complete'),
        on_hold: t('schedule.status.on_hold'),
      },
      view: {
        gantt: t('schedule.view.gantt'),
        list: t('schedule.view.list'),
        board: t('schedule.view.board'),
      },
      empty: {
        title: t('schedule.empty.title'),
        description: t('schedule.empty.description'),
        action: t('schedule.empty.action'),
      },
      leveling: {
        heading: t('schedule.leveling.heading'),
        description: t('schedule.leveling.description'),
      },
    }),
    [t, tCommon],
  )

  if (!data) {
    return <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900" />
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}
      <SchedulingProvider labels={labels} locale={locale}>
        <ScheduleWorkspace
          data={data}
          adapter={adapter}
          dateWorkStart={projectStart}
          dateWorkEnd={projectEnd}
        />
      </SchedulingProvider>
    </div>
  )
}
