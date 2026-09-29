'use client'

import { useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import type { HeaderFieldPlacement } from '@openbooks/customization'
import { CustomFieldInput } from '../../../../components/custom-field-input'
import type { CustomFieldDefClient } from '../../../../components/custom-field-inputs'
import { HeaderFields } from '../../../../components/transaction-form/header-fields'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { ApprovalActions, refreshApprovalState } from '../../../../components/approval-actions'
import { ApprovalHistory } from '../../../../components/approval-history'
import { DrawerTabStrip } from '../../../../components/drawer-tab-strip'
import { DirtyUrlDrawer, useDirtyUrlDrawer } from '../../../../components/dirty-url-drawer'
import { confirmDialog } from '../../../../lib/confirm'
import { promptDialog } from '../../../../lib/prompt'
import type { RequestDrawerData, RequestWeekPreview } from './view'

type RequestFields = {
  projectId: string
  employeePartyId: string
  jobTitle: string
  firstWeek: string
  lastWeek: string
  hoursPerWeek: string
  isBillable: boolean
  billItemId: string
  reason: string
  custom: Record<string, unknown>
}

type Tab = 'details' | 'weeks' | 'approval'
type Refusal = { message: string; remedy?: string; fields?: Record<string, string[]> }

const statusVariant: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  draft: 'outline',
  submitted: 'warning',
  approved: 'success',
  rejected: 'secondary',
  cancelled: 'secondary',
}

function initialFields(drawer: RequestDrawerData): RequestFields {
  const request = drawer.request;
  return {
    projectId: request?.projectId ?? '',
    employeePartyId: request?.employeePartyId ?? '',
    jobTitle: request?.jobTitle ?? '',
    firstWeek: request?.firstWeek ?? '',
    lastWeek: request?.lastWeek ?? '',
    hoursPerWeek: request?.hoursPerWeek ?? '',
    isBillable: request?.isBillable ?? true,
    billItemId: request?.billItemId ?? '',
    reason: request?.reason ?? '',
    custom: (request?.custom ?? {}) as Record<string, unknown>,
  }
}

