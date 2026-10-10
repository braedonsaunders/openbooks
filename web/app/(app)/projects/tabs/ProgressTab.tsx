'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ChevronRight, Plus, Undo2 } from 'lucide-react'
import {
  Badge,
  Button,
  DisclosureSection,
  Drawer,
  Input,
  Label,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@openbooks/ui'
import { useMoney } from '@/components/money-provider'
import { promptDialog } from '@/lib/prompt'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { KpiStrip, type Kpi } from '../../../../components/kpi-strip'
import { PagedTable } from '../../../../components/paged-table'
import { roundDecimal } from '@openbooks/engine/src/projects/earned-value-math.ts'
import { compareDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'

/**
 * Progress & earned value for one project: installed quantities against the
 * work breakdown's budgeted quantities, earned value, cost performance,
 * estimates to complete and burn. One task table; a row opens that task's
 * drawer to record progress, update its forecast and review its history.
 */

type Basis = 'quantity' | 'schedule' | 'cost' | 'none'
type ForecastMethod = 'manual' | 'remaining_budget' | 'units_productivity' | 'cost_performance'

interface Suggestion {
  method: Exclude<ForecastMethod, 'manual'>
  costToComplete: string
  hoursToComplete: string | null
}

interface EarnedTask {
  taskId: string
  code: string | null
  name: string
  status: string
  basis: Basis
  percentComplete: string | null
  budgetAtCompletion: string
  budgetQuantity: string | null
  budgetUnit: string | null
  installedQuantity: string
  earnedValue: string
  actualCost: string
  costPerformanceIndex: string | null
  estimateToComplete: string
  estimateSource: 'forecast' | 'remaining_budget'
  forecastMethod: ForecastMethod | null
  forecastAsOf: string | null
  estimateAtCompletion: string
  varianceAtCompletion: string
  budgetHours: string | null
  actualHours: string
  hoursToComplete: string | null
  productivity: string | null
  weeklyCostBurn: string
  weeksToComplete: string | null
  unitConflict: boolean
  suggestions: Suggestion[]
}

interface EarnedProject {
  asOf: string
  tasks: EarnedTask[]
  unassigned: { actualCost: string }
  totals: {
    percentComplete: string | null
    earnedValue: string
    actualCost: string
    unassignedActualCost: string
    costPerformanceIndex: string | null
    estimateAtCompletion: string
    estimateToComplete: string
    weeklyCostBurn: string
    weeksToComplete: string | null
  }
}

interface ProgressEntry {
  id: string
  entryDate: string
  quantity: string
  unit: string
  source: 'manual' | 'field_ticket'
  sourceDocumentNumber: string | null
  reversesEntryId: string | null
  reversedByEntryId: string | null
  note: string | null
  createdByName: string | null
}

/** Plain decimal for display: rounded, trailing zeros dropped. */
function decimal(value: string | null | undefined, places = 4): string {
  if (value == null) return '—'
  const rounded = roundDecimal(value, places)
  return rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded
}

const percent = (value: string | null) => (value == null ? '—' : `${decimal(value, 1)}%`)
const taskLabel = (task: Pick<EarnedTask, 'code' | 'name'>) => (task.code ? `${task.code} · ${task.name}` : task.name)
const isNegative = (value: string) => value.startsWith('-') && /[1-9]/.test(value)

async function postJson(url: string, body: unknown, fallback: string): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await readApiErrorMessage(response, fallback))
}

