'use client'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Button, FieldLabel, Input, Skeleton } from '@openbooks/ui'
import { CabinetFilePicker } from '../../../../components/cabinet-file-picker'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { RoeSeparationFacts } from '@openbooks/engine/payroll/roe-separation-facts'
import type { readRoeSubsequentServiceContext } from '@openbooks/engine/payroll/canada/roe-subsequent-service'
type Context = Awaited<ReturnType<typeof readRoeSubsequentServiceContext>>
type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; context: Context }

/** The certificate belongs to the selected interruption and its original employment. */
export function RoeSubsequentServiceForm({ employeePartyId, event, canEdit, onSaved }: {
  employeePartyId: string; event: RoeSeparationFacts; canEdit: boolean; onSaved: () => void
}) {
  const t = useTranslations('payroll')
  const text = (key: string, fallback: string) => t.has(('filings.subsequentService.' + key) as never)
    ? t(('filings.subsequentService.' + key) as never) : fallback
  const hydrated = useRef('')
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [fileId, setFileId] = useState(''), [firstDayWorked, setFirstDayWorked] = useState('')
  const [sourceReference, setSourceReference] = useState(''), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); let active = true
    const timer = setTimeout(() => controller.abort(), 15000)
    setState({ kind: 'loading' })
    void (async () => {
      if (!event.employmentId || !event.subsidiaryId) throw new Error('The selected event has no confirmed employment and legal employer; qualify its original source before recording a return')
      const params = new URLSearchParams({ employeePartyId, employmentId: event.employmentId,
        subsidiaryId: event.subsidiaryId, precedingEventId: event.id })
      if (fileId) params.set('sourceFileId', fileId)
      const response = await fetch('/api/payroll/separations/subsequent-service?' + params, { signal: controller.signal })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, 'Return-to-work evidence could not be loaded'))
      const context = await response.json() as Context
      if (active) setState({ kind: 'ready', context })
    })().catch((cause: unknown) => {
      if (active) setState({ kind: 'error', message: cause instanceof Error ? cause.message : 'Return-to-work evidence could not be loaded' })
    }).finally(() => clearTimeout(timer))
    return () => { active = false; clearTimeout(timer); controller.abort() }
  }, [employeePartyId, event.id, event.employmentId, event.subsidiaryId, fileId, reload])
  const record = state.kind === 'ready' ? state.context.record : null
  useEffect(() => {
    if (!record || hydrated.current === record.id + ':' + record.updatedAt) return
    hydrated.current = record.id + ':' + record.updatedAt
    setFirstDayWorked(record.firstDayWorked); setSourceReference(record.sourceReference); setReason(record.reason)
  }, [record])
  const disabled = !canEdit || busy || event.status !== 'confirmed' || !event.employmentId || !event.subsidiaryId
  async function save() {
    if (disabled || state.kind !== 'ready' || !state.context.source) return
    const { source, record: current } = state.context
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/payroll/separations/subsequent-service', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employeePartyId,
          employmentId: event.employmentId, subsidiaryId: event.subsidiaryId, precedingEventId: event.id,
          firstDayWorked, sourceFileId: source.id, sourceVersionId: source.versionId, sourceSha256: source.sha256,
          sourceReference, reason, expectedId: current?.id ?? null, expectedUpdatedAt: current?.updatedAt ?? null }) })
      if (!response.ok) throw new Error(await readApiErrorMessage(response, 'Return-to-work evidence could not be saved'))
      const body = await response.json() as { record: NonNullable<Context['record']> }
      setState({ kind: 'ready', context: { ...state.context, record: body.record } })
      onSaved()
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : 'Return-to-work evidence could not be saved') }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
    <h3 className="text-sm font-semibold">{text('title', 'Return to work after this interruption')}</h3>
    <p className="text-xs text-slate-500">{text('help', 'Retain the original first day worked after this interruption, for the same employment and legal employer. A pay date or current hire date does not establish a return.')}</p>
    {event.status === 'issued' && <Alert><AlertDescription>{text('issued', 'This issued event retains its original return-to-work evidence. It cannot be changed here.')}</AlertDescription></Alert>}
    {canEdit && event.status === 'confirmed' && <CabinetFilePicker id="roe-return-file" value={fileId} onChange={setFileId}
      label={text('file', 'Original return-to-work source in File Cabinet')} disabled={busy} />}
    {state.kind === 'loading' && <Skeleton className="h-24 w-full" />}
    {state.kind === 'error' && <><Alert variant="warning"><AlertDescription>{state.message}</AlertDescription></Alert>
      <Button variant="outline" onClick={() => setReload(value => value + 1)}>{text('retry', 'Retry')}</Button></>}
    {state.kind === 'ready' && <>
      {record && <p className="text-xs text-slate-500">{text('retained', 'Retained return')}: {record.firstDayWorked} · {record.sourceReference}</p>}
      <div><FieldLabel htmlFor="roe-return-first-worked">{text('firstWorked', 'First day worked after returning')}</FieldLabel>
        <Input id="roe-return-first-worked" type="date" value={firstDayWorked} onChange={e => setFirstDayWorked(e.target.value)} disabled={disabled} /></div>
      {state.context.source && <p className="text-xs text-slate-500">{state.context.source.name}</p>}
      <div><FieldLabel htmlFor="roe-return-source">{text('reference', 'Employee and return reference in the source')}</FieldLabel>
        <Input id="roe-return-source" value={sourceReference} onChange={e => setSourceReference(e.target.value)} maxLength={2000} disabled={disabled} /></div>
      <div><FieldLabel htmlFor="roe-return-reason">{text('reason', 'Qualification or correction reason')}</FieldLabel>
        <Input id="roe-return-reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} disabled={disabled} /></div>
      {error && <Alert variant="warning"><AlertDescription>{error}</AlertDescription></Alert>}
      {canEdit && event.status === 'confirmed' && <Button onClick={() => void save()}
        disabled={busy || !state.context.source || !firstDayWorked || !sourceReference.trim() || !reason.trim()}>
        {busy ? text('saving', 'Saving…') : text('save', 'Save return-to-work evidence')}</Button>}
    </>}
  </section>
}
