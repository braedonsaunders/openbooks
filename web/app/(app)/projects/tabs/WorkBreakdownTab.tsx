'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Input, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'

export interface WorkBreakdownTask {
  id: string | null
  code: string
  name: string
  status: string
  estimatedHours: string
  estimatedCost: string
}

export function WorkBreakdownTab({
  tasks,
  editable,
  onAdd,
  onChange,
  onRemove,
}: {
  tasks: WorkBreakdownTask[]
  editable: boolean
  onAdd: () => void
  onChange: (task: WorkBreakdownTask, patch: Partial<WorkBreakdownTask>) => void
  onRemove: (task: WorkBreakdownTask) => void
}) {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const [statusFilter, setStatusFilter] = useState('all')
  const statusOptions = useMemo(
    () => [
      { value: 'open', label: tCommon('status.open') },
      { value: 'complete', label: t('taskStatus.complete') },
      { value: 'cancelled', label: tCommon('status.cancelled') },
    ],
    [t, tCommon],
  )
  const visibleTasks = statusFilter === 'all' ? tasks : tasks.filter((task) => task.status === statusFilter)

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('drawer.wbsTitle')}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.wbsDescription')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="w-36" aria-label={tCommon('labels.status')}>
            <option value="all">{tCommon('labels.all')}</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </Select>
          {editable ? (
            <Button variant="outline" size="sm" onClick={() => { setStatusFilter('all'); onAdd() }}>
              <Plus size={14} /> {t('drawer.addTask')}
            </Button>
          ) : null}
        </div>
      </div>

      <PagedTable
        rows={visibleTasks}
        rowKey={(task, index) => task.id ?? `new-${index}`}
        searchable
        empty={<p className="text-sm text-slate-500 dark:text-slate-400">{tasks.length === 0 ? t('drawer.noTasks') : t('drawer.noTasksMatchingStatus')}</p>}
        columns={[
          {
            key: 'code',
            header: t('labels.code'),
            search: (task) => task.code,
            cell: (task) => (
              <Input
                value={task.code}
                onChange={(event) => onChange(task, { code: event.target.value })}
                className="min-w-24 font-mono"
                disabled={!editable}
                aria-label={t('drawer.taskCodeAria', {
                  task: task.name || t('drawer.unnamedTask'),
                })}
              />
            ),
          },
          {
            key: 'name',
            header: t('labels.task'),
            search: (task) => task.name,
            cell: (task) => <Input value={task.name} onChange={(event) => onChange(task, { name: event.target.value })} className="min-w-48" placeholder={t('drawer.taskNamePlaceholder')} disabled={!editable} aria-label={t('drawer.taskNameAria')} />,
          },
          {
            key: 'estimatedHours',
            header: t('labels.estHours'),
            align: 'right',
            cell: (task) => (
              <Input
                inputMode="decimal"
                className="min-w-24 text-right tabular-nums"
                value={task.estimatedHours}
                onChange={(event) => onChange(task, { estimatedHours: event.target.value })}
                disabled={!editable}
                aria-label={t('drawer.taskEstimatedHoursAria', {
                  task: task.name || t('drawer.unnamedTask'),
                })}
              />
            ),
          },
          {
            key: 'estimatedCost',
            header: t('labels.estCost'),
            align: 'right',
            cell: (task) => (
              <Input
                inputMode="decimal"
                className="min-w-28 text-right tabular-nums"
                value={task.estimatedCost}
                onChange={(event) => onChange(task, { estimatedCost: event.target.value })}
                disabled={!editable}
                aria-label={t('drawer.taskEstimatedCostAria', {
                  task: task.name || t('drawer.unnamedTask'),
                })}
              />
            ),
          },
          {
            key: 'status',
            header: tCommon('labels.status'),
            cell: (task) => (
              <Select
                value={task.status}
                onChange={(event) => onChange(task, { status: event.target.value })}
                className="min-w-32"
                disabled={!editable}
                aria-label={t('drawer.taskStatusAria', {
                  task: task.name || t('drawer.unnamedTask'),
                })}
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ),
          },
          {
            key: 'actions',
            header: <span className="sr-only">{tCommon('labels.actions')}</span>,
            align: 'right',
            cell: (task) =>
              editable ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(task)}
                  aria-label={t('drawer.removeNamedTaskAria', {
                    task: task.name || t('drawer.unnamedTask'),
                  })}
                >
                  <Trash2 size={14} />
                </Button>
              ) : null,
          },
        ]}
      />
    </div>
  )
}
