'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select } from '@openbooks/ui'
import type { HeaderFieldPlacement } from '@openbooks/customization'
import { CustomFieldInput } from '../../../../components/custom-field-input'
import type { CustomFieldDefClient } from '../../../../components/custom-field-inputs'
import { HeaderFields } from '../../../../components/transaction-form/header-fields'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { DrawerTabStrip } from '../../../../components/drawer-tab-strip'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '../../../../components/dirty-url-drawer'
import { confirmDialog } from '../../../../lib/confirm'
import { promptDialog } from '../../../../lib/prompt'
import { isRetainerItemEligible } from '../../../../lib/resourcing/retainer-items'
import type { RetainerDrawerData, RetainerDrawdownRow, RetainerEvidenceRow, RetainerRecognitionRow } from './view'

type RetainerFields = {
  projectId: string
  customerPartyId: string
  kind: 'hours' | 'fees'
  totalAmount: string
  totalHours: string
  unitRate: string
  startsOn: string
  endsOn: string
  retainerItemId: string
  custom: Record<string, unknown>
}

type Tab = 'terms' | 'drawdowns' | 'evidence' | 'recognition'
type Refusal = { message: string; remedy?: string; fields?: Record<string, string[]> }

const statusVariant: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  draft: 'outline',
  active: 'success',
  exhausted: 'secondary',
  expired: 'warning',
  closed: 'secondary',
}

function initialFields(drawer: RetainerDrawerData): RetainerFields {
  const retainer = drawer.retainer
  return {
    projectId: retainer?.projectId ?? '',
    customerPartyId: retainer?.customerPartyId ?? '',
    kind: retainer?.kind ?? 'hours',
    totalAmount: retainer?.totalAmount ?? '',
    totalHours: retainer?.totalHours ?? '',
    unitRate: retainer?.unitRate ?? '',
    startsOn: retainer?.startsOn ?? '',
    endsOn: retainer?.endsOn ?? '',
    retainerItemId: retainer?.retainerItemId ?? '',
    custom: { ...(retainer?.custom ?? {}) },
  }
}

