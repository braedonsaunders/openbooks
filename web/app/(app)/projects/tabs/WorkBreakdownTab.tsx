'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Flag, Pencil, Plus, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button, DisclosureSection, Drawer, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../../components/paged-table'
import { promptDialog } from '../../../../lib/prompt'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useMoney } from '@/components/money-provider'

export interface WorkBreakdownTask {
  id: string
  code: string
  name: string
  status: 'open' | 'complete' | 'cancelled'
  estimatedHours: string
  estimatedCost: string
  estimatedPrice: string
  budgetQuantity: string
  budgetUnit: string
  updatedAt: string
}

/** A recorded budget baseline, as listed by the baselines endpoint. */
interface BudgetBaseline {
  id: string
  kind: 'original' | 'revised'
  sequence: number
  label: string
  reason: string
  sourceDocumentNumber: string | null
  totalHours: string
  totalCost: string
  totalPrice: string
  createdAt: string
}

interface InitialWorkBreakdownTask {
  id: string
  code: string | null
  name: string
  status: string
  estimated_hours: string | null
  estimated_cost: string | null
  estimated_price?: string | null
  budget_quantity?: string | null
  budget_unit?: string | null
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
    estimatedPrice: task.estimated_price ?? '',
    budgetQuantity: task.budget_quantity ?? '',
    budgetUnit: task.budget_unit ?? '',
    // The server revision text echoes back as expectedUpdatedAt: pass it
    // through untouched. Re-serializing through Date truncates to 3
    // fractional digits, which fails DOCUMENT_REVISION_PATTERN (6 digits)
    // and refuses every edit of an initially loaded task with 422.
    updatedAt: task.updated_at,
  }
}

/** Drop trailing fractional zeros for display ("24.00000000" → "24"). */
function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

