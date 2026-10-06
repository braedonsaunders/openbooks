'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Button, DisclosureSection, FieldLabel, Input, Select } from '@openbooks/ui'
import { Switch } from '@/components/switch'
import { promptDialog } from '../../../lib/prompt'
import { useAppAction } from '../../../lib/use-app-action'
import { useMoney } from '@/components/money-provider'
import { readApiErrorMessage } from '@/lib/api-error'
import { minorToMajorText } from '@/lib/money-format'
import { fulfillmentRequest } from '../_fulfillment/fulfillment-client'
import type { ReturnAuthorization } from '@openbooks/engine/src/sales/returns.ts'

type Props = {
  authorization: ReturnAuthorization
  canInspect: boolean
  canManage: boolean
  canWaiveFee?: boolean
  currency?: string
  stockLocations: { id: string; code: string | null }[]
  vendors: { id: string; display_name: string }[]
}

type FeePreviewLine = {
  key: string
  policyId: string | null
  policyName: string | null
  scope: string
  feeMinor: string
  capped: boolean
  incomeAccountId: string | null
}

type FeePreview = {
  lines: FeePreviewLine[]
  totalMinor: string
  currency: string
}

export function ReturnWorkflowPanel({ authorization, canInspect, canManage, canWaiveFee, currency, stockLocations, vendors }: Props) {
  const t = useTranslations('returns')
  const tc = useTranslations('common')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [received, setReceived] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.received])))
  const [accepted, setAccepted] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.received])))
  const [disposition, setDisposition] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.disposition ?? ''])))
  const [location, setLocation] = useState<Record<string, string>>(() => Object.fromEntries(authorization.lines.map((line) => [line.lineId, line.dispositionLocationId ?? ''])))
  const [vendor, setVendor] = useState<Record<string, string>>({})
  const [feePreview, setFeePreview] = useState<FeePreview | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [waiveFee, setWaiveFee] = useState(false)
  const [waiveReason, setWaiveReason] = useState('')
  const activeLines = useMemo(() => authorization.lines, [authorization.lines])
  const base = `/api/returns/${authorization.id}`
  const { money } = useMoney(currency)
  const feeTotal = feePreview ? money(minorToMajorText(feePreview.totalMinor), { currency: feePreview.currency }) : ''

  async function receive() {
    await execute(() => fulfillmentRequest(`${base}/receive`, { method: 'POST', body: { lines: activeLines.map((line) => ({ lineId: line.lineId, received: received[line.lineId] ?? '0' })) } }, t('workflow.receiveFailed')), {
      fallbackMessage: t('workflow.receiveFailed'),
      successMessage: t('workflow.received'),
      onOk: () => router.refresh(),
    })
  }

  async function previewFee() {
    const lines = activeLines
      .map((line) => ({ lineId: line.lineId, accepted: accepted[line.lineId] ?? '0' }))
      .filter((line) => line.accepted !== '' && line.accepted !== '0')
    if (lines.length === 0) {
      setFeePreview({ lines: [], totalMinor: '0', currency: currency ?? '' })
      return
    }
    setPreviewBusy(true)
    try {
      const res = await fetch(`${base}/restocking-fee`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      })
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t('workflow.fee.previewFailed')))
        return
      }
      setFeePreview((await res.json()) as FeePreview)
    } finally {
      setPreviewBusy(false)
    }
  }

  async function inspect() {
    await execute(() => fulfillmentRequest<{ awaitingCreditApproval: boolean }>(`${base}/inspect`, { method: 'POST', body: {
      lines: activeLines.map((line) => ({
        lineId: line.lineId,
        accepted: accepted[line.lineId] ?? '0',
        disposition: (disposition[line.lineId] || null) as 'restock' | 'scrap' | 'vendor-return' | null,
        dispositionLocationId: location[line.lineId] || null,
        vendorId: vendor[line.lineId] || null,
      })),
      ...(waiveFee && canWaiveFee ? { waiveFee: true, waiveReason } : {}),
    } }, t('workflow.inspectFailed')), {
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
            <option value="">{tc('actions.select')}</option><option value="restock">{t('workflow.restock')}</option><option value="scrap">{t('workflow.scrap')}</option><option value="vendor-return">{t('workflow.vendorReturn')}</option>
          </Select></div>
        {(disposition[line.lineId] ?? '') !== '' ? <div><FieldLabel htmlFor={`rma-location-${line.lineId}`}>{t('workflow.location')}</FieldLabel>
          <Select id={`rma-location-${line.lineId}`} value={location[line.lineId] ?? ''} onChange={(event) => setLocation((current) => ({ ...current, [line.lineId]: event.target.value }))}>
            <option value="">{tc('actions.select')}</option>{stockLocations.map((option) => <option key={option.id} value={option.id}>{option.code ?? option.id}</option>)}
          </Select></div> : null}
        {disposition[line.lineId] === 'vendor-return' ? <div><FieldLabel htmlFor={`rma-vendor-${line.lineId}`}>{t('workflow.vendor')}</FieldLabel>
          <Select id={`rma-vendor-${line.lineId}`} value={vendor[line.lineId] ?? ''} onChange={(event) => setVendor((current) => ({ ...current, [line.lineId]: event.target.value }))}>
            <option value="">{tc('actions.select')}</option>{vendors.map((option) => <option key={option.id} value={option.id}>{option.display_name}</option>)}
          </Select></div> : null}
      </div>)}</div>
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{t('workflow.fee.title')}</span>
          <Button variant="outline" size="sm" disabled={busy || previewBusy} onClick={previewFee}>{t('workflow.fee.preview')}</Button>
        </div>
        {feePreview && feePreview.lines.length > 0 ? (
          <DisclosureSection
            title={t('workflow.fee.detail', { count: feePreview.lines.length })}
            summary={t('workflow.fee.total', { amount: feeTotal })}
            defaultOpen={false}
          >
            <ul className="space-y-1 text-sm">
              {feePreview.lines.map((line) => (
                <li key={line.key} className="flex items-center justify-between gap-2">
                  <span>{line.policyName ?? t('workflow.fee.noPolicy')}{line.capped ? ` · ${t('workflow.fee.capped')}` : ''}</span>
                  <span>{money(minorToMajorText(line.feeMinor), { currency: feePreview.currency })}</span>
                </li>
              ))}
            </ul>
          </DisclosureSection>
        ) : null}
        {feePreview && BigInt(feePreview.totalMinor) > 0n && canWaiveFee ? (
          <div className="flex flex-wrap items-center gap-2">
            <Switch on={waiveFee} disabled={busy} label={t('workflow.fee.waive')} onToggle={() => setWaiveFee((current) => !current)} />
            {waiveFee ? (
              <Input
                value={waiveReason}
                onChange={(event) => setWaiveReason(event.target.value)}
                placeholder={t('workflow.fee.reasonPlaceholder')}
                className="min-w-52 flex-1"
                aria-label={t('workflow.fee.reason')}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <Button disabled={busy} onClick={inspect}>{t('workflow.inspect')}</Button><Button variant="outline" disabled={busy || !canManage} onClick={() => sendEmail('received')}>{t('workflow.emailReceived')}</Button>
      {refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.inspectFailed')} /> : null}
    </section>
  }

  if (authorization.stage === 'inspected') return <section className="mt-6 border-t pt-5" aria-live="polite"><h3 className="font-semibold">{t('workflow.title')}</h3><p className="text-sm text-muted-foreground">{t('workflow.awaitingApproval')}</p><Button variant="outline" disabled={busy || !canManage} onClick={() => sendEmail('received')}>{t('workflow.emailReceived')}</Button>{refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.emailFailed')} /> : null}</section>
  if (authorization.stage === 'done' || authorization.stage === 'rejected') return <section className="mt-6 border-t pt-5" aria-live="polite"><h3 className="font-semibold">{t('workflow.title')}</h3><p className="text-sm text-muted-foreground">{authorization.stage === 'done' ? t('workflow.completed') : t('workflow.rejected')}</p><Button variant="outline" disabled={busy || !canManage} onClick={() => sendEmail('decision')}>{t('workflow.emailDecision')}</Button>{refusal ? <ActionAlert error={refusal} fallbackMessage={t('workflow.emailFailed')} /> : null}</section>
  return null
}
