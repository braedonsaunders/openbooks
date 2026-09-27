'use client'

import { useId, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, SearchSelect, Textarea } from '@openbooks/ui'
import type { DemandWeek } from '@/lib/resourcing/demand'
import { CustomFieldInputs, type CustomFieldDefClient } from '@/components/custom-field-inputs'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import { PagedTable, type PagedColumn } from '@/components/paged-table'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '@/components/dirty-url-drawer'
import { confirmDialog } from '@/lib/confirm'

type DemandForm = {
  departmentId: string
  jobTitle: string
  firstWeek: string
  lastWeek: string
  hoursPerWeek: string
  note: string
  opportunityId: string
  custom: Record<string, unknown>
}
type Option = { value: string; label: string }
export type DemandDrawerData = {
  remountKey: string
  row: DemandForm & { id: string; departmentName: string; departmentActive: boolean }
  departments: Option[]
  opportunities: Option[]
  fieldDefs: CustomFieldDefClient[]
  weights: DemandWeek[]
  canManage: boolean
  closeHref: string
  createMode: boolean
  opportunityOutsideScopeLabel: string
}

const fieldClass = 'space-y-1.5'

function formFromRow(row: DemandDrawerData['row']): DemandForm {
  return {
    departmentId: row.departmentId,
    jobTitle: row.jobTitle,
    firstWeek: row.firstWeek,
    lastWeek: row.lastWeek,
    hoursPerWeek: row.hoursPerWeek,
    note: row.note ?? '',
    opportunityId: row.opportunityId ?? '',
    custom: row.custom ?? {},
  }
}