export function ProgressTab({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useTranslations('projects.progress')
  const tCommon = useTranslations('common')
  const { money } = useMoney()
  const [asOf, setAsOf] = useState('')
  const [reload, setReload] = useState(0)
  const [data, setData] = useState<EarnedProject | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [recordOpen, setRecordOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''
    fetch(`/api/projects/${encodeURIComponent(projectId)}/earned-value${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
        return response.json() as Promise<EarnedProject>
      })
      .then((body) => { setData(body); setError(null) })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('loadFailed'))
      })
    return () => controller.abort()
  }, [asOf, projectId, reload, t])

  const refresh = () => setReload((value) => value + 1)
  const selectedTask = data?.tasks.find((task) => task.taskId === selectedTaskId) ?? null
  const measurableTasks = useMemo(() => (data?.tasks ?? []).filter((task) => task.budgetUnit), [data])

  const kpis: Kpi[] = data
    ? [
        { label: t('kpi.percentComplete'), value: percent(data.totals.percentComplete) },
        { label: t('kpi.earnedValue'), value: money(data.totals.earnedValue) },
        { label: t('kpi.actualCost'), value: money(data.totals.actualCost) },
        {
          label: t('kpi.cpi'),
          value: decimal(data.totals.costPerformanceIndex, 2),
          tone: data.totals.costPerformanceIndex == null ? undefined : compareDecimal(data.totals.costPerformanceIndex, '1') >= 0 ? 'good' : 'bad',
        },
        { label: t('kpi.estimateAtCompletion'), value: money(data.totals.estimateAtCompletion) },
        { label: t('kpi.costToComplete'), value: money(data.totals.estimateToComplete) },
        {
          label: t('kpi.weeklyBurn'),
          value: money(data.totals.weeklyCostBurn),
          suffix: data.totals.weeksToComplete != null ? t('kpi.weeksLeft', { weeks: decimal(data.totals.weeksToComplete, 1) }) : undefined,
        },
      ]
    : []

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor="progress-as-of" className="text-xs">{t('asOf')}</Label>
          <Input
            id="progress-as-of"
            type="date"
            className="w-44"
            value={asOf || data?.asOf || ''}
            onChange={(event) => setAsOf(event.target.value)}
          />
        </div>
        {canManage ? (
          <Button size="sm" disabled={measurableTasks.length === 0} onClick={() => setRecordOpen(true)}>
            <Plus size={14} /> {t('recordProgress')}
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>{tCommon('actions.retry')}</Button>
        </div>
      ) : !data ? (
        <p className="py-10 text-center text-sm text-slate-500 dark:text-slate-400">{tCommon('feedback.loading')}</p>
      ) : (
        <>
          <KpiStrip items={kpis} />
          <PagedTable
            rows={data.tasks}
            rowKey={(task) => task.taskId}
            searchable
            searchLayout="drawer"
            empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>}
            columns={[
              {
                key: 'task',
                header: t('columns.task'),
                cell: (task) => (
                  <button
                    type="button"
                    onClick={() => setSelectedTaskId(task.taskId)}
                    className="group flex w-full items-center gap-1.5 text-left font-medium text-teal-700 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
                  >
                    <span>{taskLabel(task)}</span>
                    <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </button>
                ),
                search: (task) => taskLabel(task),
              },
              {
                key: 'budgetQuantity',
                header: t('columns.budgetQuantity'),
                align: 'right',
                cell: (task) => (task.budgetQuantity ? `${decimal(task.budgetQuantity)} ${task.budgetUnit}` : '—'),
              },
              {
                key: 'installed',
                header: t('columns.installed'),
                align: 'right',
                cell: (task) => (task.budgetUnit
                  ? <span className={cn(task.unitConflict && 'text-amber-700 dark:text-amber-300')} title={task.unitConflict ? t('unitConflict') : undefined}>{decimal(task.installedQuantity)}</span>
                  : '—'),
              },
              {
                key: 'percent',
                header: t('columns.percent'),
                align: 'right',
                cell: (task) => (
                  <span title={t(`basis.${task.basis}`)}>{percent(task.percentComplete)}</span>
                ),
              },
              { key: 'bac', header: t('columns.bac'), align: 'right', cell: (task) => money(task.budgetAtCompletion) },
              { key: 'ev', header: t('columns.ev'), align: 'right', cell: (task) => money(task.earnedValue) },
              { key: 'ac', header: t('columns.ac'), align: 'right', cell: (task) => money(task.actualCost) },
              { key: 'etc', header: t('columns.etc'), align: 'right', cell: (task) => money(task.estimateToComplete) },
              {
                key: 'eac',
                header: t('columns.eac'),
                align: 'right',
                cell: (task) => (
                  <span className={cn(isNegative(task.varianceAtCompletion) && 'text-red-600 dark:text-red-400')}>{money(task.estimateAtCompletion)}</span>
                ),
              },
            ]}
          />
          {/[1-9]/.test(data.totals.unassignedActualCost) ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('unassignedNote', { amount: money(data.totals.unassignedActualCost) })}
            </p>
          ) : null}
        </>
      )}

      {recordOpen && data ? (
        <Drawer open stacked size="md" onClose={() => setRecordOpen(false)} title={t('recordProgress')}>
          <RecordProgressForm
            projectId={projectId}
            tasks={measurableTasks}
            onRecorded={() => { setRecordOpen(false); refresh() }}
          />
        </Drawer>
      ) : null}

      {selectedTask ? (
        <TaskProgressDrawer
          projectId={projectId}
          task={selectedTask}
          asOf={data?.asOf ?? ''}
          canManage={canManage}
          onChanged={refresh}
          onClose={() => setSelectedTaskId(null)}
        />
      ) : null}
    </div>
  )
}

function RecordProgressForm({
  projectId,
  tasks,
  fixedTaskId,
  onRecorded,
}: {
  projectId: string
  tasks: EarnedTask[]
  fixedTaskId?: string
  onRecorded: () => void
}) {
  const t = useTranslations('projects.progress')
  const [taskId, setTaskId] = useState(fixedTaskId ?? '')
  const [entryDate, setEntryDate] = useState('')
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const task = tasks.find((candidate) => candidate.taskId === taskId)
  const quantityValid = /^\d+(\.\d{1,8})?$/.test(quantity.trim()) && /[1-9]/.test(quantity)

  async function submit() {
    if (!task?.budgetUnit || !quantityValid || !entryDate) return
    setBusy(true)
    setRefusal(null)
    try {
      await postJson(`/api/projects/${encodeURIComponent(projectId)}/progress`, {
        action: 'record',
        taskId: task.taskId,
        entryDate,
        quantity: quantity.trim(),
        unit: task.budgetUnit,
        note: note.trim() || null,
      }, t('recordFailed'))
      toast.success(t('recorded'))
      setQuantity('')
      setNote('')
      onRecorded()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t('recordFailed')
      setRefusal(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {fixedTaskId ? null : (
        <div className="space-y-1">
          <Label id="record-progress-task-label">{t('columns.task')}</Label>
          <SearchSelect
            ariaLabelledBy="record-progress-task-label"
            options={tasks.map((candidate) => ({ value: candidate.taskId, label: taskLabel(candidate) }))}
            value={taskId}
            onChange={(value) => setTaskId(value ?? '')}
            placeholder={t('pickTask')}
          />
        </div>
      )}
      <div className="grid grid-cols-[1fr_8rem_6rem] items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`progress-date-${fixedTaskId ?? 'any'}`}>{t('entryDate')}</Label>
          <Input id={`progress-date-${fixedTaskId ?? 'any'}`} type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`progress-qty-${fixedTaskId ?? 'any'}`}>{t('quantity')}</Label>
          <Input
            id={`progress-qty-${fixedTaskId ?? 'any'}`}
            inputMode="decimal"
            className="text-right tabular-nums"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`progress-unit-${fixedTaskId ?? 'any'}`}>{t('unit')}</Label>
          <Input
            id={`progress-unit-${fixedTaskId ?? 'any'}`}
            readOnly
            value={task?.budgetUnit ?? '—'}
            className="cursor-not-allowed bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`progress-note-${fixedTaskId ?? 'any'}`}>{t('note')}</Label>
        <Input id={`progress-note-${fixedTaskId ?? 'any'}`} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
      </div>
      {refusal ? (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{refusal}</p>
      ) : null}
      <Button size="sm" disabled={busy || !task || !quantityValid || !entryDate} onClick={() => void submit()}>
        {t('recordProgress')}
      </Button>
    </div>
  )
}

function TaskProgressDrawer({
  projectId,
  task,
  asOf,
  canManage,
  onChanged,
  onClose,
}: {
  projectId: string
  task: EarnedTask
  asOf: string
  canManage: boolean
  onChanged: () => void
  onClose: () => void
}) {
  const t = useTranslations('projects.progress')
  const tCommon = useTranslations('common')
  const { money } = useMoney()
  const [entries, setEntries] = useState<ProgressEntry[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyReload, setHistoryReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [manualCost, setManualCost] = useState('')
  const [manualHours, setManualHours] = useState('')
  const [manualNote, setManualNote] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/projects/${encodeURIComponent(projectId)}/progress?taskId=${encodeURIComponent(task.taskId)}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('historyFailed')))
        return response.json() as Promise<{ entries: ProgressEntry[] }>
      })
      .then((body) => { setEntries(body.entries); setHistoryError(null) })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setHistoryError(reason instanceof Error ? reason.message : t('historyFailed'))
      })
    return () => controller.abort()
  }, [historyReload, projectId, t, task.taskId])

  const changed = () => { setHistoryReload((value) => value + 1); onChanged() }

  async function run(action: () => Promise<void>, success: string, fallback: string): Promise<boolean> {
    setBusy(true)
    setRefusal(null)
    try {
      await action()
      toast.success(success)
      changed()
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : fallback
      setRefusal(message)
      toast.error(message)
      return false
    } finally {
      setBusy(false)
    }
  }

  const recordForecast = (body: Record<string, unknown>) => run(
    () => postJson(`/api/projects/${encodeURIComponent(projectId)}/forecasts`, { taskId: task.taskId, asOfDate: asOf, ...body }, t('forecastFailed')),
    t('forecastRecorded'),
    t('forecastFailed'),
  )

  async function reverse(entry: ProgressEntry) {
    const reason = await promptDialog({ title: t('reverseTitle'), label: t('reverseReason'), confirmLabel: t('reverse') })
    if (!reason) return
    await run(
      () => postJson(`/api/projects/${encodeURIComponent(projectId)}/progress`, { action: 'reverse', entryId: entry.id, reason }, t('reverseFailed')),
      t('reversed'),
      t('reverseFailed'),
    )
  }

  const metric = (label: string, value: string) => (
    <div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="font-medium tabular-nums text-slate-900 dark:text-slate-100">{value}</p>
    </div>
  )

  return (
    <Drawer open stacked size="lg" onClose={onClose} title={taskLabel(task)} description={t('taskDescription', { date: asOf })}>
      <div className="space-y-6 p-1">
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-4 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-950/40">
          {metric(t('columns.percent'), `${percent(task.percentComplete)} · ${t(`basis.${task.basis}`)}`)}
          {metric(t('columns.installed'), task.budgetUnit ? `${decimal(task.installedQuantity)} / ${decimal(task.budgetQuantity)} ${task.budgetUnit}` : '—')}
          {metric(t('columns.ev'), money(task.earnedValue))}
          {metric(t('columns.ac'), money(task.actualCost))}
          {metric(t('kpi.cpi'), decimal(task.costPerformanceIndex, 2))}
          {metric(t('columns.eac'), money(task.estimateAtCompletion))}
          {metric(t('hours'), `${decimal(task.actualHours, 2)} / ${decimal(task.budgetHours, 2)}`)}
          {metric(t('productivity'), task.productivity && task.budgetUnit ? t('perHour', { value: decimal(task.productivity, 2), unit: task.budgetUnit }) : '—')}
        </div>

        {refusal ? (
          <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">{refusal}</p>
        ) : null}

        {canManage ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('recordProgress')}</h3>
            {task.budgetUnit ? (
              <RecordProgressForm projectId={projectId} tasks={[task]} fixedTaskId={task.taskId} onRecorded={changed} />
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('noBudgetQuantity')}</p>
            )}
          </section>
        ) : null}

        {canManage ? (
          <section className="space-y-2">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('updateForecast')}</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {task.estimateSource === 'forecast' && task.forecastMethod
                  ? t('currentForecast', { method: t(`methods.${task.forecastMethod}`), date: task.forecastAsOf ?? '', amount: money(task.estimateToComplete) })
                  : t('noForecast', { amount: money(task.estimateToComplete) })}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {task.suggestions.map((suggestion) => (
                <button
                  key={suggestion.method}
                  type="button"
                  disabled={busy || !asOf}
                  onClick={() => void recordForecast({ method: suggestion.method })}
                  className="rounded-lg border border-slate-200 p-3 text-left transition-colors hover:border-teal-500 hover:bg-teal-50/50 disabled:opacity-50 dark:border-slate-800 dark:hover:border-teal-400 dark:hover:bg-teal-950/30"
                >
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{t(`methods.${suggestion.method}`)}</span>
                  <span className="block text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{money(suggestion.costToComplete)}</span>
                  {suggestion.hoursToComplete != null ? (
                    <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">{t('hoursLeft', { hours: decimal(suggestion.hoursToComplete, 2) })}</span>
                  ) : null}
                </button>
              ))}
            </div>
            <DisclosureSection title={t('enterManually')}>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="space-y-1">
                  <Label htmlFor={`forecast-cost-${task.taskId}`}>{t('costToComplete')}</Label>
                  <Input id={`forecast-cost-${task.taskId}`} inputMode="decimal" className="text-right tabular-nums" value={manualCost} onChange={(event) => setManualCost(event.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`forecast-hours-${task.taskId}`}>{t('hoursToComplete')}</Label>
                  <Input id={`forecast-hours-${task.taskId}`} inputMode="decimal" className="text-right tabular-nums" value={manualHours} onChange={(event) => setManualHours(event.target.value)} />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label htmlFor={`forecast-note-${task.taskId}`}>{t('note')}</Label>
                  <Input id={`forecast-note-${task.taskId}`} maxLength={500} value={manualNote} onChange={(event) => setManualNote(event.target.value)} />
                </div>
                <div className="col-span-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !asOf || !/^\d+(\.\d{1,4})?$/.test(manualCost.trim())}
                    onClick={() => void recordForecast({
                      method: 'manual',
                      costToComplete: manualCost.trim(),
                      hoursToComplete: manualHours.trim() || null,
                      note: manualNote.trim() || null,
                    }).then((saved) => { if (saved) { setManualCost(''); setManualHours(''); setManualNote('') } })}
                  >
                    {t('saveForecast')}
                  </Button>
                </div>
              </div>
            </DisclosureSection>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('history')}</h3>
          {historyError ? (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">{historyError}</p>
              <Button variant="outline" size="sm" onClick={() => setHistoryReload((value) => value + 1)}>{tCommon('actions.retry')}</Button>
            </div>
          ) : !entries ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{tCommon('feedback.loading')}</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('noHistory')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('entryDate')}</TableHead>
                  <TableHead className="text-right" align="right">{t('quantity')}</TableHead>
                  <TableHead>{t('source')}</TableHead>
                  <TableHead>{t('note')}</TableHead>
                  {canManage ? <TableHead className="w-8" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id} className={cn(entry.reversedByEntryId && 'text-slate-400 line-through dark:text-slate-500')}>
                    <TableCell className="tabular-nums">{entry.entryDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{decimal(entry.quantity)} {entry.unit}</TableCell>
                    <TableCell>
                      {entry.reversesEntryId
                        ? <Badge variant="outline">{t('reversal')}</Badge>
                        : entry.source === 'field_ticket'
                          ? t('fromTicket', { number: entry.sourceDocumentNumber ?? '' })
                          : t('manual')}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-slate-500" title={entry.note ?? undefined}>{entry.note ?? '—'}</TableCell>
                    {canManage ? (
                      <TableCell className="text-right">
                        {entry.source === 'manual' && !entry.reversesEntryId && !entry.reversedByEntryId ? (
                          <button
                            type="button"
                            aria-label={t('reverse')}
                            title={t('reverse')}
                            disabled={busy}
                            className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                            onClick={() => void reverse(entry)}
                          >
                            <Undo2 size={13} />
                          </button>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </Drawer>
  )
}
