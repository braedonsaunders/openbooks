'use client'

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import type { PayrollPeriodOpeningView } from '@openbooks/engine/payroll/period-openings'
import { apiJson, ApiResponseError } from '@/lib/api-error'
import { MoneyInput, moneyFieldError } from '@/components/money-input'

export interface PeriodOpeningDraft {
  context: PayrollPeriodOpeningView
  payScheduleId: string
  currency: string
  periodStart: string
  periodEnd: string
  paidThrough: string
  sourceReference: string
  reason: string
  amounts: Record<string, string>
  dirty: boolean
  previewed: boolean
}

function loadedDraft(context: PayrollPeriodOpeningView): PeriodOpeningDraft {
  const record = context.record
  return { context, payScheduleId: record?.payScheduleId ?? context.assignedScheduleId ?? '',
    currency: record?.currency ?? context.baseCurrency, periodStart: record?.periodStart ?? '',
    periodEnd: record?.periodEnd ?? '', paidThrough: record?.paidThrough ?? '',
    sourceReference: record?.sourceReference ?? '', reason: record?.reason ?? '',
    amounts: record?.amounts ?? {}, dirty: false, previewed: false }
}

/** One employee's period share inside the existing opening-balances drawer. */
export function PeriodOpeningForm({ employeePartyId, employeeName, year, draft, onChange, canManage, locked, annualDirty, onBusyChange, onSaved }: {
  employeePartyId: string; employeeName: string; year: number; draft?: PeriodOpeningDraft;
  onChange: (draft: PeriodOpeningDraft) => void; canManage: boolean; locked: boolean; annualDirty: boolean;
  onBusyChange: (busy: boolean) => void; onSaved: () => void;
}) {
  const t = useTranslations('payroll.openingBalances.period')
  const id = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (draft?.context && reload === 0) return
    const controller = new AbortController()
    setBusy(true)
    setError(null)
    void apiJson<PayrollPeriodOpeningView>(`/api/payroll/period-openings?employeePartyId=${encodeURIComponent(employeePartyId)}&taxYear=${year}`,
      { signal: controller.signal }, t('loadFailed'))
      .then(context => {
        if (!controller.signal.aborted) onChange(draft?.dirty
          ? { ...draft, context, previewed: false }
          : loadedDraft(context))
      })
      .catch(cause => {
        if (!controller.signal.aborted) setError(cause instanceof ApiResponseError ? cause.message : t('loadFailed'))
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
    // Draft edits must not reload or overwrite the operator's input.
    // Reload is an explicit review of the current source and revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeePartyId, year, reload])

  function change(update: Partial<PeriodOpeningDraft>) {
    if (!draft) return
    onChange({ ...draft, ...update, dirty: true, previewed: false })
    setNotice(null)
    setError(null)
  }

  async function submit(dryRun: boolean) {
    if (!draft || busy || locked || !canManage || annualDirty) return
    if (!dryRun && !draft.previewed) return
    const context = draft.context
    if (!context.annualUpdatedAt) { setError(t('annualRequired')); return }
    for (const field of context.fields) {
      const refusal = moneyFieldError(field.label, 'a money amount', draft.amounts[field.key] ?? '', 4, { required: true })
      if (refusal) { setError(refusal); return }
    }
    setBusy(true)
    onBusyChange(true)
    setError(null)
    setNotice(null)
    try {
      const result = await apiJson<{ changed: boolean; record: PayrollPeriodOpeningView['record']; annualUpdatedAt: string }>(
        '/api/payroll/period-openings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          employeePartyId, taxYear: year, subsidiaryId: context.subsidiaryId, country: context.country,
          payScheduleId: draft.payScheduleId, currency: draft.currency, periodStart: draft.periodStart, periodEnd: draft.periodEnd,
          paidThrough: draft.paidThrough, amounts: draft.amounts, sourceReference: draft.sourceReference, reason: draft.reason,
          expectedRevision: context.record?.revision ?? null, expectedAnnualUpdatedAt: context.annualUpdatedAt, dryRun,
        }) }, t('saveFailed'))
      if (dryRun) {
        onChange({ ...draft, previewed: true })
        setNotice(t('previewPassed'))
      } else {
        if (!result.record || result.record.employeePartyId !== employeePartyId || !result.annualUpdatedAt) {
          throw new ApiResponseError(t('saveFailed'), 502)
        }
        onChange(loadedDraft({ ...context, record: result.record, annualUpdatedAt: result.annualUpdatedAt }))
        setNotice(t('saved'))
        onSaved()
      }
    } catch (cause) { setError(cause instanceof ApiResponseError ? cause.message : t('saveFailed')) }
    finally { setBusy(false); onBusyChange(false) }
  }

  const disabled = busy || locked || !canManage || annualDirty
  return <div className="space-y-5">
    <p className="text-sm text-slate-600 dark:text-slate-400">{t('description')}</p>
    {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="rounded-md bg-teal-50 p-3 text-sm text-teal-800 dark:bg-teal-950/40 dark:text-teal-200">{notice}</p>}
    {busy && !draft && <p role="status">{t('loading')}</p>}
    <Button variant="outline" disabled={busy} onClick={() => { setNotice(null); setReload(value => value + 1) }}>{t('reload')}</Button>
    {draft && <>
      <p className="text-sm font-medium">{employeeName} · {draft.context.employerName} · {year}</p>
      {annualDirty && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{t('annualDirty')}</p>}
      {!draft.context.annualUpdatedAt && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">{t('annualRequired')}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor={`${id}-schedule`}>{t('schedule')}</Label>
          <Select id={`${id}-schedule`} value={draft.payScheduleId} disabled={disabled} onChange={event => change({ payScheduleId: event.target.value })}>
            <option value="">{t('chooseSchedule')}</option>{draft.context.schedules.map(schedule => <option key={schedule.id} value={schedule.id}>{schedule.name}</option>)}
          </Select></div>
        <div className="space-y-1.5"><Label htmlFor={`${id}-currency`}>{t('currency')}</Label>
          <Select id={`${id}-currency`} value={draft.currency} disabled={disabled} onChange={event => change({ currency: event.target.value })}>
            {draft.context.currencies.map(currency => <option key={currency.value} value={currency.value}>{currency.label}</option>)}
          </Select></div>
        {(['periodStart', 'periodEnd', 'paidThrough'] as const).map(key => <div key={key} className="space-y-1.5">
          <Label htmlFor={`${id}-${key}`}>{t(key)}</Label><Input id={`${id}-${key}`} type="date" value={draft[key]} disabled={disabled} onChange={event => change({ [key]: event.target.value })} />
        </div>)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {draft.context.fields.map(field => <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label><MoneyInput id={`${id}-${field.key}`} ariaLabel={`${employeeName} — ${field.label}`}
            field={field.label} value={draft.amounts[field.key] ?? ''} required maxScale={4} disabled={disabled}
            onChange={value => change({ amounts: { ...draft.amounts, [field.key]: value } })} />
        </div>)}
      </div>
      <p className="text-xs text-slate-500">{t('explicitZeros')}</p>
      <div className="space-y-1.5"><Label htmlFor={`${id}-source`}>{t('sourceReference')}</Label><Input id={`${id}-source`} value={draft.sourceReference} maxLength={2000} disabled={disabled} onChange={event => change({ sourceReference: event.target.value })} /></div>
      <div className="space-y-1.5"><Label htmlFor={`${id}-reason`}>{t('reason')}</Label><Textarea id={`${id}-reason`} value={draft.reason} maxLength={2000} disabled={disabled} onChange={event => change({ reason: event.target.value })} /></div>
      {canManage && <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={disabled || !draft.context.annualUpdatedAt} onClick={() => void submit(true)}>{t('preview')}</Button>
        <Button disabled={disabled || !draft.previewed} onClick={() => void submit(false)}>{t('save')}</Button>
      </div>}
    </>}
  </div>
}