function idFor(placement: HeaderFieldPlacement, prefix: string): string {
  return `${prefix}-${placement.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function RequestDrawer({ drawer }: { drawer: RequestDrawerData }) {
  const t = useTranslations('resourcing.requests')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const formId = useMemo(() => `resource-request-${drawer.remountKey}`, [drawer.remountKey])
  const [fields, setFields] = useState<RequestFields>(() => initialFields(drawer))
  const [baseline, setBaseline] = useState(() => JSON.stringify(initialFields(drawer)))
  const [subjectType, setSubjectType] = useState<'person' | 'role'>(() => drawer.request?.jobTitle ? 'role' : 'person')
  const [status, setStatus] = useState(drawer.request?.status ?? 'draft')
  const [decisionComment, setDecisionComment] = useState(drawer.request?.decisionComment ?? '')
  const [tab, setTab] = useState<Tab>('details')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const idempotencyKey = useRef<string | null>(null)
  const canEdit = drawer.canManage && (drawer.createMode || status === 'draft')
  const fieldsText = JSON.stringify(fields)
  const dirty = fieldsText !== baseline
  const closeDrawer = useDirtyUrlDrawer(dirty, busy)
  const headerDefs = drawer.headerDefs as CustomFieldDefClient[]
  const customByKey = useMemo(() => new Map(headerDefs.map((def) => [def.key, def])), [headerDefs])

  function change<K extends keyof RequestFields>(key: K, value: RequestFields[K]) {
    setFields((current) => ({ ...current, [key]: value }))
    setRefusal(null)
  }

  function payload() {
    return {
      projectId: fields.projectId,
      firstWeek: fields.firstWeek,
      lastWeek: fields.lastWeek,
      hoursPerWeek: fields.hoursPerWeek,
      isBillable: fields.isBillable,
      billItemId: fields.billItemId || null,
      reason: fields.reason || null,
      custom: fields.custom,
      ...(subjectType === 'person'
        ? { employeePartyId: fields.employeePartyId }
        : { jobTitle: fields.jobTitle }),
    }
  }

  async function readRefusal(response: Response): Promise<Refusal> {
    const body = await response.json().catch(() => null) as {
      message?: string
      remedy?: string
      error?: string
    } | null
    const fieldErrors = body && 'fieldErrors' in body ? body.fieldErrors : undefined
    const fields = fieldErrors && typeof fieldErrors === 'object'
      ? fieldErrors as Record<string, string[]>
      : undefined
    return {
      message: body?.message ?? body?.error ?? t('drawer.requestFailed'),
      remedy: body?.remedy,
      fields,
    }
  }

  async function save() {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const create = drawer.createMode
      if (create && !idempotencyKey.current) idempotencyKey.current = crypto.randomUUID()
      const response = await fetch(create ? '/api/resourcing/requests' : `/api/resourcing/requests/${drawer.request!.id}`, {
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
          setRefusal({ message: t('drawer.requestFailed') })
          return
        }
        setBaseline(fieldsText)
        const params = new URLSearchParams(searchParams.toString())
        params.set('request', result.id)
        params.delete('form')
        router.push(`${pathname}?${params.toString()}`)
      } else {
        setBaseline(fieldsText)
        router.refresh()
      }
    } catch {
      setRefusal({ message: t('drawer.requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (!drawer.request || dirty || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch(`/api/resourcing/requests/${drawer.request.id}/submit`, { method: 'POST' })
      if (!response.ok) {
        setRefusal(await readRefusal(response))
        return
      }
      setStatus('submitted')
      refreshApprovalState()
      router.refresh()
    } catch {
      setRefusal({ message: t('drawer.requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  async function cancelRequest() {
    if (!drawer.request || busy) return
    const reason = await promptDialog({
      title: t('drawer.cancelReasonTitle'),
      label: t('drawer.cancelReasonLabel'),
      confirmLabel: t('drawer.continue'),
    })
    if (!reason) return
    if (!(await confirmDialog({
      title: t('drawer.cancelConfirmTitle'),
      message: t('drawer.cancelConfirmMessage'),
      confirmLabel: t('drawer.actions.cancelRequest'),
      tone: 'danger',
    }))) return
    setBusy(true)
    setRefusal(null)
    try {
      const response = await fetch(`/api/resourcing/requests/${drawer.request.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!response.ok) {
        setRefusal(await readRefusal(response))
        return
      }
      setStatus('cancelled')
      setDecisionComment(reason)
      refreshApprovalState()
      router.refresh()
    } catch {
      setRefusal({ message: t('drawer.requestFailed') })
    } finally {
      setBusy(false)
    }
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
      return <CustomFieldInput
        def={{ ...definition, label: label || definition.label, isRequired: placement.required ?? definition.isRequired }}
        value={fields.custom[key]}
        onChange={(value) => change('custom', { ...fields.custom, [key]: value })}
        readOnly={!editable}
      />
    }
    switch (placement.key) {
      case 'project_id':
        return <>{fieldLabel(t('drawer.fields.project'))}{editable
          ? <Select id={id} value={fields.projectId} onChange={(event) => change('projectId', event.target.value)}>
              <option value="">{t('drawer.fields.choose')}</option>
              {drawer.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </Select>
          : <p className="text-sm">{drawer.projectName ?? '—'}</p>}</>
      case 'employee_party_id':
        if (subjectType !== 'person') return null
        return <>{fieldLabel(t('drawer.fields.person'))}{editable
          ? <Select id={id} value={fields.employeePartyId} onChange={(event) => change('employeePartyId', event.target.value)}>
              <option value="">{t('drawer.fields.choose')}</option>
              {drawer.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
            </Select>
          : <p className="text-sm">{drawer.employeeName ?? '—'}</p>}</>
      case 'job_title':
        if (subjectType !== 'role') return null
        return <>{fieldLabel(t('drawer.fields.jobTitle'))}{editable
          ? <Input id={id} value={fields.jobTitle} onChange={(event) => change('jobTitle', event.target.value)} />
          : <p className="text-sm">{fields.jobTitle || '—'}</p>}</>
      case 'first_week':
        return <>{fieldLabel(t('drawer.fields.firstWeek'))}{editable
          ? <Input id={id} type="date" value={fields.firstWeek} onChange={(event) => change('firstWeek', event.target.value)} />
          : <p className="font-mono text-sm">{fields.firstWeek}</p>}</>
      case 'last_week':
        return <>{fieldLabel(t('drawer.fields.lastWeek'))}{editable
          ? <Input id={id} type="date" value={fields.lastWeek} onChange={(event) => change('lastWeek', event.target.value)} />
          : <p className="font-mono text-sm">{fields.lastWeek}</p>}</>
      case 'hours_per_week':
        return <>{fieldLabel(t('drawer.fields.hoursPerWeek'))}{editable
          ? <Input id={id} inputMode="decimal" className="tabular-nums" value={fields.hoursPerWeek} onChange={(event) => change('hoursPerWeek', event.target.value)} />
          : <p className="text-sm tabular-nums">{fields.hoursPerWeek}</p>}</>
      case 'is_billable':
        return <>{fieldLabel(t('drawer.fields.billable'))}{editable
          ? <Select id={id} value={fields.isBillable ? 'true' : 'false'} onChange={(event) => change('isBillable', event.target.value === 'true')}>
              <option value="true">{t('drawer.fields.yes')}</option><option value="false">{t('drawer.fields.no')}</option>
            </Select>
          : <p className="text-sm">{t(fields.isBillable ? 'drawer.fields.yes' : 'drawer.fields.no')}</p>}</>
      case 'bill_item_id':
        return <>{fieldLabel(t('drawer.fields.billItem'))}{editable
          ? <Select id={id} value={fields.billItemId} onChange={(event) => change('billItemId', event.target.value)}>
              <option value="">{t('drawer.fields.noBillItem')}</option>
              {drawer.billItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </Select>
          : <p className="text-sm">{drawer.billItemName ?? '—'}</p>}</>
      case 'reason':
        return <>{fieldLabel(t('drawer.fields.reason'))}{editable
          ? <Textarea id={id} rows={3} value={fields.reason} onChange={(event) => change('reason', event.target.value)} />
          : <p className="whitespace-pre-wrap text-sm">{fields.reason || '—'}</p>}</>
      default:
        return null
    }
  }

  const weekColumns = useMemo<PagedColumn<RequestWeekPreview>[]>(() => [
    { key: 'week', header: t('drawer.weeks.week'), cell: (row) => <span className="font-mono">{row.weekStart}</span>, search: (row) => row.weekStart },
    { key: 'requested', header: t('drawer.weeks.requested'), align: 'right', cell: (row) => <span className="tabular-nums">{row.requestedHours}</span> },
    ...(drawer.request?.employeePartyId ? [
      { key: 'capacity', header: t('drawer.weeks.netCapacity'), align: 'right' as const, cell: (row: RequestWeekPreview) => <span className="tabular-nums">{row.netCapacity ?? t('drawer.weeks.unknown')}</span> },
      { key: 'hard', header: t('drawer.weeks.bookedHard'), align: 'right' as const, cell: (row: RequestWeekPreview) => <span className="tabular-nums">{row.hardHours ?? '—'}</span> },
      { key: 'overallocation', header: t('drawer.weeks.overallocation'), cell: (row: RequestWeekPreview) => row.overallocated === null
        ? <span className="text-slate-400">—</span>
        : <Badge variant={row.overallocated ? 'destructive' : 'success'}>{t(row.overallocated ? 'drawer.weeks.over' : 'drawer.weeks.within')}</Badge> },
    ] : []),
  ], [drawer.request?.employeePartyId, t]);

  const tabLabels: { key: Tab; label: string }[] = [
    { key: 'details', label: t('drawer.tabs.details') },
    { key: 'weeks', label: t('drawer.tabs.weeks') },
    { key: 'approval', label: t('drawer.tabs.approval') },
  ];

  const title = drawer.createMode ? t('drawer.newTitle') : (drawer.request?.jobTitle || drawer.employeeName || t('drawer.title'));
  const showRequestActions = !drawer.createMode && drawer.request !== null;
  const statusLabel = t(`drawer.status.${status}`);

  return <DirtyUrlDrawer open closeHref={drawer.closeHref} size="2xl" title={title} description={t('drawer.description')}
    subtabs={<DrawerTabStrip ariaLabel={t('drawer.tabs.label')} activeKey={tab} onSelect={setTab} tabs={tabLabels} />}
    headerActions={canEdit || (showRequestActions && (status === 'submitted' || status === 'draft') && drawer.canManage) ? <div className="flex flex-wrap items-center gap-1.5">
      {canEdit ? <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void save()}>{busy ? t('drawer.actions.saving') : t('drawer.actions.save')}</Button> : null}
      {showRequestActions && status === 'draft' && drawer.canManage ? <Button size="sm" disabled={busy || dirty} onClick={() => void submit()}>{t('drawer.actions.submit')}</Button> : null}
      {showRequestActions && (status === 'draft' || status === 'submitted') && drawer.canManage ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void cancelRequest()}>{t('drawer.actions.cancelRequest')}</Button> : null}
    </div> : undefined}
    footer={<div className="flex w-full items-center gap-3"><Badge variant={statusVariant[status] ?? 'outline'}>{statusLabel}</Badge><span className="text-xs text-slate-500 dark:text-slate-400">{dirty ? t('drawer.unsaved') : null}</span><span className="flex-1" />{dirty ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void closeDrawer()}>{tCommon('actions.cancel')}</Button> : null}</div>}
  >
    {refusal ? <div role="alert" className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
      <p>{refusal.message}</p>
      {refusal.remedy ? <p className="mt-1 font-medium">{refusal.remedy}</p> : null}
      {refusal.fields ? <ul className="mt-1 list-disc pl-5">{Object.entries(refusal.fields).flatMap(([key, messages]) => messages.map((message) => <li key={`${key}:${message}`}>{message}</li>))}</ul> : null}
    </div> : null}
    {tab === 'details' ? <div className="space-y-4 p-1">
      {canEdit ? <div className="max-w-xs space-y-1.5">
        <Label htmlFor={`${formId}-subject`}>{t('drawer.fields.requestFor')}</Label>
        <Select id={`${formId}-subject`} value={subjectType} disabled={!canEdit} onChange={(event) => {
          const value = event.target.value === 'role' ? 'role' : 'person';
          setSubjectType(value);
          if (value === 'role') setFields((current) => ({ ...current, employeePartyId: '' }));
          else setFields((current) => ({ ...current, jobTitle: '' }));
        }}>
          <option value="person">{t('drawer.fields.person')}</option>
          <option value="role">{t('drawer.fields.jobTitle')}</option>
        </Select>
      </div> : null}
      {drawer.request && ['approved', 'rejected', 'cancelled'].includes(status) && decisionComment
        ? <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/50"><strong>{t('drawer.decisionComment')}:</strong> {decisionComment}</div>
        : null}
      <HeaderFields layout={drawer.layout} editable={canEdit} renderField={renderField} />
    </div> : null}
    {tab === 'weeks' ? drawer.request
      ? <PagedTable rows={drawer.weeks} columns={weekColumns} rowKey={(row) => row.weekStart} empty={t('drawer.weeks.empty')} searchable />
      : <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('drawer.weeks.saveFirst')}</p>
      : null}
    {tab === 'approval' ? drawer.request
      ? <div className="space-y-4 p-1">
          <ApprovalActions subjectKind="resourcing_request" subjectId={drawer.request.id} />
          <ApprovalHistory subjectKind="resourcing_request" subjectId={drawer.request.id} showEmptyState />
          {decisionComment ? <div className="rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"><strong>{t('drawer.decisionComment')}:</strong> {decisionComment}</div> : null}
        </div>
      : <p className="p-4 text-sm text-slate-500 dark:text-slate-400">{t('drawer.approval.saveFirst')}</p>
      : null}
  </DirtyUrlDrawer>
}