function idFor(placement: HeaderFieldPlacement, prefix: string): string {
  return `${prefix}-${placement.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function RetainerDrawer({ drawer }: { drawer: RetainerDrawerData }) {
  const t = useTranslations('resourcing.retainers')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const formId = useMemo(() => `retainer-${drawer.remountKey}`, [drawer.remountKey])
  const [fields, setFields] = useState<RetainerFields>(() => initialFields(drawer))
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialFields(drawer)))
  const [tab, setTab] = useState<Tab>('terms')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const idempotencyKey = useRef<string | null>(null)
  const retainer = drawer.retainer
  const status = retainer?.state ?? 'draft'
  // Terms are editable only in draft before an invoice is linked, saving
  // through PATCH. Every other state is read-only with the derived balance.
  const canEdit = drawer.canManage && (drawer.createMode || (status === 'draft' && retainer?.invoiceDocumentId === null))
  const fieldsText = JSON.stringify(fields)
  const dirty = fieldsText !== baseline
  const closeDrawer = useDirtyUrlDrawer(dirty, busy)
  const headerDefs = drawer.headerDefs as CustomFieldDefClient[]
  const customByKey = useMemo(() => new Map(headerDefs.map((def) => [def.key, def])), [headerDefs])
  const eligibleItems = useMemo(
    () => drawer.items.filter((item) => isRetainerItemEligible(fields.kind, item.rule)),
    [drawer.items, fields.kind],
  )
  const canDraftDrawdown = drawer.canManage && !drawer.createMode && status === 'active' && !drawer.activationRefusal

  function change<K extends keyof RetainerFields>(key: K, value: RetainerFields[K]) {
    setFields((current) => ({ ...current, [key]: value }))
    setRefusal(null)
  }

  function payload() {
    return {
      projectId: fields.projectId,
      customerPartyId: fields.customerPartyId,
      kind: fields.kind,
      ...(fields.kind === 'hours'
        ? { totalHours: fields.totalHours, unitRate: fields.unitRate }
        : { totalAmount: fields.totalAmount }),
      startsOn: fields.startsOn,
      endsOn: fields.endsOn,
      retainerItemId: fields.retainerItemId,
      custom: fields.custom,
    }
  }

  async function readRefusal(response: Response): Promise<Refusal> {
    const body = await response.json().catch(() => null) as {
      message?: string
      remedy?: string
      error?: string
    } | null
    const fieldErrors = body && 'fieldErrors' in body ? body.fieldErrors : undefined
    const fieldMap = fieldErrors && typeof fieldErrors === 'object'
      ? fieldErrors as Record<string, string[]>
      : undefined
    return {
      message: body?.message ?? body?.error ?? t('drawer.saveFailed'),
      remedy: body?.remedy,
      fields: fieldMap,
    }
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const create = drawer.createMode
      if (create && !idempotencyKey.current) idempotencyKey.current = crypto.randomUUID()
      const response = await fetch(create ? '/api/resourcing/retainers' : `/api/resourcing/retainers/${retainer!.id}`, {
        method: create ? 'POST' : 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(create ? { 'Idempotency-Key': idempotencyKey.current! } : {}),
        },
        body: JSON.stringify(payload()),
      })
      if (!response.ok) {
        setRefusal(await readRefusal(response))
        return
      }
      if (create) {
        const result = await response.json() as { id?: unknown }
        if (typeof result.id !== 'string' || !result.id) {
          setRefusal({ message: t('drawer.saveFailed') })
          return
        }
        setBaseline(fieldsText)
        router.push(`/resourcing/retainers?retainer=${result.id}`)
        router.refresh()
        return
      }
      setBaseline(fieldsText)
      router.refresh()
    } catch {
      setRefusal({ message: t('drawer.saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  async function runAction(url: string, body?: Record<string, unknown>) {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) {
        setRefusal(await readRefusal(response))
        return
      }
      router.refresh()
    } catch {
      setRefusal({ message: t('drawer.saveFailed') })
    } finally {
      setBusy(false)
    }
  }

  async function createInvoice() {
    if (!retainer) return
    await runAction(`/api/resourcing/retainers/${retainer.id}/invoice`)
  }

  async function draftDrawdown() {
    if (!retainer) return
    const sunday = await promptDialog({ title: t('drawer.drawdowns.weekTitle'), label: t('drawer.drawdowns.weekLabel') })
    if (!sunday) return
    if (retainer.kind === 'fees') {
      const amount = await promptDialog({ title: t('drawer.drawdowns.amountTitle'), label: t('drawer.drawdowns.amountLabel') })
      if (!amount) return
      await runAction(`/api/resourcing/retainers/${retainer.id}/drawdowns`, { sunday, amount })
      return
    }
    await runAction(`/api/resourcing/retainers/${retainer.id}/drawdowns`, { sunday })
  }

  async function postDrawdown(drawdownId: string) {
    if (!retainer) return
    await runAction(`/api/resourcing/retainers/${retainer.id}/drawdowns/${drawdownId}/post`)
  }

  async function extend() {
    if (!retainer) return
    const newEndsOn = await promptDialog({
      title: t('drawer.extendTitle'),
      label: t('drawer.extendLabel'),
      initialValue: retainer.endsOn,
    })
    if (!newEndsOn) return
    await runAction(`/api/resourcing/retainers/${retainer.id}/extend`, { newEndsOn })
  }

  async function close() {
    if (!retainer) return
    const confirmed = await confirmDialog({ message: t('drawer.closeConfirm'), confirmLabel: t('drawer.actions.close'), tone: 'danger' })
    if (!confirmed) return
    await runAction(`/api/resourcing/retainers/${retainer.id}/close`)
  }

  function renderField(placement: HeaderFieldPlacement, editable: boolean) {
    const label = placement.labelOverride?.trim()
    const required = placement.required === true && editable
    const id = idFor(placement, formId)
    const fieldLabel = (fallback: string) => <Label htmlFor={id}>{label || fallback}{required ? <span className="text-red-500"> *</span> : null}</Label>
    if (placement.key.startsWith('cf_')) {
      const key = placement.key.slice(3)
      const definition = customByKey.get(key)
      if (!definition) return null
      const fieldError = refusal?.fields?.[key]?.join(' ')
      return <>
        <CustomFieldInput
          def={{ ...definition, label: label || definition.label, isRequired: placement.required ?? definition.isRequired }}
          value={fields.custom[key]}
          onChange={(value) => change('custom', { ...fields.custom, [key]: value })}
          readOnly={!editable}
        />
        {fieldError ? <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">{fieldError}</p> : null}
      </>
    }
    switch (placement.key) {
      case 'project_id':
        return <>{fieldLabel(t('drawer.fields.project'))}{editable
          ? <Select id={id} value={fields.projectId} onChange={(event) => change('projectId', event.target.value)}>
              <option value="">{t('drawer.fields.choose')}</option>
              {drawer.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </Select>
          : <p className="text-sm">{drawer.projectName ?? '—'}</p>}</>
      case 'customer_party_id':
        return <>{fieldLabel(t('drawer.fields.customer'))}{editable
          ? <Select id={id} value={fields.customerPartyId} onChange={(event) => change('customerPartyId', event.target.value)}>
              <option value="">{t('drawer.fields.choose')}</option>
              {drawer.customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
            </Select>
          : <p className="text-sm">{drawer.customerName ?? '—'}</p>}</>
      case 'kind':
        return <>{fieldLabel(t('drawer.fields.kind'))}{editable
          ? <Select id={id} value={fields.kind} onChange={(event) => {
              const nextKind = event.target.value === 'fees' ? 'fees' : 'hours'
              // A kind change can hide the selected item from the filtered
              // picker; keep it only while it stays eligible, so the
              // submitted id is always one the operator can see.
              const current = drawer.items.find((item) => item.id === fields.retainerItemId) ?? null
              setFields((previous) => ({
                ...previous,
                kind: nextKind,
                retainerItemId: current && isRetainerItemEligible(nextKind, current.rule) ? previous.retainerItemId : '',
              }))
              setRefusal(null)
            }}>
              <option value="hours">{t('drawer.kind.hours')}</option>
              <option value="fees">{t('drawer.kind.fees')}</option>
            </Select>
          : <p className="text-sm">{t(`drawer.kind.${fields.kind}`)}</p>}</>
      case 'total_amount':
        if (fields.kind !== 'fees') return null
        return <>{fieldLabel(t('drawer.fields.totalAmount'))}{editable
          ? <Input id={id} inputMode="decimal" className="tabular-nums" value={fields.totalAmount} onChange={(event) => change('totalAmount', event.target.value)} />
          : <p className="text-sm tabular-nums">{fields.totalAmount}</p>}</>
      case 'total_hours':
        if (fields.kind !== 'hours') return null
        return <>{fieldLabel(t('drawer.fields.totalHours'))}{editable
          ? <Input id={id} inputMode="decimal" className="tabular-nums" value={fields.totalHours} onChange={(event) => change('totalHours', event.target.value)} />
          : <p className="text-sm tabular-nums">{fields.totalHours}</p>}</>
      case 'unit_rate':
        if (fields.kind !== 'hours') return null
        return <>{fieldLabel(t('drawer.fields.unitRate'))}{editable
          ? <Input id={id} inputMode="decimal" className="tabular-nums" value={fields.unitRate} onChange={(event) => change('unitRate', event.target.value)} />
          : <p className="text-sm tabular-nums">{fields.unitRate}</p>}</>
      case 'starts_on':
        return <>{fieldLabel(t('drawer.fields.startsOn'))}{editable
          ? <Input id={id} type="date" value={fields.startsOn} onChange={(event) => change('startsOn', event.target.value)} />
          : <p className="font-mono text-sm">{fields.startsOn}</p>}</>
      case 'ends_on':
        return <>{fieldLabel(t('drawer.fields.endsOn'))}{editable
          ? <Input id={id} type="date" value={fields.endsOn} onChange={(event) => change('endsOn', event.target.value)} />
          : <p className="font-mono text-sm">{fields.endsOn}</p>}</>
      case 'retainer_item_id':
        return <>{fieldLabel(t('drawer.fields.retainerItem'))}{editable
          ? (eligibleItems.length > 0
              ? <Select id={id} value={fields.retainerItemId} onChange={(event) => change('retainerItemId', event.target.value)}>
                  <option value="">{t('drawer.fields.choose')}</option>
                  {eligibleItems.map((item) => <option key={item.id} value={item.id}>{item.code ? `${item.code} · ${item.name}` : item.name}</option>)}
                </Select>
              : <p className="text-sm text-slate-500">{t('drawer.noEligibleItem')}</p>)
          : <p className="text-sm">{drawer.itemName ?? '—'}</p>}</>
      default:
        return null
    }
  }

  const drawdownColumns: PagedColumn<RetainerDrawdownRow>[] = [
    { key: 'week', header: t('drawer.drawdowns.week'), cell: (row) => <span className="font-mono">{row.weekStart}</span>, search: (row) => row.weekStart },
    { key: 'hours', header: t('drawer.drawdowns.hours'), align: 'right', cell: (row) => <span className="tabular-nums">{row.hours}</span> },
    { key: 'amount', header: t('drawer.drawdowns.amount'), align: 'right', cell: (row) => <span className="tabular-nums">{row.amount}</span> },
    {
      key: 'state',
      header: t('drawer.drawdowns.state'),
      cell: (row) => <Badge variant={row.state === 'posted' ? 'success' : 'outline'}>{t(`drawer.drawdownState.${row.state}`)}</Badge>,
      search: (row) => row.state,
    },
    ...(canDraftDrawdown ? [{
      key: 'post',
      header: '',
      cell: (row: RetainerDrawdownRow) => row.state === 'draft'
        ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void postDrawdown(row.id)}>{t('drawer.actions.post')}</Button>
        : null,
    }] : []),
  ]

  const evidenceColumns: PagedColumn<RetainerEvidenceRow>[] = [
    { key: 'date', header: t('drawer.evidence.date'), cell: (row) => <span className="font-mono">{row.workedOn}</span>, search: (row) => row.workedOn },
    { key: 'person', header: t('drawer.evidence.person'), cell: (row) => row.personName ?? '—', search: (row) => row.personName ?? '' },
    { key: 'hours', header: t('drawer.evidence.hours'), align: 'right', cell: (row) => <span className="tabular-nums">{row.hours}</span> },
    { key: 'week', header: t('drawer.drawdowns.week'), cell: (row) => <span className="font-mono">{row.weekStart}</span>, search: (row) => row.weekStart },
  ]

  const contractHref = drawer.contractId ? `/revenue?contract=${drawer.contractId}` : '/revenue'
  const recognitionColumns: PagedColumn<RetainerRecognitionRow>[] = [
    {
      key: 'month',
      header: t('drawer.recognition.month'),
      cell: (row) => <a className="font-mono underline" href={contractHref}>{row.periodMonth.slice(0, 7)}</a>,
      search: (row) => row.periodMonth,
    },
    { key: 'amount', header: t('drawer.recognition.amount'), align: 'right', cell: (row) => <span className="tabular-nums">{row.amount}</span> },
    {
      key: 'posted',
      header: t('drawer.recognition.posted'),
      cell: (row) => <Badge variant={row.reversed ? 'warning' : row.posted ? 'success' : 'outline'}>
        {t(row.reversed ? 'drawer.recognition.reversed' : row.posted ? 'drawer.recognition.isPosted' : 'drawer.recognition.pending')}
      </Badge>,
    },
  ]

  const tabs = [
    { key: 'terms' as const, label: t('drawer.tabs.terms') },
    { key: 'drawdowns' as const, label: t('drawer.tabs.drawdowns') },
    { key: 'evidence' as const, label: t('drawer.tabs.evidence') },
    { key: 'recognition' as const, label: t('drawer.tabs.recognition') },
  ]

  const title = drawer.createMode ? t('drawer.newTitle') : (drawer.projectName ?? t('drawer.title'))
  // Exhausted, expired and closed are read-only. Extend and Close show only
  // while active; a draft keeps its create-invoice action only.
  const showExtend = drawer.canManage && !drawer.createMode && status === 'active'
  const showClose = drawer.canManage && !drawer.createMode && status === 'active'

  return <DirtyUrlDrawer open closeHref={drawer.closeHref} size="2xl" title={title} description={t('drawer.description')}
    subtabs={<DrawerTabStrip ariaLabel={t('drawer.tabs.label')} activeKey={tab} onSelect={setTab} tabs={tabs} />}
    headerActions={canEdit || (drawer.canManage && !drawer.createMode) ? <div className="flex flex-wrap items-center gap-1.5">
      {canEdit ? <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('drawer.actions.saving') : t('drawer.actions.save')}</Button> : null}
      {!drawer.createMode && status === 'draft' && !retainer?.invoiceDocumentId && drawer.canManage
        ? <Button size="sm" disabled={busy || dirty} onClick={() => void createInvoice()}>{t('drawer.actions.createInvoice')}</Button> : null}
      {showExtend ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void extend()}>{t('drawer.actions.extend')}</Button> : null}
      {showClose ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void close()}>{t('drawer.actions.close')}</Button> : null}
    </div> : undefined}
    footer={<div className="flex w-full items-center gap-3"><Badge variant={statusVariant[status] ?? 'outline'}>{t(`drawer.status.${status}`)}</Badge><span className="text-xs text-slate-500 dark:text-slate-400">{dirty ? t('drawer.unsaved') : null}</span><span className="flex-1" />{dirty ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void closeDrawer()}>{tCommon('actions.cancel')}</Button> : null}</div>}
  >
    {refusal ? <div role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
      <p>{refusal.message}</p>
      {refusal.remedy ? <p className="mt-1 font-medium">{refusal.remedy}</p> : null}
      {refusal.fields ? <ul className="mt-1 list-disc pl-5">{Object.entries(refusal.fields).flatMap(([key, messages]) => messages.map((message) => <li key={`${key}:${message}`}>{message}</li>))}</ul> : null}
    </div> : null}
    {drawer.activationRefusal ? <div role="alert" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
      <p>{drawer.activationRefusal.message}</p>
      {drawer.activationRefusal.remedy ? <p className="mt-1 font-medium">{drawer.activationRefusal.remedy}</p> : null}
    </div> : null}
    {tab === 'terms' ? <div className="space-y-4 p-1">
      {!drawer.createMode && retainer ? <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/50">
        <p><strong>{t('drawer.balance')}:</strong> <span className="tabular-nums">{retainer.balance} {retainer.currency}</span></p>
        {status === 'draft' && !retainer.invoiceDocumentId
          ? <p className="mt-1">{t('drawer.noInvoiceHint')}</p>
          : null}
        {status === 'draft' && retainer.invoiceDocumentId && drawer.invoice && drawer.invoice.status !== 'posted'
          ? <p className="mt-1">{t('drawer.activatesOnPost')} <a className="underline" href={`/ar/invoices?doc=${drawer.invoice.id}`}>{drawer.invoice.number}</a></p>
          : null}
      </div> : null}
      <HeaderFields layout={drawer.layout} editable={canEdit} renderField={renderField} />
    </div> : null}
    {tab === 'drawdowns' ? <div className="space-y-3 p-1">
      {canDraftDrawdown ? <div><Button size="sm" disabled={busy} onClick={() => void draftDrawdown()}>{t('drawer.actions.draftDrawdown')}</Button></div> : null}
      {!drawer.createMode && status === 'draft' ? <p className="text-sm text-slate-500">{t('drawer.activatesHint')}</p> : null}
      <PagedTable
        rows={drawer.drawdowns}
        columns={drawdownColumns}
        rowKey={(row) => row.id}
        searchable
        empty={<p className="py-8 text-center text-sm text-slate-500">{t('drawer.drawdowns.empty')}</p>}
      />
    </div> : null}
    {tab === 'evidence' ? <div className="space-y-3 p-1">
      <PagedTable
        rows={drawer.evidence}
        columns={evidenceColumns}
        rowKey={(row) => row.timeEntryId}
        searchable
        empty={<p className="py-8 text-center text-sm text-slate-500">{t('drawer.evidence.empty')}</p>}
      />
    </div> : null}
    {tab === 'recognition' ? <div className="space-y-3 p-1">
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('drawer.recognition.hint')} <a className="underline" href={contractHref}>{t('drawer.recognition.runLink')}</a></p>
      <PagedTable
        rows={drawer.recognition}
        columns={recognitionColumns}
        rowKey={(row) => row.periodMonth}
        searchable
        empty={<p className="py-8 text-center text-sm text-slate-500">{t('drawer.recognition.empty')}</p>}
      />
    </div> : null}
    <div className="sr-only" aria-live="polite">{dirty ? t('drawer.unsaved') : ''}</div>
  </DirtyUrlDrawer>
}
