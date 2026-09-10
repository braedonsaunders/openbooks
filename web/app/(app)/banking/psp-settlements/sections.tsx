'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button, Card, Input, Label, Select } from '@openbooks/ui'
import { useMoney } from '../../../../components/money-provider'
import { useBusinessToday } from '../../../../components/business-date-provider'

const SETTLEMENT_PROVIDERS = ['stripe', 'adyen', 'gocardless', 'recurly', 'chargebee'] as const
const SETTLEMENT_STATUSES = ['draft', 'posted', 'void'] as const

type SettlementProvider = (typeof SETTLEMENT_PROVIDERS)[number]
type ImportProvider = Extract<SettlementProvider, 'stripe' | 'recurly' | 'chargebee'>
type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number]

export interface PspSettlementRow {
  id: string
  providerLabel: string
  externalRef: string
  settlementDate: string
  netAmount: string
  statusLabel: string
  status: 'draft' | 'posted' | 'void'
}

const STATUS_MESSAGE: Record<SettlementStatus, 'draft' | 'posted' | 'voided'> = {
  draft: 'draft',
  posted: 'posted',
  void: 'voided',
}

interface SettlementBatch {
  id: string
  provider: SettlementProvider
  externalRef: string
  settlementDate: string
  currency: string
  netAmount: string
  status: SettlementStatus
}

function isSettlementBatch(value: unknown): value is SettlementBatch {
  if (!value || typeof value !== 'object') return false
  const batch = value as Record<string, unknown>
  return (
    typeof batch.id === 'string' &&
    SETTLEMENT_PROVIDERS.includes(batch.provider as SettlementProvider) &&
    typeof batch.externalRef === 'string' &&
    typeof batch.settlementDate === 'string' &&
    typeof batch.currency === 'string' &&
    typeof batch.netAmount === 'string' &&
    SETTLEMENT_STATUSES.includes(batch.status as SettlementStatus)
  )
}

async function fetchSettlements(signal?: AbortSignal): Promise<SettlementBatch[] | null> {
  try {
    const response = await fetch('/api/psp/settlements', { signal })
    if (!response.ok) return null
    const data = (await response.json()) as { batches?: unknown }
    if (!Array.isArray(data.batches) || !data.batches.every(isSettlementBatch)) return null
    return data.batches
  } catch {
    return null
  }
}

