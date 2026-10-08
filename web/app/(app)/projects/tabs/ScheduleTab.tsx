'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Button, Select } from '@openbooks/ui'
import { SchedulingAlert } from '@/components/scheduling/SchedulingAlert'
import { promptDialog } from '@/lib/prompt'
import { readApiErrorMessage } from '@/lib/api-error'
import {
  emptySchedule,
  type ScheduleData,
} from '@braedonsaunders/appkit-scheduling'
import {
  ScheduleWorkspace,
  SchedulingProvider,
  type ScheduleAdapter,
} from '@braedonsaunders/appkit-scheduling/react'

/**
 * The project Schedule tab.
 *
 * The plan itself is `@braedonsaunders/appkit-scheduling`; everything here
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
  /** Retained for callers; project schedules are managed on the project record. */
  showBoardLink?: boolean
}) {
  const t = useTranslations('projects')
  const tScheduling = useTranslations('scheduling')
  const tCommon = useTranslations('common')
  const [data, setData] = useState<ScheduleData | null>(null)
  const [boardList, setBoardList] = useState<{
    projectId: string
    boards: { id: string; code: string; name: string }[]
  } | null>(null)
  const boards = boardList?.projectId === projectId ? boardList.boards : []
  const [boardSelection, setBoardSelection] = useState<{
    projectId: string
    code: string
  } | null>(null)
  const boardCode =
    boardSelection?.projectId === projectId ? boardSelection.code : ''
  useEffect(() => {
    const abort = new AbortController()
    void fetch(`/api/projects/${projectId}/schedule-boards`, {
      signal: abort.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            await readApiErrorMessage(response, tCommon('feedback.loadFailed')),
          )
        return response.json()
      })
      .then((result) => {
        if (!abort.signal.aborted)
          setBoardList({ projectId, boards: result.boards })
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : tCommon('feedback.loadFailed'),
          )
      })
    return () => abort.abort()
  }, [projectId, tCommon])
  const [error, setError] = useState<string | null>(null)

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const refresh = useCallback(() => {
    return fetch(`/api/project-schedule?projectId=${projectId}`, {
      cache: 'no-store',
    }).then(async (res) => {
      if (!res.ok) {
        setError(await readApiErrorMessage(res, tCommon('feedback.loadFailed')))
        setData(emptySchedule)
        return
      }
      return (res.json() as Promise<{ schedule: ScheduleData }>).then(
        (body) => {
          setError(null)
          setData(body.schedule)
        },
      )
    })
  }, [projectId, tCommon])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** One mutation call; refreshes on success, surfaces the server's reason otherwise. */
  const mutate = useCallback(
    async (action: string, payload: Record<string, unknown>) => {
      // A reader's edit must name its refusal up front: the adapter rolls a
      // `false` back into the plan, so silence here reads as a silently
      // dropping Gantt.
      if (!canManage) {
        setError(t('schedule.readOnly'))
        return false
      }
      setError(null)
      const res = await fetch('/api/project-schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, action, ...payload }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, tCommon('feedback.saveFailed')))
        return false
      }
      await refresh()
      return true
    },
    [canManage, projectId, refresh, t, tCommon],
  )

  const adapter: ScheduleAdapter = useMemo(
    () => ({
      createTask: async (input) => {
        const name =
          input.name.trim() ||
          (await promptDialog({
            title: tScheduling(
              input.taskType === 'milestone'
                ? 'tasks.addMilestone'
                : 'tasks.addTask',
            ),
            label: tScheduling('tasks.taskName'),
            confirmLabel: tCommon('actions.save'),
          }))
        if (!name?.trim()) return false
        return mutate('createTask', { input: { ...input, name: name.trim() } })
      },
      updateTask: (taskId, patch) => mutate('updateTask', { taskId, patch }),
      batchUpdateTasks: (updates) => mutate('batchUpdateTasks', { updates }),
      deleteTask: (taskId) => mutate('deleteTask', { taskId }),
      createDependency: (input) => mutate('createDependency', { input }),
      deleteDependency: (id) => mutate('deleteDependency', { id }),
      createCalendar: (input) => mutate('saveCalendar', { input }),
      updateCalendar: (id, patch) =>
        mutate('saveCalendar', { input: { id, ...patch } }),
      deleteCalendar: (id) => mutate('deleteCalendar', { id }),
      createResource: (input) => mutate('saveResource', { input }),
      updateResource: (id, patch) =>
        mutate('saveResource', { input: { id, ...patch } }),
      deleteResource: (id) => mutate('deleteResource', { id }),
      createBaseline: (input) => mutate('createBaseline', { input }),
      deleteBaseline: (id) => mutate('deleteBaseline', { id }),
    }),
    [mutate, tScheduling, tCommon],
  )

  // The whole surface is translatable: the package ships English defaults and
  // takes overrides, so the tenant's locale drives it like every other screen.
  const labels = useMemo(
    () => ({
      toolbar: {
        addTask: tScheduling('tasks.addTask'),
        addMilestone: tScheduling('tasks.addMilestone'),
      },
      columns: { name: tScheduling('progress.task') },
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
    [t, tScheduling],
  )

  if (!data) {
    return (
      <div className="h-96 animate-pulse rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900" />
    )
  }

  return (
    <div className="min-w-0 space-y-2 [&_[data-testid=schedule-toolbar]>div]:flex-nowrap [&_[data-testid=schedule-toolbar]>div]:overflow-x-auto">
      {boards.length ? (
        <div className="flex min-w-0 flex-nowrap items-center gap-2 overflow-x-auto">
          <Select
            value={boardCode}
            onChange={(event) =>
              setBoardSelection({ projectId, code: event.target.value })
            }
            aria-label={tScheduling('toolbar.board')}
            className="h-8 min-w-0 flex-1 text-xs"
          >
            <option value="">{t('schedule.view.gantt')}</option>
            {boards.map((board) => (
              <option key={board.id} value={board.code}>
                {board.name}
              </option>
            ))}
          </Select>
          {boardCode ? (
            <Button asChild variant="outline" size="sm">
              <Link
                href={`/projects/${projectId}/schedule/board?board=${encodeURIComponent(boardCode)}`}
              >
                {tScheduling('toolbar.openBoard')}
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? <SchedulingAlert message={error} /> : null}
      {!canManage ? (
        <SchedulingAlert message={t('schedule.readOnly')} tone="info" />
      ) : null}
      {!boardCode ? (
        <SchedulingProvider labels={labels} locale={locale}>
          <ScheduleWorkspace
            data={data}
            adapter={adapter}
            dateWorkStart={projectStart}
            dateWorkEnd={projectEnd}
          />
        </SchedulingProvider>
      ) : null}
    </div>
  )
}