function errorParts(value: unknown): { message: string; remedy: string | null; fieldErrors: Record<string, string> } {
  if (!value || typeof value !== 'object') return { message: '', remedy: null, fieldErrors: {} }
  const body = value as Record<string, unknown>
  const fieldErrors = body.errors && typeof body.errors === 'object' && !Array.isArray(body.errors)
    ? Object.fromEntries(Object.entries(body.errors).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : {}
  return {
    message: typeof body.error === 'string' ? body.error : '',
    remedy: typeof body.remedy === 'string' ? body.remedy : null,
    fieldErrors,
  }
}

export function DemandDrawer({ drawer }: { drawer: DemandDrawerData }) {
  const t = useTranslations('resourcing')
  const tc = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const fieldId = useId()
  const initial = useMemo(() => formFromRow(drawer.row), [drawer.row])
  const [form, setForm] = useState(initial)
  const [savedForm, setSavedForm] = useState(initial)
  const [tab, setTab] = useState<'details' | 'weighting'>('details')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const idempotencyKey = useRef<string | null>(null)
  const editable = drawer.canManage && !busy
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm)
  useDirtyUrlDrawer(dirty, busy)
  const opportunityOptions = [...drawer.opportunities]
  if (form.opportunityId && !opportunityOptions.some((option) => option.value === form.opportunityId)) {
    opportunityOptions.unshift({ value: form.opportunityId, label: drawer.opportunityOutsideScopeLabel })
  }
  const change = <K extends keyof DemandForm>(key: K, value: DemandForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setError('')
    setFieldErrors({})
  }

  async function readFailure(response: Response, fallback: string): Promise<void> {
    const body = await response.json().catch(() => null) as { message?: string; remedy?: string; error?: string } | null
    const details = errorParts(body)
    setError(Object.keys(details.fieldErrors).length
      ? t('demandLines.errors.customFields')
      : [body?.message ?? body?.error ?? fallback, body?.remedy].filter(Boolean).join(' '))
    setFieldErrors(details.fieldErrors)
  }

  async function save() {
    setBusy(true)
    setError('')
    setFieldErrors({})
    try {
      const create = drawer.createMode
      if (create && !idempotencyKey.current) idempotencyKey.current = crypto.randomUUID()
      const response = await fetch(create ? '/api/resourcing/demand' : `/api/resourcing/demand/${drawer.row.id}`, {
        method: create ? 'POST' : 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(create ? { 'Idempotency-Key': idempotencyKey.current! } : {}),
        },
        body: JSON.stringify({
          ...form,
          note: form.note || null,
          opportunityId: form.opportunityId || null,
        }),
      })
      if (!response.ok) {
        await readFailure(response, t('demandLines.errors.saveFailed'))
        return
      }
      const row = await response.json() as {
        id: string
        departmentId: string
        jobTitle: string
        firstWeek: string
        lastWeek: string
        hoursPerWeek: string
        note: string | null
        opportunityId: string | null
        custom: Record<string, unknown>
      }
      const next: DemandForm = {
        departmentId: row.departmentId,
        jobTitle: row.jobTitle,
        firstWeek: row.firstWeek,
        lastWeek: row.lastWeek,
        hoursPerWeek: row.hoursPerWeek,
        note: row.note ?? '',
        opportunityId: row.opportunityId ?? '',
        custom: row.custom ?? {},
      }
      setForm(next)
      setSavedForm(next)
      if (create) {
        const params = new URLSearchParams(searchParams.toString())
        params.set('demand', row.id)
        router.replace(`${pathname}?${params.toString()}`, { scroll: false })
      }
      router.refresh()
    } catch {
      setError(t('demandLines.errors.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    const confirmed = await confirmDialog({
      message: t('demandLines.drawer.deleteConfirm'),
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/resourcing/demand/${drawer.row.id}`, { method: 'DELETE' })
      if (!response.ok) {
        await readFailure(response, t('demandLines.errors.deleteFailed'))
        return
      }
      router.push(drawer.closeHref as never)
      router.refresh()
    } catch {
      setError(t('demandLines.errors.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  const weightingColumns: PagedColumn<DemandWeek>[] = [
    { key: 'week', header: t('demandLines.weighting.week'), cell: (row) => <span className="font-mono text-xs">{row.weekStart}</span>, search: (row) => row.weekStart },
    { key: 'stored', header: t('demandLines.weighting.storedHours'), align: 'right', cell: (row) => row.hoursPerWeek, search: (row) => row.hoursPerWeek },
    { key: 'basis', header: t('demandLines.weighting.basis'), cell: (row) => t(`demand.basis.${row.basis}`), search: (row) => row.basis },
    { key: 'probability', header: t('demand.probability'), align: 'right', cell: (row) => row.probability === null ? '—' : `${row.probability}%`, search: (row) => row.probability === null ? '' : String(row.probability) },
    { key: 'weighted', header: t('demand.weightedHours'), align: 'right', cell: (row) => row.weightedHours, search: (row) => row.weightedHours },
    { key: 'exclusion', header: t('demandLines.weighting.exclusion'), cell: (row) => row.excludedReason ? t(`demand.exclusion.${row.excludedReason}`) : '—', search: (row) => row.excludedReason ? t(`demand.exclusion.${row.excludedReason}`) : '' },
  ]

  const headerActions = drawer.canManage ? <div className="flex items-center gap-2">
    {!drawer.createMode ? <Button variant="outline" size="sm" disabled={busy} onClick={remove}>{tc('actions.delete')}</Button> : null}
    <Button size="sm" disabled={busy || (!drawer.createMode && !dirty)} onClick={save}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
  </div> : undefined
  const tabs = [
    { key: 'details' as const, label: t('demandLines.tabs.details') },
    { key: 'weighting' as const, label: t('demandLines.tabs.weighting') },
  ]

  return <DirtyUrlDrawer
    open
    openKey={drawer.remountKey}
    closeHref={drawer.closeHref}
    title={drawer.createMode ? t('demandLines.drawer.newTitle') : drawer.row.jobTitle}
    size="2xl"
    headerActions={headerActions}
    subtabs={<DrawerTabStrip ariaLabel={t('demandLines.tabs.aria')} activeKey={tab} onSelect={setTab} tabs={tabs} />}
  >
    {error ? <div role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error}</div> : null}
    {Object.keys(fieldErrors).length ? <div role="alert" className="mb-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
      <p>{t('demandLines.errors.customFields')}</p>
      <ul className="mt-1 list-disc pl-5">{Object.entries(fieldErrors).map(([key, message]) => <li key={key}>{message}</li>)}</ul>
    </div> : null}
    {tab === 'details' ? <div className="space-y-5 p-1">
      <section className="grid gap-4 sm:grid-cols-2">
        <div className={fieldClass}>
          <Label htmlFor={`${fieldId}-department`}>{t('demandLines.fields.department')}</Label>
          <SearchSelect id={`${fieldId}-department`} value={form.departmentId} onChange={(value) => change('departmentId', value)} options={drawer.departments} ariaLabel={t('demandLines.fields.department')} disabled={!editable} />
        </div>
        <div className={fieldClass}>
          <Label htmlFor={`${fieldId}-job-title`}>{t('demandLines.fields.jobTitle')}</Label>
          <Input id={`${fieldId}-job-title`} value={form.jobTitle} onChange={(event) => change('jobTitle', event.target.value)} disabled={!editable} />
        </div>
        <div className={fieldClass}>
          <Label htmlFor={`${fieldId}-first-week`}>{t('demandLines.fields.firstWeek')}</Label>
          <Input id={`${fieldId}-first-week`} type="date" value={form.firstWeek} onChange={(event) => change('firstWeek', event.target.value)} disabled={!editable} />
        </div>
        <div className={fieldClass}>
          <Label htmlFor={`${fieldId}-last-week`}>{t('demandLines.fields.lastWeek')}</Label>
          <Input id={`${fieldId}-last-week`} type="date" value={form.lastWeek} onChange={(event) => change('lastWeek', event.target.value)} disabled={!editable} />
        </div>
        <div className={fieldClass}>
          <Label htmlFor={`${fieldId}-hours`}>{t('demandLines.fields.hoursPerWeek')}</Label>
          <Input id={`${fieldId}-hours`} inputMode="decimal" value={form.hoursPerWeek} onChange={(event) => change('hoursPerWeek', event.target.value)} disabled={!editable} />
        </div>
        <div className={fieldClass}>
          <Label htmlFor={`${fieldId}-opportunity`}>{t('demandLines.fields.opportunity')}</Label>
          <SearchSelect id={`${fieldId}-opportunity`} value={form.opportunityId} onChange={(value) => change('opportunityId', value)} options={opportunityOptions} clearable emptyLabel={t('demandLines.fields.manual')} ariaLabel={t('demandLines.fields.opportunity')} disabled={!editable} />
        </div>
        <div className={`${fieldClass} sm:col-span-2`}>
          <Label htmlFor={`${fieldId}-note`}>{t('demandLines.fields.note')}</Label>
          <Textarea id={`${fieldId}-note`} rows={3} value={form.note} onChange={(event) => change('note', event.target.value)} disabled={!editable} />
        </div>
      </section>
      <CustomFieldInputs
        defs={drawer.fieldDefs}
        values={form.custom}
        onChange={(custom) => change('custom', custom)}
        readOnly={!editable}
      />
    </div> : null}
    {tab === 'weighting' ? <div className="space-y-3 p-1">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('demandLines.weighting.liveDescription')}</p>
      <PagedTable
        rows={drawer.weights}
        columns={weightingColumns}
        rowKey={(row) => `${row.lineId}:${row.weekStart}`}
        searchable
        empty={<p className="py-8 text-center text-sm text-slate-500">{t('demandLines.weighting.empty')}</p>}
      />
    </div> : null}
    <div className="sr-only" aria-live="polite">{dirty ? t('demandLines.drawer.unsavedChanges') : ''}</div>
  </DirtyUrlDrawer>
}