async function requestSettlement<T>(body: Record<string, unknown>): Promise<T | null> {
  try {
    const response = await fetch('/api/psp/settlements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * The PSP settlements workspace, moved verbatim from page.tsx so both render
 * paths share one implementation.
 *
 * One component, not three widgets, and the reason is the lesson from the
 * last round: the import form, the reversal form, and the batch table are
 * one state graph, not three. The reversal reason lives in the batches card
 * but disables every posted row's Reverse button; import/post/reverse all
 * reload the same list; the error/message banners belong to all three
 * mutations. Splitting that graph across widget boundaries would strand
 * state from the controls that read it. The spec therefore places this
 * workspace whole (`psp-settlements`), with the loader resolving only the
 * static shell strings (titles, labels, placeholders) plus the initial rows.
 *
 * `initialRows` is the loader's read of the same GET contract the component
 * fetches itself: when rows are provided the list renders on first paint
 * with no loading flash; the component still reloads after every mutation,
 * exactly as it does natively.
 */
export function PspSettlementsWorkspace({
  strings,
  initialRows,
}: {
  strings: {
    acceptanceNote: string
    acceptanceLink: string
    importTitle: string
    providerLabel: string
    externalRef: string
    settlementDate: string
    bankAccountId: string
    feeAccountId: string
    clearingAccountId: string
    uuidPlaceholder: string
    importDraft: string
    recentBatches: string
    reversalDate: string
    reversalReason: string
    reversalPlaceholder: string
    colProvider: string
    colNet: string
    reverse: string
    empty: string
    referenceLabel: string
    dateLabel: string
    statusLabel: string
    postLabel: string
    loadingLabel: string
    loadFailedLabel: string
    retryLabel: string
  }
  initialRows: PspSettlementRow[] | null
}) {
  const t = useTranslations('banking.pspSettlements')
  // Client-fetched rows (native path, and spec-path reloads after a mutation)
  // format through the same hooks the native page has always used.
  const common = useTranslations('common')
  const { money } = useMoney()
  const today = useBusinessToday()
  const [batches, setBatches] = useState<SettlementBatch[]>([])
  const [provider, setProvider] = useState<ImportProvider>('stripe')
  const [externalRef, setExternalRef] = useState('')
  const [settlementDate, setSettlementDate] = useState(today)
  const [payload, setPayload] = useState('[]')
  const [bankAccountId, setBankAccountId] = useState('')
  const [feeAccountId, setFeeAccountId] = useState('')
  const [clearingAccountId, setClearingAccountId] = useState('')
  const [reversalDate, setReversalDate] = useState(today)
  const [reversalReason, setReversalReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(initialRows === null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (initialRows !== null) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    void fetchSettlements(controller.signal).then((loadedBatches) => {
      if (controller.signal.aborted) return
      if (loadedBatches === null) {
        setLoadFailed(true)
      } else {
        setBatches(loadedBatches)
      }
      setLoading(false)
    })
    return () => controller.abort()
  }, [initialRows])

  const load = async () => {
    setLoading(true)
    setLoadFailed(false)
    const loadedBatches = await fetchSettlements()
    if (loadedBatches === null) {
      setLoadFailed(true)
    } else {
      setBatches(loadedBatches)
    }
    setLoading(false)
  }

  const importBatch = async () => {
    setErr(null)
    setMsg(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      setErr(t('invalidJson'))
      return
    }
    const body: Record<string, unknown> = {
      action: 'import',
      provider,
      externalRef,
      settlementDate,
      bankAccountId: bankAccountId || undefined,
      feeAccountId: feeAccountId || undefined,
      clearingAccountId: clearingAccountId || undefined,
    }
    if (provider === 'stripe') {
      body.transactions = parsed
      body.payoutId = externalRef
    } else {
      body.payload = parsed
    }
    const d = await requestSettlement<{ batchId?: string }>(body)
    if (!d || typeof d.batchId !== 'string') {
      setErr(t('importFailed'))
      return
    }
    setMsg(t('importedToast', { id: d.batchId }))
    void load()
  }

  const post = async (batchId: string) => {
    setErr(null)
    const d = await requestSettlement<{ entryId?: string }>({ action: 'post', batchId })
    if (!d || typeof d.entryId !== 'string') {
      setErr(t('postFailed'))
      return
    }
    setMsg(t('postedToast', { id: d.entryId }))
    void load()
  }

  const reverse = async (batchId: string) => {
    setErr(null)
    if (reversalReason.trim().length < 5) {
      setErr(t('reasonTooShort'))
      return
    }
    const d = await requestSettlement<{ entryId?: string }>({
      action: 'reverse',
      batchId,
      reversalDate,
      reason: reversalReason,
    })
    if (!d || typeof d.entryId !== 'string') {
      setErr(t('reversalFailed'))
      return
    }
    setMsg(t('reversedToast', { id: d.entryId }))
    setReversalReason('')
    void load()
  }

  const settlementDateLabel = (value: string) =>
    new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    })
  const providerLabel = (value: SettlementProvider) => t(`providers.${value}`)
  const statusLabel = (value: SettlementStatus) => common(`status.${STATUS_MESSAGE[value]}`)

  const listed: { id: string; provider: string; externalRef: string; date: string; net: string; status: string; rawStatus: SettlementStatus }[] =
    loading || loadFailed
      ? []
      : initialRows !== null && batches.length === 0
        ? initialRows.map((b) => ({
            id: b.id,
            provider: b.providerLabel,
            externalRef: b.externalRef,
            date: b.settlementDate,
            net: b.netAmount,
            status: b.statusLabel,
            rawStatus: b.status,
          }))
        : batches.map((b) => ({
            id: b.id,
            provider: providerLabel(b.provider),
            externalRef: b.externalRef,
            date: settlementDateLabel(b.settlementDate),
            net: money(b.netAmount, { currency: b.currency }),
            status: statusLabel(b.status),
            rawStatus: b.status,
          }))

  return (
    <>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {strings.acceptanceNote}{' '}
        <Link href="/admin/setup/payment-providers" className="text-teal-700 hover:underline dark:text-teal-300">
          {strings.acceptanceLink}
        </Link>
      </p>
      {err && (
        <p role="alert" className="text-sm text-red-600">
          {err}
        </p>
      )}
      {msg && (
        <p aria-live="polite" className="text-sm text-teal-700 dark:text-teal-300">
          {msg}
        </p>
      )}

      <Card className="space-y-3 p-4">
        <h3 className="text-sm font-semibold">{strings.importTitle}</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label>{strings.providerLabel}</Label>
            <Select value={provider} onChange={(e) => setProvider(e.target.value as ImportProvider)}>
              <option value="stripe">{t('providers.stripe')}</option>
              <option value="recurly">{t('providers.recurly')}</option>
              <option value="chargebee">{t('providers.chargebee')}</option>
            </Select>
          </div>
          <div>
            <Label>{strings.externalRef}</Label>
            <Input value={externalRef} onChange={(e) => setExternalRef(e.target.value)} />
          </div>
          <div>
            <Label>{strings.settlementDate}</Label>
            <Input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} />
          </div>
          <div>
            <Label>{strings.bankAccountId}</Label>
            <Input
              value={bankAccountId}
              onChange={(e) => setBankAccountId(e.target.value)}
              placeholder={strings.uuidPlaceholder}
            />
          </div>
          <div>
            <Label>{strings.feeAccountId}</Label>
            <Input
              value={feeAccountId}
              onChange={(e) => setFeeAccountId(e.target.value)}
              placeholder={strings.uuidPlaceholder}
            />
          </div>
          <div>
            <Label>{strings.clearingAccountId}</Label>
            <Input
              value={clearingAccountId}
              onChange={(e) => setClearingAccountId(e.target.value)}
              placeholder={strings.uuidPlaceholder}
            />
          </div>
        </div>
        <div>
          <Label>{provider === 'stripe' ? t('stripePayloadLabel') : t('genericPayloadLabel')}</Label>
          <textarea
            className="mt-1 min-h-32 w-full rounded border p-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
        </div>
        <Button size="sm" disabled={!externalRef} onClick={() => void importBatch()}>
          {strings.importDraft}
        </Button>
      </Card>

      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">{strings.recentBatches}</h3>
        <div className="mb-4 grid gap-3 sm:grid-cols-[12rem_1fr]">
          <div>
            <Label>{strings.reversalDate}</Label>
            <Input type="date" value={reversalDate} onChange={(e) => setReversalDate(e.target.value)} />
          </div>
          <div>
            <Label>{strings.reversalReason}</Label>
            <Input
              value={reversalReason}
              onChange={(e) => setReversalReason(e.target.value)}
              placeholder={strings.reversalPlaceholder}
              maxLength={500}
            />
          </div>
        </div>
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1">{strings.colProvider}</th>
              <th>{strings.referenceLabel}</th>
              <th>{strings.dateLabel}</th>
              <th className="text-right">{strings.colNet}</th>
              <th>{strings.statusLabel}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {listed.map((b) => (
              <tr key={b.id} className="border-t">
                <td className="py-1">{b.provider}</td>
                <td className="font-mono text-xs">{b.externalRef}</td>
                <td>{b.date}</td>
                <td className="text-right tabular-nums">{b.net}</td>
                <td>{b.status}</td>
                <td className="text-right">
                  {b.rawStatus === 'draft' && (
                    <Button size="sm" variant="ghost" onClick={() => void post(b.id)}>
                      {strings.postLabel}
                    </Button>
                  )}
                  {b.rawStatus === 'posted' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={reversalReason.trim().length < 5}
                      onClick={() => void reverse(b.id)}
                    >
                      {strings.reverse}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
            {loading && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-muted-foreground">
                  {strings.loadingLabel}
                </td>
              </tr>
            )}
            {!loading && loadFailed && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-muted-foreground">
                  <p>{strings.loadFailedLabel}</p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => void load()}>
                    {strings.retryLabel}
                  </Button>
                </td>
              </tr>
            )}
            {!loading && !loadFailed && listed.length === 0 && (
              <tr>
                <td colSpan={6} className="py-4 text-center text-muted-foreground">
                  {strings.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  )
}
