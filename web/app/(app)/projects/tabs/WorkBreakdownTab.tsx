'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Pencil, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { useMoney } from '@/components/money-provider'

export interface WorkBreakdownTask {
  id: string
  code: string
  name: string
  status: 'open' | 'complete' | 'cancelled'
  estimatedHours: string
  estimatedCost: string
  updatedAt: string
}

interface InitialWorkBreakdownTask {
  id: string
  code: string | null
  name: string
  status: string
  estimated_hours: string | null
  estimated_cost: string | null
  updated_at: string
}

function normalizeInitialTask(task: InitialWorkBreakdownTask): WorkBreakdownTask {
  return {
    id: task.id,
    code: task.code ?? '',
    name: task.name,
    status:
      task.status === 'complete' || task.status === 'cancelled'
        ? task.status
        : 'open',
    estimatedHours: task.estimated_hours ?? '',
    estimatedCost: task.estimated_cost ?? '',
    updatedAt: new Date(task.updated_at).toISOString(),
  }
}

function emptyTask(): WorkBreakdownTask {
  return {
    id: '',
    code: '',
    name: '',
    status: 'open',
    estimatedHours: '',
    estimatedCost: '',
    updatedAt: '',
  }
}

function sortTasks(tasks: WorkBreakdownTask[]) {
  return [...tasks].sort(
    (left, right) => {
      // Match the canonical query's `code nulls last`: the API represents a
      // null code as an empty string for the editor.
      if (!left.code && right.code) return 1
      if (left.code && !right.code) return -1
      return (
        left.code.localeCompare(right.code, undefined, { numeric: true }) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
      )
    },
  )
}

