'use client'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Button, FieldLabel, Input, Select, Skeleton } from '@openbooks/ui'
import type { RoeSeparationFacts, RoeSeparationEmployee } from '@openbooks/engine/payroll/roe-separation-facts'
import { readApiErrorMessage } from '../../../../lib/api-error'

type State = { status: 'loading' } | { status: 'error'; message: string }
  | { status: 'ready'; record: RoeSeparationFacts | null; employee: RoeSeparationEmployee }

/** The employee's declaration stays in the shared ROE drawer, including refusal and retry. */
export function RoeSeparationFactsForm({ employeePartyId, canEdit, onSaved }: {
  employeePartyId: string; canEdit: boolean; onSaved: () => void
}) {
  const t = useTranslations('payroll.filings.separationFacts')
  const [state, setState] = useState<State>({ status: 'loading' })
  const [reload, setReload] = useState(0)
  const [firstDayWorked, setFirstDayWorked] = useState('')
  const [interruptionOn, setInterruptionOn] = useState('')
  const [lastInsurableEarningsOn, setLastInsurableEarningsOn] = useState('')
  const [salaryContinuanceEndOn, setSalaryContinuanceEndOn] = useState('')
  const [sourceReference, setSourceReference] = useState('')
  const [reason, setReason] = useState('')
  const [status, setStatus] = useState<'draft' | 'confirmed'>('draft')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setState({ status: 'loading' })
    void (async () => {
      const response = await fetch(`/api/payroll/separations/facts?employeePartyId=${encodeURIComponent(employeePartyId)}`)
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
      const body = await response.json() as { record: RoeSeparationFacts | null; employee: RoeSeparationEmployee }
      if (!alive) return
      setState({ status: 'ready', record: body.record, employee: body.employee })
      setFirstDayWorked(body.record?.firstDayWorked ?? '')
      setInterruptionOn(body.record?.interruptionOn ?? '')
      setLastInsurableEarningsOn(body.record?.lastInsurableEarningsOn ?? '')
      setSalaryContinuanceEndOn(body.record?.salaryContinuanceEndOn ?? '')
      setSourceReference(body.record?.sourceReference ?? '')
      setReason('')
      setStatus(body.record?.status === 'confirmed' ? 'confirmed' : 'draft')
      setError('')
    })().catch((cause: unknown) => {
      if (alive) setState({ status: 'error', message: cause instanceof Error ? cause.message : t('loadFailed') })
    })
    return () => { alive = false }
  }, [employeePartyId, reload, t])

  async function save() {
    if (!canEdit || busy || state.status !== 'ready') return
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/payroll/separations/facts', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeePartyId,
          employmentId: state.employee.employmentId, subsidiaryId: state.employee.subsidiaryId,
          firstDayWorked: firstDayWorked || null, interruptionOn, lastInsurableEarningsOn, salaryContinuanceEndOn: salaryContinuanceEndOn || null,
          sourceReference, reason, status, expectedId: state.record?.id ?? null,
          expectedUpdatedAt: state.record?.updatedAt ?? null }) })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('saveFailed')))
      const body = await response.json() as { record: RoeSeparationFacts }
      setState({ status: 'ready', record: body.record, employee: state.employee })
      onSaved()
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : t('saveFailed')) }
    finally { setBusy(false) }
  }
  const immutable = state.status === 'ready' && state.record?.status === 'issued'
  const disabled = !canEdit || busy || immutable
  return <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800" aria-label={t('title')}>
    <div><h3 className="text-sm font-semibold">{t('title')}</h3><p className="text-xs text-slate-500">{t('help')}</p></div>
    {state.status === 'loading' && <Skeleton className="h-24 w-full" />}
    {state.status === 'error' && <><Alert variant="warning"><AlertDescription>{state.message}</AlertDescription></Alert>
      <Button variant="outline" onClick={() => setReload(value => value + 1)}>{t('retry')}</Button></>}
    {state.status === 'ready' && <>
      {immutable && <Alert><AlertDescription>{t('issued')}</AlertDescription></Alert>}
      <p className="text-xs text-slate-500">{t('employer', { name: state.employee.employerName })}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><FieldLabel htmlFor="roe-first-worked">{t('firstWorked')}</FieldLabel>
          <Input id="roe-first-worked" type="date" value={firstDayWorked} onChange={event => setFirstDayWorked(event.target.value)} disabled={disabled} /></div>
        <div><FieldLabel htmlFor="roe-interruption">{t('interruption')}</FieldLabel>
          <Input id="roe-interruption" type="date" value={interruptionOn} onChange={event => setInterruptionOn(event.target.value)} disabled={disabled} /></div>
        <div><FieldLabel htmlFor="roe-last-insurable">{t('lastInsurable')}</FieldLabel>
          <Input id="roe-last-insurable" type="date" value={lastInsurableEarningsOn} onChange={event => setLastInsurableEarningsOn(event.target.value)} disabled={disabled} /></div>
        <div><FieldLabel htmlFor="roe-continuance">{t('continuance')}</FieldLabel>
          <Input id="roe-continuance" type="date" value={salaryContinuanceEndOn} onChange={event => setSalaryContinuanceEndOn(event.target.value)} disabled={disabled} /></div>
        <div><FieldLabel htmlFor="roe-facts-status">{t('status')}</FieldLabel>
          <Select id="roe-facts-status" value={status} onChange={event => setStatus(event.target.value as 'draft' | 'confirmed')} disabled={disabled}>
            <option value="draft">{t('draft')}</option><option value="confirmed">{t('confirmed')}</option></Select></div>
        <div><FieldLabel htmlFor="roe-source">{t('source')}</FieldLabel>
          <Input id="roe-source" value={sourceReference} onChange={event => setSourceReference(event.target.value)} maxLength={2000} disabled={disabled} /></div>
        <div><FieldLabel htmlFor="roe-facts-reason">{t('reason')}</FieldLabel>
          <Input id="roe-facts-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} disabled={disabled} /></div>
      </div>
      {error && <Alert variant="warning"><AlertDescription>{error}</AlertDescription></Alert>}
      {canEdit && !immutable && <Button onClick={() => void save()} disabled={disabled || !sourceReference.trim() || !reason.trim() || !interruptionOn || !lastInsurableEarningsOn || (status === 'confirmed' && !firstDayWorked)}>{busy ? t('saving') : t('save')}</Button>}
    </>}
  </section>
}
