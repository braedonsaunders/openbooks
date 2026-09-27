'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button, FieldLabel, Input, Select } from '@openbooks/ui'
import { promptDialog } from '../../../lib/prompt'
import { useAppAction } from '../../../lib/use-app-action'
import { fulfillmentRequest } from '../_fulfillment/fulfillment-client'
import type { ReturnAuthorization } from '@openbooks/engine/src/sales/returns.ts'

type Props = {
  authorization: ReturnAuthorization
  canInspect: boolean
  canManage: boolean
  stockLocations: { id: string; code: string | null }[]
  vendors: { id: string; display_name: string }[]
}

export function ReturnWorkflowPanel({ authorization, canInspect, canManage, stockLocations, vendors }: Props) {
  const t = useTranslations('returns')
  const tc = useTranslations('common')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [received, setReceived] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.received])))
  const [accepted, setAccepted] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.received])))
  const [disposition, setDisposition] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.disposition ?? ''])))
  const [location, setLocation] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.dispositionLocationId ?? ''])))
  const [vendor, setVendor] = useState<Record<string, string>>({})
  const activeLines = useMemo(() => authorization.lines, [authorization.lines])
  const base = `/api/returns/${authorization.id}`

  async function receive() {
    await execute(() => fulfillmentRequest(`${base}/receive`, { method: 'POST', body: { lines: activeLines.map((line) => ({ lineId: line.lineId, received: received[line.lineId] ?? '0' })) } }, t('workflow.receiveFailed')), {
      fallbackMessage: t('workflow.receiveFailed'),
      successMessage: t('workflow.received'),
      onOk: () => router.refresh(),
    })
  }

  async function inspect() {
    await execute(() => fulfillmentRequest<{ awaitingCreditApproval: boolean }>(`${base}/inspect`, { method: 'POST', body: { lines: activeLines.map((line) => ({
      lineId: line.lineId,
      accepted: accepted[line.lineId] ?? '0',
      disposition: (disposition[line.lineId] || null) as 'restock' | 'scrap' | 'vendor-return' | null,
      dispositionLocationId: location[line.lineId] || null,
      vendorId: vendor[line.lineId] || null,
    })) } }, t('workflow.inspectFailed')), {
      fallbackMessage: t('workflow.inspectFailed'),
      onOk: (result) => {
        toast.success(result.awaitingCreditApproval ? t('workflow.awaitingApproval') : t('workflow.completed'))
        router.refresh()
      },
    })
  }

  async function reject() {
    const reason = await promptDialog({
      title: t('workflow.rejectTitle', { number: authorization.documentNumber }),
      label: t('workflow.reason'),
      placeholder: t('workflow.reasonPlaceholder'),
      confirmLabel: t('workflow.reject'),
    })
    if (!reason) return
    await execute(() => fulfillmentRequest(`${base}/reject`, { method: 'POST', body: { reason } }, t('workflow.rejectFailed')), {
      fallbackMessage: t('workflow.rejectFailed'),
      successMessage: t('workflow.rejected'),
      onOk: () => router.refresh(),
    })
  }

  async function sendEmail(type: 'received' | 'decision') {
    await execute(() => fulfillmentRequest<{ to: string; subject: string }>(`${base}/email`, { method: 'POST', body: { type } }, t('workflow.emailFailed')), {
      fallbackMessage: t('workflow.emailFailed'),
      successMessage: t('workflow.emailSent'),
    })
  }

  if (authorization.stage === 'requested' && canManage) {
    return <section className="mt-6 space-y-4 border-t pt-5" aria-labelledby="rma-workflow-title">
      <h3 id="rma-workflow-title" className="font-semibold">{t('workflow.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('workflow.requested')}</p>
      <div className="space-y-3">{activeLines.map((line) => <div key={line.lineId} className="grid gap-2 sm:grid-cols-[1fr_10rem] sm:items-end">
        <span className="text-sm">{t('workflow.line', { number: line.lineNumber })} · {line.authorized}</span>
        <div><FieldLabel htmlFor={`rma-received-${line.lineId}`}>{t('workflow.receivedQuantity')}</FieldLabel>
          <Input id={`rma-received-${line.lineId}`} type="number" min="0" step="0.00000001" max={line.authorized} value={received[line.lineId] ?? '0'} onChange={(event) => setReceived((current) => ({ ...current, [line.lineId]: event.target.value }))} /></div>
      </div>)}</div>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={receive}>{t('workflow.receive')}</Button><Button variant="ghost" disabled={busy} onClick={reject}>{t('workflow.reject')}</Button><Button variant="outline" disabled={busy} onClick={() => sendEmail('received')}>{t('workflow.emailReceived')}</Button></div>
      {refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.receiveFailed')} /> : null}
    </section>
  }

  if (authorization.stage === 'receiving' && canInspect) {
    return <section className="mt-6 space-y-4 border-t pt-5" aria-labelledby="rma-workflow-title">
      <h3 id="rma-workflow-title" className="font-semibold">{t('workflow.title')}</h3>
      <p className="text-sm text-muted-foreground">{t('workflow.inspection')}</p>
      <div className="space-y-5">{activeLines.map((line) => <div key={line.lineId} className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
        <div className="sm:col-span-2 text-sm">{t('workflow.line', { number: line.lineNumber })} · {t('workflow.receivedSummary', { quantity: line.received, authorized: line.authorized })}</div>
        <div><FieldLabel htmlFor={`rma-accepted-${line.lineId}`}>{t('workflow.acceptedQuantity')}</FieldLabel>
          <Input id={`rma-accepted-${line.lineId}`} type="number" min="0" step="0.00000001" max={line.received} value={accepted[line.lineId] ?? '0'} onChange={(event) => setAccepted((current) => ({ ...current, [line.lineId]: event.target.value }))} /></div>
        <div><FieldLabel htmlFor={`rma-disposition-${line.lineId}`}>{t('workflow.disposition')}</FieldLabel>
          <Select id={`rma-disposition-${line.lineId}`} value={disposition[line.lineId] ?? ''} onChange={(event) => setDisposition((current) => ({ ...current, [line.lineId]: event.target.value }))}>
            <option value="">{tc('labels.select')}</option><option value="restock">{t('workflow.restock')}</option><option value="scrap">{t('workflow.scrap')}</option><option value="vendor-return">{t('workflow.vendorReturn')}</option>
          </Select></div>
        {(disposition[line.lineId] ?? '') !== '' ? <div><FieldLabel htmlFor={`rma-location-${line.lineId}`}>{t('workflow.location')}</FieldLabel>
          <Select id={`rma-location-${line.lineId}`} value={location[line.lineId] ?? ''} onChange={(event) => setLocation((current) => ({ ...current, [line.lineId]: event.target.value }))}>
            <option value="">{tc('labels.select')}</option>{stockLocations.map((option) => <option key={option.id} value={option.id}>{option.code ?? option.id}</option>)}
          </Select></div> : null}
        {disposition[line.lineId] === 'vendor-return' ? <div><FieldLabel htmlFor={`rma-vendor-${line.lineId}`}>{t('workflow.vendor')}</FieldLabel>
          <Select id={`rma-vendor-${line.lineId}`} value={vendor[line.lineId] ?? ''} onChange={(event) => setVendor((current) => ({ ...current, [line.lineId]: event.target.value }))}>
            <option value="">{tc('labels.select')}</option>{vendors.map((option) => <option key={option.id} value={option.id}>{option.display_name}</option>)}
          </Select></div> : null}
      </div>)}</div>
      <Button disabled={busy} onClick={inspect}>{t('workflow.inspect')}</Button><Button variant="outline" disabled={busy || !canManage} onClick={() => sendEmail('received')}>{t('workflow.emailReceived')}</Button>
      {refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.inspectFailed')} /> : null}
    </section>
  }

  if (authorization.stage === 'inspected') return <section className="mt-6 border-t pt-5" aria-live="polite"><h3 className="font-semibold">{t('workflow.title')}</h3><p className="text-sm text-muted-foreground">{t('workflow.awaitingApproval')}</p><Button variant="outline" disabled={busy || !canManage} onClick={() => sendEmail('received')}>{t('workflow.emailReceived')}</Button>{refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.emailFailed')} /> : null}</section>
  if (authorization.stage === 'done' || authorization.stage === 'rejected') return <section className="mt-6 border-t pt-5" aria-live="polite"><h3 className="font-semibold">{t('workflow.title')}</h3><p className="text-sm text-muted-foreground">{authorization.stage === 'done' ? t('workflow.completed') : t('workflow.rejected')}</p><Button variant="outline" disabled={busy || !canManage} onClick={() => sendEmail('decision')}>{t('workflow.emailDecision')}</Button>{refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.emailFailed')} /> : null}</section>
  return null
}
