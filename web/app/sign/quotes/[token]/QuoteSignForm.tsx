'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The customer's side of quote-to-cash: review the quoted subscription,
 * consent, and sign (or decline). Every state re-validates the link
 * server-side — an expired, voided, or consumed link explains itself by
 * name instead of rendering a dead form. Styled on the hosted payment
 * page: one narrow card, plain language, no account needed.
 */

interface QuoteLine {
  quoteNumber: string
  status: string
  currency: string
  total: string
  documentDate: string
  terms: Array<{
    planName: string
    termMonths: number
    startRule: string
    billingTiming: string
    periods: Array<{ unitPrice: string; quantity: string; periodAmount: string }>
    tcv: string
  }>
  tcv: string
  signature: {
    signerName: string
    signerEmail: string
    expiresAt: string
    consentText: string
  }
}

function money(amount: string, currency: string): string {
  const units = Number(amount)
  if (!Number.isFinite(units)) return `${amount} ${currency}`
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(units)
}

export function QuoteSignForm({ token }: { token: string }) {
  const [quote, setQuote] = useState<QuoteLine | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [consented, setConsented] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`/api/sign/quotes/${encodeURIComponent(token)}`)
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setRefusal(typeof body?.error === 'string' && body.error ? body.error : 'This signing link is not available.')
      return
    }
    const body = (await res.json()) as QuoteLine
    setQuote(body)
    setName((current) => current || body.signature.signerName)
  }, [token])

  useEffect(() => {
    queueMicrotask(() => { void load() })
  }, [load])

  async function submit(action: 'sign' | 'decline') {
    if (action === 'sign' && (!name.trim() || !consented)) return
    if (action === 'decline' && !name.trim()) return
    setBusy(true)
    try {
      const res = await fetch(`/api/sign/quotes/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name: name.trim() }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        setRefusal(typeof body?.error === 'string' && body.error ? body.error : 'This signing link is not available.')
        return
      }
      if (action === 'decline') {
        setRefusal('You declined this quote. The sender has been notified and can re-issue it.')
        return
      }
      setDone(true)
    } finally {
      setBusy(false)
    }
  }

  if (refusal) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="font-medium text-slate-900 dark:text-slate-100">This link cannot be used</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{refusal}</p>
      </div>
    )
  }

  if (done) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">Signed — thank you</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Your signature is recorded. The sender will activate your subscription and confirm the start date.
        </p>
      </div>
    )
  }

  if (!quote) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-sm text-slate-500">Loading your quote…</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">Quote {quote.quoteNumber}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{money(quote.tcv, quote.currency)}</p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {quote.terms.length} subscription{quote.terms.length === 1 ? '' : 's'} · quoted {quote.documentDate}
        </p>
      </div>
      <ul className="divide-y rounded-lg border">
        {quote.terms.map((term, i) => (
          <li key={i} className="p-3 text-sm">
            <p className="font-medium">
              {term.planName} · {term.termMonths} months
            </p>
            <p className="mt-1 text-xs tabular-nums text-slate-500">
              {term.periods.map((p, j) => (
                <span key={j} className="mr-3">
                  {money(p.unitPrice, quote.currency)} × {p.quantity} = {money(p.periodAmount, quote.currency)}
                </span>
              ))}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Starts {term.startRule.replaceAll('_', ' ')} · billed {term.billingTiming}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-600 dark:text-slate-400">{quote.signature.consentText}</p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Your full name (as signature)</span>
        <input
          className="w-full rounded-md border px-2 py-1.5"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
        />
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
        />
        <span>I accept this quote and the subscription it describes, starting on the stated date.</span>
      </label>
      <p className="text-xs text-slate-500">The link expires {quote.signature.expiresAt.slice(0, 10)} and works once.</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !name.trim() || !consented}
          onClick={() => void submit('sign')}
          className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Signing…' : 'Sign this quote'}
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void submit('decline')}
          className="rounded-md border px-4 py-2 text-sm"
        >
          Decline
        </button>
      </div>
    </div>
  )
}