function emptyTask(): WorkBreakdownTask {
  return {
    id: '',
    code: '',
    name: '',
    status: 'open',
    estimatedHours: '',
    estimatedCost: '',
    estimatedPrice: '',
    budgetQuantity: '',
    budgetUnit: '',
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
  const tb = useTranslations('projects.budget')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const router = useRouter()
  const { money } = useMoney()
  const [tasks, setTasks] = useState(() => sortTasks(initialTasks.map(normalizeInitialTask)))
  const [statusFilter, setStatusFilter] = useState('all')
  const [editor, setEditor] = useState<WorkBreakdownTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Baselines and whether production quantities are in use (Progress
  // tracking) come from one read; until it answers the quantity fields stay
  // hidden, so the editor never sends a pair the feature gate would refuse.
  const [baselines, setBaselines] = useState<BudgetBaseline[] | null>(null)
  const [productionQuantities, setProductionQuantities] = useState(false)
  const [baselineBusy, setBaselineBusy] = useState(false)

  const loadBaselines = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/baselines`, { cache: 'no-store' })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, tb('baselinesLoadFailed')))
      const data = (await response.json()) as { baselines?: BudgetBaseline[]; productionQuantities?: boolean }
      setBaselines(data.baselines ?? [])
      setProductionQuantities(data.productionQuantities === true)
    } catch (loadError) {
      setBaselines([])
      toast.error(loadError instanceof Error ? loadError.message : tb('baselinesLoadFailed'))
    }
  }, [projectId, tb])

  useEffect(() => {
    void loadBaselines()
  }, [loadBaselines])

  const original = baselines?.find((baseline) => baseline.sequence === 1) ?? null
  const revisions = baselines ? baselines.length - (original ? 1 : 0) : 0
  const formatDate = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' })

  async function setBaseline() {
    const reason = await promptDialog({
      title: original ? tb('setRevisedTitle') : tb('setOriginalTitle'),
      message: tb('baselineMessage'),
      label: tb('reasonLabel'),
      placeholder: tb('reasonPlaceholder'),
      confirmLabel: tb('setBaseline'),
    })
    if (!reason) return
    if (reason.trim().length < 8) {
      toast.error(tb('reasonTooShort'))
      return
    }
    setBaselineBusy(true)
    try {
      const response = await fetch(`/api/projects/${projectId}/baselines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, tb('baselineFailed')))
      toast.success(tb('baselineCaptured'))
      await loadBaselines()
      router.refresh()
    } catch (captureError) {
      toast.error(captureError instanceof Error ? captureError.message : tb('baselineFailed'))
    } finally {
      setBaselineBusy(false)
    }
  }

  // Adopt a new task list during render (same committed values, no extra
  // render). Keyed on the prop identity, like before — local edits never
  // trigger it.
  const [prevInitialTasks, setPrevInitialTasks] = useState(initialTasks)
  if (prevInitialTasks !== initialTasks) {
    setPrevInitialTasks(initialTasks)
    setTasks(sortTasks(initialTasks.map(normalizeInitialTask)))
  }

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
      // The status is checked before the body parses: a non-JSON error page
      // must name the translated failure, never throw out of .json().
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('drawer.taskRefreshFailed')))
      const data = (await response.json()) as { tasks?: WorkBreakdownTask[] }
      if (!data.tasks) throw new Error(t('drawer.taskRefreshFailed'))
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
    // Reopening a closed task, or changing its estimates while it stays
    // closed, requires a reason server-side: collect it before saving so the
    // PATCH does not refuse after the fact. Budgets compare canonically, so
    // a text-only change ('10' vs '10.0000') prompts nothing.
    const creating = !editor.id
    const previous = creating ? null : (tasks.find((task) => task.id === editor.id) ?? null)
    const wasClosed = previous?.status === 'complete' || previous?.status === 'cancelled'
    const sameBudget = (before: string, after: string) => {
      const normalize = (value: string) => (value.trim() === '' ? null : canonicalDecimal(value, 4))
      return normalize(before) === normalize(after)
    }
    const reasonRequired =
      !!previous &&
      wasClosed &&
      (editor.status === 'open' ||
        !sameBudget(previous.estimatedHours, editor.estimatedHours) ||
        !sameBudget(previous.estimatedCost, editor.estimatedCost) ||
        !sameBudget(previous.estimatedPrice, editor.estimatedPrice))
    let reason: string | null = null
    if (reasonRequired) {
      reason = await promptDialog({
        title: t('drawer.editTask'),
        label: tCommon('amendment.reason'),
        placeholder: tCommon('amendment.placeholder'),
        confirmLabel: tCommon('actions.save'),
      })
      // Cancel or empty writes nothing: back to the still-open editor.
      if (!reason) return
    }
    setBusy(true)
    setError(null)
    try {
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
            estimatedPrice: editor.estimatedPrice,
            ...(productionQuantities ? { budgetQuantity: editor.budgetQuantity, budgetUnit: editor.budgetUnit } : {}),
            ...(creating ? {} : { expectedUpdatedAt: editor.updatedAt }),
            ...(reason ? { reason } : {}),
          }),
        },
      )
      // The status is checked before the body parses, like refresh above.
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('drawer.taskSaveFailed')))
      const data = (await response.json()) as { task?: WorkBreakdownTask }
      if (!data.task) throw new Error(t('drawer.taskSaveFailed'))
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
            {canManage && tasks.length > 0 ? (
              <Button variant="ghost" size="sm" disabled={baselineBusy || baselines === null} onClick={() => void setBaseline()}>
                <Flag size={14} /> {tb('setBaseline')}
              </Button>
            ) : null}
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

        {baselines !== null ? (
          <div className="rounded-md border border-slate-200 px-3 py-2 text-xs dark:border-slate-800">
            <p className="text-slate-600 dark:text-slate-300">
              {original
                ? original.sourceDocumentNumber
                  ? tb('originalFromSource', { date: formatDate(original.createdAt), source: original.sourceDocumentNumber })
                  : tb('originalFromWbs', { date: formatDate(original.createdAt) })
                : tb('noBaseline')}
              {revisions > 0 ? <span className="text-slate-400 dark:text-slate-500"> · {tb('revisions', { count: revisions })}</span> : null}
            </p>
            {baselines.length > 0 ? (
              <DisclosureSection title={tb('history')} className="mt-2 pt-2">
                <ol className="space-y-1.5">
                  {[...baselines].reverse().map((baseline) => (
                    <li key={baseline.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                      <span className="min-w-0">
                        <span className="font-medium text-slate-700 dark:text-slate-200">{baseline.label}</span>
                        <span className="text-slate-400 dark:text-slate-500"> · {baseline.kind === 'original' ? tb('kind.original') : tb('kind.revised')} · {formatDate(baseline.createdAt)}</span>
                        <span className="block text-slate-500 dark:text-slate-400">{baseline.reason}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                        {tb('historyTotals', { cost: money(baseline.totalCost), price: money(baseline.totalPrice), hours: trimDecimal(baseline.totalHours) })}
                      </span>
                    </li>
                  ))}
                </ol>
              </DisclosureSection>
            ) : null}
          </div>
        ) : null}

        <PagedTable
          rows={visibleTasks}
          rowKey={(task) => task.id}
          searchable
          searchLayout="drawer"
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
              key: 'estimatedPrice',
              header: tb('estPrice'),
              align: 'right',
              cell: (task) => <span className="tabular-nums">{task.estimatedPrice ? money(task.estimatedPrice) : '—'}</span>,
            },
            ...(productionQuantities ? [{
              key: 'budgetQuantity',
              header: tb('productionQuantity'),
              align: 'right' as const,
              cell: (task: WorkBreakdownTask) => (
                <span className="tabular-nums">{task.budgetQuantity ? `${trimDecimal(task.budgetQuantity)} ${task.budgetUnit}` : '—'}</span>
              ),
            }] : []),
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
            <div className="space-y-1.5">
              <Label>{tb('estPrice')}</Label>
              <Input
                inputMode="decimal"
                value={editor.estimatedPrice}
                onChange={(event) => setEditor((current) => current ? { ...current, estimatedPrice: event.target.value } : current)}
              />
            </div>
            {productionQuantities ? (
              <fieldset className="col-span-2 grid grid-cols-2 gap-4 border-t border-slate-200 pt-3 dark:border-slate-800">
                <legend className="col-span-2 text-xs font-semibold text-slate-700 dark:text-slate-200">{tb('productionQuantity')}</legend>
                <p className="col-span-2 -mt-2 text-xs text-slate-500 dark:text-slate-400">{tb('productionQuantityHint')}</p>
                <div className="space-y-1.5">
                  <Label>{tb('quantity')}</Label>
                  <Input
                    inputMode="decimal"
                    value={editor.budgetQuantity}
                    onChange={(event) => setEditor((current) => current ? { ...current, budgetQuantity: event.target.value } : current)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{tb('unit')}</Label>
                  <Input
                    value={editor.budgetUnit}
                    maxLength={32}
                    placeholder={tb('unitPlaceholder')}
                    onChange={(event) => setEditor((current) => current ? { ...current, budgetUnit: event.target.value } : current)}
                  />
                </div>
              </fieldset>
            ) : null}
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
