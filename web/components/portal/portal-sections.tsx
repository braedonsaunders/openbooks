'use client'

import { useState, type FormEvent } from 'react'
import { portalAction, ActionError } from './portal-client'

const inputClass =
  'mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white'
const buttonClass =
  'rounded-xl bg-teal-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50'

export function SubscriptionEditor({
  sessionToken,
  subscriptionId,
  componentKey,
  labels,
}: {
  sessionToken: string
  subscriptionId: string
  componentKey?: string
  labels: { quantity: string; price: string; preview: string; apply: string; increase: string; decrease: string; charge: string; credit: string }
}) {
  const [quantity, setQuantity] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [preview, setPreview] = useState<{ adjustment: string; documentKind: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function runPreview(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await portalAction<{ adjustment: string; documentKind: string | null }>('/api/portal/actions', {
        sessionToken, action: 'previewSubscription', subscriptionId,
        ...(quantity.trim() ? { quantity: quantity.trim() } : {}),
        ...(unitPrice.trim() ? { unitPrice: unitPrice.trim() } : {}),
        ...(componentKey ? { componentKey } : {}),
      })
      setPreview(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  async function apply() {
    setBusy(true)
    setError(null)
    try {
      await portalAction('/api/portal/actions', {
        sessionToken, action: 'changeSubscription', subscriptionId,
        ...(quantity.trim() ? { quantity: quantity.trim() } : {}),
        ...(unitPrice.trim() ? { unitPrice: unitPrice.trim() } : {}),
        ...(componentKey ? { componentKey } : {}),
      })
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <form onSubmit={runPreview} className="mt-2 space-y-3">
      <div className="flex gap-3">
        <label className="flex-1">
          <span className="text-sm text-slate-600 dark:text-slate-300">{labels.quantity}</span>
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" className={inputClass} />
        </label>
        <label className="flex-1">
          <span className="text-sm text-slate-600 dark:text-slate-300">{labels.price}</span>
          <input value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} inputMode="decimal" className={inputClass} />
        </label>
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={buttonClass}>{labels.preview}</button>
        {preview ? (
          <button type="button" onClick={apply} disabled={busy} className={buttonClass}>{labels.apply}</button>
        ) : null}
      </div>
      {preview ? (
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {Number(preview.adjustment) >= 0 ? labels.charge : labels.credit}: {preview.adjustment}
        </p>
      ) : null}
      <ActionError message={error} />
    </form>
  )
}

export function CancelFlow({
  sessionToken,
  subscriptionId,
  offers,
  labels,
}: {
  sessionToken: string
  subscriptionId: string
  offers: Array<{ id: string; kind: string; label: string; note?: string }>
  labels: { reason: string; reasonPlaceholder: string; cancel: string; takeOffer: string }
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function act(payload: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      await portalAction('/api/portal/actions', { sessionToken, subscriptionId, ...payload })
      window.location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 space-y-3">
      {offers.map((offer) => (
        <div key={offer.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
          <div>
            <p className="text-sm font-medium text-slate-900 dark:text-white">{offer.label}</p>
            {offer.note ? <p className="text-xs text-slate-500 dark:text-slate-400">{offer.note}</p> : null}
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => act({ action: 'acceptSaveOffer', offerId: offer.id })}
            className={buttonClass}
          >
            {labels.takeOffer}
          </button>
        </div>
      ))}
      <label className="block">
        <span className="text-sm text-slate-600 dark:text-slate-300">{labels.reason}</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={labels.reasonPlaceholder}
          className={inputClass}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => act({ action: 'cancelSubscription', reason })}
        className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-800 disabled:opacity-50"
      >
        {labels.cancel}
      </button>
      <ActionError message={error} />
    </div>
  )
}

export function ReturnRequestForm({
  sessionToken,
  sourceDocumentId,
  sources,
  reasons,
  resolutions,
  labels,
}: {
  sessionToken: string
  sourceDocumentId: string
  sources: Array<{ movementId: string; movedAt: string; remaining: string; lotCode: string | null; serialCode: string | null }>
  reasons: Array<{ value: string; label: string }>
  resolutions: Array<{ value: string; label: string }>
  labels: { quantity: string; reason: string; resolution: string; submit: string; submitted: string; available: string }
}) {
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [reasonCode, setReasonCode] = useState(reasons[0]?.value ?? '')
  const [resolution, setResolution] = useState(resolutions[0]?.value ?? 'refund')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const lines = Object.entries(quantities)
        .filter(([, quantity]) => quantity.trim() && quantity.trim() !== '0')
        .map(([movementId, quantity]) => ({ sourceIssueMovementId: movementId, quantity: quantity.trim() }))
      const result = await portalAction<{ documentNumber: string }>('/api/portal/returns', {
        sessionToken, sourceDocumentId, reasonCode, resolution, lines,
      })
      setDone(`${labels.submitted}: ${result.documentNumber}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  if (done) return <p className="text-sm font-medium text-slate-900 dark:text-white">{done}</p>
  return (
    <form onSubmit={submit} className="space-y-3">
      {sources.map((source) => (
        <div key={source.movementId} className="flex items-center justify-between gap-3">
          <p className="text-sm text-slate-700 dark:text-slate-200">
            {labels.available.replace('{quantity}', source.remaining)}{' · '}{source.movedAt.slice(0, 10)}{source.lotCode ? ` · ${source.lotCode}` : source.serialCode ? ` · ${source.serialCode}` : ''}
          </p>
          <input
            value={quantities[source.movementId] ?? ''}
            onChange={(e) => setQuantities({ ...quantities, [source.movementId]: e.target.value })}
            inputMode="decimal"
            placeholder={labels.quantity}
            className="w-24 rounded-xl border border-slate-300 px-3 py-1.5 text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
          />
        </div>
      ))}
      <div className="flex gap-3">
        <label className="flex-1">
          <span className="text-sm text-slate-600 dark:text-slate-300">{labels.reason}</span>
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className={inputClass}>
            {reasons.map((reason) => (
              <option key={reason.value} value={reason.value}>{reason.label}</option>
            ))}
          </select>
        </label>
        <label className="flex-1">
          <span className="text-sm text-slate-600 dark:text-slate-300">{labels.resolution}</span>
          <select value={resolution} onChange={(e) => setResolution(e.target.value)} className={inputClass}>
            {resolutions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" disabled={busy} className={buttonClass}>{labels.submit}</button>
      <ActionError message={error} />
    </form>
  )
}

export function GiftCardForm({
  sessionToken,
  labels,
}: {
  sessionToken: string
  labels: { code: string; check: string }
}) {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<{ kind: string; balanceMinor: string; currency: string; status: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function check(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const balance = await portalAction<{ kind: string; balanceMinor: string; currency: string; status: string }>(
        '/api/portal/actions',
        { sessionToken, action: 'lookupGiftCard', code: code.trim() },
      )
      setResult(balance)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={check} className="space-y-3">
      <label className="block">
        <span className="text-sm text-slate-600 dark:text-slate-300">{labels.code}</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} className={inputClass} autoComplete="off" />
      </label>
      <button type="submit" disabled={busy} className={buttonClass}>{labels.check}</button>
      {result ? (
        <p className="text-sm text-slate-700 dark:text-slate-200">
          {result.kind} · {result.balanceMinor} {result.currency} · {result.status}
        </p>
      ) : null}
      <ActionError message={error} />
    </form>
  )
}
