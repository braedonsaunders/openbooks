'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Download, FileUp, LockKeyhole, MoreHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, DetailHeader, Input, Label, Popover, Select, Textarea } from '@openbooks/ui'
import { DetailPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { Pagination } from '../../../../components/pagination'
import { money } from '../../../../lib/format'
import { budgetFromUnits, budgetToUnits, spreadBudgetTotal, upliftBudgetAmount } from '../../../../lib/budget-math'
import type { BudgetDimensions, BudgetStatus, BudgetWorkspace } from '../../../../lib/budgets'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
type Cell = { accountId: string; periodId: string; amount: string }

const CREDIT_NORMAL = new Set(['income', 'income_other'])

export function BudgetScreen({
  initial,
  currentParams,
  dims,
  canManage,
  canApprove,
  canExport,
}: {
  initial: BudgetWorkspace
  currentParams: Record<string, string | string[] | undefined>
  dims: BudgetDimensions
  canManage: boolean
  canApprove: boolean
  canExport: boolean
}) {
  const t = useTranslations('budgets')
  const router = useRouter()
  const pathname = usePathname()
  const [scenario, setScenario] = useState(initial.scenario)
  const revisionRef = useRef(initial.scenario.revision)
  const [name, setName] = useState(initial.scenario.name)
  const [description, setDescription] = useState(initial.scenario.description ?? '')
  const [kind, setKind] = useState(initial.scenario.kind)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [busy, setBusy] = useState(false)
  const [uplift, setUplift] = useState('')
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRef = useRef(new Map<string, Cell>())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const metadataTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const accountType = useMemo(() => new Map(initial.accounts.map((account) => [account.id, account.type])), [initial.accounts])
  const creditAccount = useCallback((accountId: string) => CREDIT_NORMAL.has(accountType.get(accountId) ?? ''), [accountType])
  const toDisplay = useCallback((accountId: string, raw: string) => creditAccount(accountId) ? budgetFromUnits(-budgetToUnits(raw)) : raw, [creditAccount])
  const toStorage = useCallback((accountId: string, display: string) => creditAccount(accountId) ? budgetFromUnits(-budgetToUnits(display)) : display, [creditAccount])
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(
    initial.lines.map((line) => [`${line.accountId}|${line.periodId}`, toDisplay(line.accountId, line.amount)]),
  ))
  const editable = canManage && scenario.status === 'draft'

  const execute = useCallback(<T,>(url: string, method: string, payload: Record<string, unknown>): Promise<T> => {
    const task = chainRef.current.then(async () => {
      setSaveState('saving')
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, expectedRevision: revisionRef.current }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (response.status === 409 && data.error === 'revision_conflict') toast.error(t('feedback.revisionConflict'))
        throw new Error(data.error ?? 'request_failed')
      }
      if (typeof data.revision === 'number') {
        revisionRef.current = data.revision
        setScenario((current) => ({ ...current, revision: data.revision }))
      }
      setSaveState('saved')
      return data as T
    })
    chainRef.current = task.catch(() => undefined)
    return task
  }, [t])

  const flushCells = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const pending = [...pendingRef.current.values()]
    pendingRef.current.clear()
    if (pending.length === 0) return true
    try {
      await execute(`/api/budgets/${scenario.id}/lines`, 'PATCH', {
        cells: pending.map((cell) => ({ ...cell, amount: toStorage(cell.accountId, cell.amount), ...dims })),
      })
      return true
    } catch {
      pending.forEach((cell) => pendingRef.current.set(`${cell.accountId}|${cell.periodId}`, cell))
      setSaveState('error')
      toast.error(t('workspace.saveFailed'))
      return false
    }
  }, [dims, execute, scenario.id, t, toStorage])

  function queueCell(cell: Cell) {
    const key = `${cell.accountId}|${cell.periodId}`
    setValues((current) => ({ ...current, [key]: cell.amount }))
    pendingRef.current.set(key, cell)
    setSaveState('dirty')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void flushCells(), 700)
  }

  const metadataMounted = useRef(false)
  const saveMetadataNow = useCallback(async (): Promise<boolean> => {
    if (!editable) return true
    if (metadataTimer.current) clearTimeout(metadataTimer.current)
    try {
      await execute(`/api/budgets/${scenario.id}`, 'PATCH', { name, description, kind })
      return true
    } catch {
      setSaveState('error')
      toast.error(t('workspace.saveFailed'))
      return false
    }
  }, [description, editable, execute, kind, name, scenario.id, t])

  useEffect(() => {
    if (!metadataMounted.current) {
      metadataMounted.current = true
      return
    }
    if (!editable) return
    setSaveState('dirty')
    metadataTimer.current = setTimeout(() => void saveMetadataNow(), 700)
    return () => { if (metadataTimer.current) clearTimeout(metadataTimer.current) }
  }, [description, editable, kind, name, saveMetadataNow])

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (metadataTimer.current) clearTimeout(metadataTimer.current)
  }, [])

  const pageTotalUnits = useMemo(() => Object.entries(values).reduce((sum, [key, value]) => {
    if (!initial.accounts.some((account) => key.startsWith(`${account.id}|`))) return sum
    try { return sum + budgetToUnits(value || '0') } catch { return sum }
  }, 0n), [initial.accounts, values])
  const initialPageTotalUnits = useMemo(() => initial.lines.reduce((sum, line) => {
    try { return sum + budgetToUnits(toDisplay(line.accountId, line.amount)) } catch { return sum }
  }, 0n), [initial.lines, toDisplay])
  const sliceTotalUnits = useMemo(
    () => budgetToUnits(initial.sliceTotal) + pageTotalUnits - initialPageTotalUnits,
    [initial.sliceTotal, initialPageTotalUnits, pageTotalUnits],
  )

  function replaceUrl(key: string, value: string) {
    const params = new URLSearchParams()
    Object.entries(currentParams).forEach(([param, raw]) => {
      if (typeof raw === 'string') params.set(param, raw)
    })
    if (value) params.set(key, value)
    else params.delete(key)
    params.delete('page')
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  function spreadRow(accountId: string, total: string) {
    try {
      const amounts = spreadBudgetTotal(total || '0', initial.periods.length)
      initial.periods.forEach((period, index) => queueCell({ accountId, periodId: period.id, amount: amounts[index]! }))
    } catch {
      toast.error(t('workspace.saveFailed'))
    }
  }

  function upliftPage() {
    try {
      initial.accounts.forEach((account) => initial.periods.forEach((period) => {
        const key = `${account.id}|${period.id}`
        const current = values[key] ?? '0'
        if (budgetToUnits(current) !== 0n) queueCell({ accountId: account.id, periodId: period.id, amount: upliftBudgetAmount(current, uplift) })
      }))
    } catch {
      toast.error(t('workspace.saveFailed'))
    }
  }

  function clearPage() {
    if (!window.confirm(t('confirm.clearPage'))) return
    initial.accounts.forEach((account) => initial.periods.forEach((period) => queueCell({ accountId: account.id, periodId: period.id, amount: '0.0000' })))
  }

  async function action(actionName: string) {
    let reason: string | null = null
    if (actionName === 'submit' && !window.confirm(t('confirm.submit'))) return
    if (actionName === 'approve' && !window.confirm(t('confirm.approve'))) return
    if (actionName === 'archive' && !window.confirm(t('confirm.archive'))) return
    if (actionName === 'copy_prior_actuals' && !window.confirm(t('confirm.copyPriorActuals'))) return
    if (actionName === 'reject') {
      reason = window.prompt(t('confirm.rejectReason'))
      if (!reason) return
    }
    setBusy(true)
    try {
      if (!(await flushCells()) || !(await saveMetadataNow())) return
      const data = await execute<{ id?: string; status?: BudgetStatus; revision: number }>(`/api/budgets/${scenario.id}/actions`, 'POST', {
        action: actionName,
        reason,
        ...dims,
      })
      if (data.id) {
        toast.success(t('feedback.copied'))
        router.push(`/budgets/${data.id}`)
        return
      }
      if (data.status) setScenario((current) => ({ ...current, status: data.status! }))
      const feedback: Record<string, string> = {
        submit: 'submitted', withdraw: 'withdrawn', approve: 'approved', reject: 'rejected', archive: 'archived', copy_prior_actuals: 'actualsCopied',
      }
      toast.success(t(`feedback.${feedback[actionName]}`))
      router.refresh()
    } catch {
      setSaveState('error')
      toast.error(t('feedback.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function deleteDraft() {
    if (!window.confirm(t('confirm.delete'))) return
    setBusy(true)
    try {
      const response = await fetch(`/api/budgets/${scenario.id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('delete_failed')
      toast.success(t('feedback.deleted'))
      router.push('/budgets')
      router.refresh()
    } catch {
      toast.error(t('feedback.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  const badgeVariant = scenario.status === 'approved' ? 'success' : scenario.status === 'pending_approval' ? 'warning' : scenario.status === 'archived' ? 'outline' : 'secondary'
  const headerActions = <>
    <Button variant="outline" size="sm" asChild><Link href={`/reports/budget?scenario=${scenario.id}`}>{t('actions.openReport')}</Link></Button>
    {editable ? <Button size="sm" disabled={busy} onClick={() => void action('submit')}>{t('actions.submit')}</Button> : null}
    {scenario.status === 'pending_approval' && canManage ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void action('withdraw')}>{t('actions.withdraw')}</Button> : null}
    {scenario.status === 'pending_approval' && canApprove ? <>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void action('reject')}>{t('actions.reject')}</Button>
      <Button size="sm" disabled={busy} onClick={() => void action('approve')}>{t('actions.approve')}</Button>
    </> : null}
    <BudgetMoreActions scenario={scenario} canManage={canManage} canApprove={canApprove} canExport={canExport} busy={busy} onAction={action} onDelete={deleteDraft} />
  </>

  return <DetailPageLayout
    header={<DetailHeader
      back={{ href: '/budgets', label: t('workspace.back') }}
      title={name || scenario.name}
      subtitle={t('workspace.subtitle', { book: scenario.bookName, year: scenario.fiscalYear })}
      badge={<Badge variant={badgeVariant}>{t(`status.${scenario.status}`)}</Badge>}
      actions={headerActions}
    />}
    alerts={!editable ? <Alert variant="info" className="flex items-center gap-2"><LockKeyhole size={16} /><span>{t('workspace.locked')}</span></Alert> : undefined}
  >
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-4 pt-6 lg:grid-cols-[minmax(14rem,1fr)_minmax(20rem,2fr)_12rem]">
          <div className="space-y-1.5"><Label htmlFor="scenario-name">{t('workspace.name')}</Label><Input id="scenario-name" value={name} disabled={!editable} onChange={(event) => setName(event.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="scenario-description">{t('workspace.description')}</Label><Textarea id="scenario-description" rows={2} value={description} disabled={!editable} onChange={(event) => setDescription(event.target.value)} placeholder={t('workspace.descriptionPlaceholder')} /></div>
          <div className="space-y-1.5"><Label htmlFor="scenario-kind">{t('create.kind')}</Label><Select id="scenario-kind" value={kind} disabled={!editable} onChange={(event) => setKind(event.target.value as 'budget' | 'forecast')}><option value="budget">{t('kind.budget')}</option><option value="forecast">{t('kind.forecast')}</option></Select></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-3 pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><CardTitle className="text-base">{t('workspace.dimensions.title')}</CardTitle><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('workspace.sheetDescription')}</p></div>
            <div className="text-right"><div className="text-xs text-slate-500">{t('workspace.sliceTotal')}</div><div className="font-semibold tabular-nums">{money(budgetFromUnits(sliceTotalUnits))}</div></div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <DimensionSelect label={t('workspace.dimensions.department')} value={dims.departmentId ?? ''} options={initial.dimensions.departments} allLabel={t('workspace.dimensions.all')} onChange={(value) => replaceUrl('department', value)} />
            <DimensionSelect label={t('workspace.dimensions.project')} value={dims.projectId ?? ''} options={initial.dimensions.projects} allLabel={t('workspace.dimensions.all')} onChange={(value) => replaceUrl('project', value)} />
            <DimensionSelect label={t('workspace.dimensions.location')} value={dims.locationId ?? ''} options={initial.dimensions.locations} allLabel={t('workspace.dimensions.all')} onChange={(value) => replaceUrl('location', value)} />
            <DimensionSelect label={t('workspace.dimensions.class')} value={dims.classId ?? ''} options={initial.dimensions.classes} allLabel={t('workspace.dimensions.all')} onChange={(value) => replaceUrl('class', value)} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SearchInput placeholder={t('workspace.searchAccounts')} />
            {editable ? <div className="flex flex-wrap items-center gap-2">
              <Input className="h-8 w-28" inputMode="decimal" value={uplift} onChange={(event) => setUplift(event.target.value)} placeholder={t('workspace.uplift')} aria-label={t('workspace.uplift')} />
              <Button variant="outline" size="sm" disabled={!uplift} onClick={upliftPage}>{t('workspace.applyUplift')}</Button>
              <Button variant="outline" size="sm" onClick={clearPage}>{t('workspace.clearPage')}</Button>
              <Button variant="outline" size="sm" onClick={() => void action('copy_prior_actuals')}>{t('actions.copyPriorActuals')}</Button>
            </div> : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto border-y border-slate-200 dark:border-slate-800">
            <table className="w-full min-w-[1050px] border-collapse text-sm">
              <thead className="bg-slate-50 dark:bg-slate-950/50"><tr>
                <th className="sticky left-0 z-10 min-w-60 border-r border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium dark:border-slate-800 dark:bg-slate-950">{t('workspace.account')}</th>
                {initial.periods.map((period) => <th key={period.id} className="min-w-28 px-2 py-2 text-right font-medium">{period.name}</th>)}
                <th className="min-w-32 border-l border-slate-200 px-2 py-2 text-right font-medium dark:border-slate-800">{t('workspace.annualTotal')}</th>
              </tr></thead>
              <tbody>{initial.accounts.length ? initial.accounts.map((account) => {
                const annual = initial.periods.reduce((sum, period) => {
                  try { return sum + budgetToUnits(values[`${account.id}|${period.id}`] ?? '0') } catch { return sum }
                }, 0n)
                return <tr key={account.id} className="border-t border-slate-100 dark:border-slate-800/70">
                  <td className="sticky left-0 z-10 border-r border-slate-200 bg-white px-3 py-1.5 dark:border-slate-800 dark:bg-slate-900"><span className="font-mono text-xs text-slate-500">{account.number}</span><span className="ml-2 font-medium">{account.name}</span></td>
                  {initial.periods.map((period) => {
                    const key = `${account.id}|${period.id}`
                    return <td key={period.id} className="px-1 py-1"><Input className="h-8 min-w-24 text-right tabular-nums" inputMode="decimal" disabled={!editable} value={values[key] ?? ''} onChange={(event) => queueCell({ accountId: account.id, periodId: period.id, amount: event.target.value })} onBlur={() => void flushCells()} aria-label={`${account.name} ${period.name}`} /></td>
                  })}
                  <td className="border-l border-slate-200 px-1 py-1 dark:border-slate-800"><Input key={annual.toString()} className="h-8 min-w-28 text-right font-medium tabular-nums" inputMode="decimal" disabled={!editable} defaultValue={budgetFromUnits(annual)} onBlur={(event) => spreadRow(account.id, event.target.value)} aria-label={`${account.name} ${t('workspace.annualTotal')}`} /></td>
                </tr>
              }) : <tr><td colSpan={initial.periods.length + 2} className="px-4 py-10 text-center text-slate-500">{t('workspace.emptyAccounts')}</td></tr>}</tbody>
              <tfoot><tr className="border-t border-slate-200 bg-slate-50 font-semibold dark:border-slate-800 dark:bg-slate-950/50"><td className="sticky left-0 border-r border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950">{t('workspace.sliceTotal')}</td><td colSpan={initial.periods.length + 1} className="px-3 py-2 text-right tabular-nums">{money(budgetFromUnits(pageTotalUnits))}</td></tr></tfoot>
            </table>
          </div>
          <Pagination basePath={pathname} currentParams={currentParams} total={initial.totalAccounts} page={initial.page} perPage={initial.perPage} />
          <div className="flex items-center justify-between px-4 py-3 text-xs text-slate-500 dark:text-slate-400"><span>{saveState === 'saving' ? t('workspace.saving') : saveState === 'dirty' ? t('workspace.unsaved') : saveState === 'error' ? t('workspace.saveFailed') : t('workspace.saved')}</span></div>
        </CardContent>
      </Card>
      {editable ? <BudgetImport scenarioId={scenario.id} revisionRef={revisionRef} execute={execute} onCommitted={() => router.refresh()} /> : null}
    </div>
  </DetailPageLayout>
}

function DimensionSelect({ label, value, options, allLabel, onChange }: { label: string; value: string; options: { id: string; code: string | null; name: string }[]; allLabel: string; onChange: (value: string) => void }) {
  return <label className="space-y-1 text-xs font-medium text-slate-500 dark:text-slate-400"><span>{label}</span><Select className="h-8" value={value} onChange={(event) => onChange(event.target.value)}><option value="">{allLabel}</option>{options.map((option) => <option key={option.id} value={option.id}>{option.code ? `${option.code} · ` : ''}{option.name}</option>)}</Select></label>
}

function BudgetMoreActions({ scenario, canManage, canApprove, canExport, busy, onAction, onDelete }: { scenario: BudgetWorkspace['scenario']; canManage: boolean; canApprove: boolean; canExport: boolean; busy: boolean; onAction: (action: string) => Promise<void>; onDelete: () => Promise<void> }) {
  const t = useTranslations('budgets')
  const [open, setOpen] = useState(false)
  return <Popover open={open} onOpenChange={setOpen} align="end" className="w-56 p-1" trigger={<Button variant="outline" size="sm" aria-label={t('actions.copy')} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={16} /></Button>}>
    <div className="grid gap-1">
      {canManage ? <Button variant="ghost" size="sm" className="justify-start" disabled={busy} onClick={() => void onAction('copy')}>{t('actions.copy')}</Button> : null}
      {canExport ? <><Button variant="ghost" size="sm" className="justify-start" asChild><a href={`/api/budgets/${scenario.id}/export?format=xlsx`}><Download size={15} />{t('actions.exportXlsx')}</a></Button><Button variant="ghost" size="sm" className="justify-start" asChild><a href={`/api/budgets/${scenario.id}/export?format=csv`}><Download size={15} />{t('actions.exportCsv')}</a></Button></> : null}
      {canManage && scenario.status !== 'archived' && (scenario.status !== 'approved' || canApprove) ? <Button variant="ghost" size="sm" className="justify-start" disabled={busy} onClick={() => void onAction('archive')}>{t('actions.archive')}</Button> : null}
      {canManage && scenario.status === 'draft' ? <Button variant="ghost" size="sm" className="justify-start text-red-600 dark:text-red-400" disabled={busy} onClick={() => void onDelete()}>{t('actions.delete')}</Button> : null}
    </div>
  </Popover>
}

function BudgetImport({ scenarioId, revisionRef, execute, onCommitted }: { scenarioId: string; revisionRef: React.MutableRefObject<number>; execute: <T>(url: string, method: string, payload: Record<string, unknown>) => Promise<T>; onCommitted: () => void }) {
  const t = useTranslations('budgets')
  const [file, setFile] = useState<File | null>(null)
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [preview, setPreview] = useState<{ valid: boolean; rows: number; errors: { row: number; field: string; message: string }[] } | null>(null)
  const [busy, setBusy] = useState(false)
  async function encode(selected: File) {
    const format = selected.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv'
    if (format === 'csv') return { format, text: await selected.text() }
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.readAsDataURL(selected)
    })
    return { format, base64 }
  }
  async function validate() {
    if (!file) return
    setBusy(true)
    try {
      const encoded = await encode(file)
      setPayload(encoded)
      const response = await fetch(`/api/budgets/${scenarioId}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...encoded, expectedRevision: revisionRef.current }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      setPreview(data)
    } catch {
      toast.error(t('import.failed'))
    } finally { setBusy(false) }
  }
  async function commit() {
    if (!payload || !preview?.valid) return
    setBusy(true)
    try {
      const data = await execute<{ revision: number; imported: number }>(`/api/budgets/${scenarioId}/import`, 'POST', { ...payload, commit: true })
      toast.success(t('import.imported', { count: data.imported }))
      setFile(null); setPayload(null); setPreview(null); onCommitted()
    } catch { toast.error(t('import.failed')) } finally { setBusy(false) }
  }
  return <Card><CardHeader className="pb-3"><CardTitle className="flex items-center gap-2 text-base"><FileUp size={17} />{t('import.title')}</CardTitle><p className="text-sm text-slate-500 dark:text-slate-400">{t('import.description')}</p></CardHeader><CardContent className="space-y-3">
    <div className="flex flex-wrap items-center gap-2"><Input className="max-w-md" type="file" accept=".csv,.xlsx" aria-label={t('import.choose')} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null) }} /><Button variant="outline" size="sm" disabled={!file || busy} onClick={() => void validate()}>{t('import.preview')}</Button>{preview?.valid ? <Button size="sm" disabled={busy} onClick={() => void commit()}>{t('import.apply')}</Button> : null}</div>
    {preview ? <div className={preview.valid ? 'text-sm text-emerald-700 dark:text-emerald-300' : 'text-sm text-red-700 dark:text-red-300'}>{preview.valid ? t('import.valid', { count: preview.rows }) : t('import.invalid', { count: preview.errors.length })}</div> : null}
    {preview && !preview.valid ? <ul className="max-h-40 space-y-1 overflow-auto text-xs text-red-700 dark:text-red-300">{preview.errors.slice(0, 50).map((error, index) => <li key={`${error.row}-${error.field}-${index}`}>{t('import.rowError', error)}</li>)}</ul> : null}
  </CardContent></Card>
}