export function WorkBreakdownTab({
  projectId,
  tasks: initialTasks,
  canManage,
}: {
  projectId: string
  tasks: InitialWorkBreakdownTask[]
  canManage: boolean
}) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const { money } = useMoney()
  const [tasks, setTasks] = useState(() => sortTasks(initialTasks.map(normalizeInitialTask)))
  const [statusFilter, setStatusFilter] = useState('all')
  const [editor, setEditor] = useState<WorkBreakdownTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTasks(sortTasks(initialTasks.map(normalizeInitialTask)))
  }, [initialTasks])

  const statusOptions = useMemo(
    () => [
      { value: 'open', label: tCommon('status.open') },
      { value: 'complete', label: t('taskStatus.complete') },
      { value: 'cancelled', label: tCommon('status.cancelled') },
    ],
    [t, tCommon],
  )
  const visibleTasks = statusFilter === 'all' ? tasks : tasks.filter((task) => task.status === statusFilter)

  async function refresh() {
    setRefreshing(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/tasks`, { cache: 'no-store' })
      const data = (await response.json()) as { tasks?: WorkBreakdownTask[]; error?: string }
      if (!response.ok || !data.tasks) throw new Error(data.error ?? t('drawer.taskRefreshFailed'))
      setTasks(sortTasks(data.tasks))
      toast.success(t('drawer.tasksRefreshed'))
    } catch (refreshError) {
      toast.error(refreshError instanceof Error ? refreshError.message : t('drawer.taskRefreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  async function saveTask() {
    if (!editor) return
    if (!editor.name.trim()) {
      setError(t('drawer.taskNameRequired'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const creating = !editor.id
      const response = await fetch(
        creating
          ? `/api/projects/${projectId}/tasks`
          : `/api/projects/${projectId}/tasks/${editor.id}`,
        {
          method: creating ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: editor.code,
            name: editor.name,
            status: editor.status,
            estimatedHours: editor.estimatedHours,
            estimatedCost: editor.estimatedCost,
            ...(creating ? {} : { expectedUpdatedAt: editor.updatedAt }),
          }),
        },
      )
      const data = (await response.json()) as { task?: WorkBreakdownTask; error?: string }
      if (!response.ok || !data.task) throw new Error(data.error ?? t('drawer.taskSaveFailed'))
      setTasks((current) =>
        sortTasks(
          creating
            ? [...current, data.task!]
            : current.map((task) => (task.id === data.task!.id ? data.task! : task)),
        ),
      )
      setEditor(null)
      toast.success(t(creating ? 'drawer.taskCreated' : 'drawer.taskUpdated'))
      router.refresh()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('drawer.taskSaveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.wbsTitle')}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.wbsDescription')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={() => void refresh()}
              aria-label={t('drawer.refreshTasks')}
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : undefined} />
              {tCommon('actions.refresh')}
            </Button>
            <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-36" aria-label={tCommon('labels.status')}>
              <option value="all">{tCommon('labels.all')}</option>
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
            {canManage ? (
              <Button variant="outline" size="sm" onClick={() => { setError(null); setEditor(emptyTask()) }}>
                <Plus size={14} /> {t('drawer.addTask')}
              </Button>
            ) : null}
          </div>
        </div>

        <PagedTable
          rows={visibleTasks}
          rowKey={(task) => task.id}
          searchable
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{tasks.length === 0 ? t('drawer.noTasks') : t('drawer.noTasksMatchingStatus')}</p>}
          columns={[
            {
              key: 'code',
              header: t('labels.code'),
              search: (task) => task.code,
              cell: (task) => <span className="font-mono text-sm">{task.code || '—'}</span>,
            },
            {
              key: 'name',
              header: t('labels.task'),
              search: (task) => task.name,
              cell: (task) => <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{task.name}</span>,
            },
            {
              key: 'estimatedHours',
              header: t('labels.estHours'),
              align: 'right',
              cell: (task) => <span className="tabular-nums">{task.estimatedHours || '—'}</span>,
            },
            {
              key: 'estimatedCost',
              header: t('labels.estCost'),
              align: 'right',
              cell: (task) => <span className="tabular-nums">{task.estimatedCost ? money(task.estimatedCost) : '—'}</span>,
            },
            {
              key: 'status',
              header: tCommon('labels.status'),
              cell: (task) => statusOptions.find((option) => option.value === task.status)?.label ?? task.status,
            },
            {
              key: 'actions',
              header: <span className="sr-only">{tCommon('labels.actions')}</span>,
              align: 'right',
              cell: (task) =>
                canManage ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setError(null); setEditor({ ...task }) }}
                    aria-label={t('drawer.editNamedTaskAria', { task: task.name })}
                  >
                    <Pencil size={14} />
                    {tCommon('actions.edit')}
                  </Button>
                ) : null,
            },
          ]}
        />
      </div>

      <Drawer
        open={editor !== null}
        onClose={() => { if (!busy) setEditor(null) }}
        stacked
        size="md"
        title={editor?.id ? t('drawer.editTask') : t('drawer.newTask')}
        description={t('drawer.taskEditorDescription')}
        headerActions={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditor(null)}>
              {tCommon('actions.cancel')}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void saveTask()}>
              {busy ? tCommon('actions.saving') : tCommon('actions.save')}
            </Button>
          </div>
        }
      >
        {editor ? (
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1.5">
              <Label>{t('labels.task')} <span className="text-red-500">*</span></Label>
              <Input
                autoFocus
                value={editor.name}
                onChange={(event) => setEditor((current) => current ? { ...current, name: event.target.value } : current)}
                placeholder={t('drawer.taskNamePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('labels.code')}</Label>
              <Input
                value={editor.code}
                onChange={(event) => setEditor((current) => current ? { ...current, code: event.target.value } : current)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label>{tCommon('labels.status')}</Label>
              <Select
                value={editor.status}
                onChange={(event) => setEditor((current) => current ? { ...current, status: event.target.value as WorkBreakdownTask['status'] } : current)}
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('labels.estHours')}</Label>
              <Input
                inputMode="decimal"
                value={editor.estimatedHours}
                onChange={(event) => setEditor((current) => current ? { ...current, estimatedHours: event.target.value } : current)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('labels.estCost')}</Label>
              <Input
                inputMode="decimal"
                value={editor.estimatedCost}
                onChange={(event) => setEditor((current) => current ? { ...current, estimatedCost: event.target.value } : current)}
              />
            </div>
            {error ? (
              <p role="alert" className="col-span-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </>
  )
}
