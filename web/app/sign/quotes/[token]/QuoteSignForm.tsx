'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { createMoneyFormatter } from '@/lib/money-format'

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
  /** Always present on a resolved view: invalid, expired, and consentless
   *  links refuse before resolving, so null only guards a malformed payload
   *  reaching the client. Open (sent, viewed) requests render the form;
   *  signed, declined, voided and consumed requests resolve their status
   *  and refuse with a named remedy instead. */
  signature: {
    status: string
    signerName: string
    signerEmail: string
    expiresAt: string
    consentText: string
  } | null
}

/**
 * House money formatting on the exact decimal strings: the formatter keeps
 * numeric strings out of binary floats, so a quoted total renders exactly
 * what the engine priced, in the viewer's locale.
 */
function money(amount: string, currency: string, locale: string): string {
  return createMoneyFormatter(locale, currency).money(amount, { currency })
}

const START_RULE_KEYS = {
  quote_date: 'quoteCash.startQuoteDate',
  next_month: 'quoteCash.startNextMonth',
  custom: 'quoteCash.startCustom',
} as const

const BILLING_TIMING_KEYS = {
  advance: 'quoteCash.timingAdvance',
  arrears: 'quoteCash.timingArrears',
} as const

export function QuoteSignForm({ token }: { token: string }) {
  const t = useTranslations('estimates')
  const locale = useLocale()
  const [quote, setQuote] = useState<QuoteLine | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [consented, setConsented] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [activatedCount, setActivatedCount] = useState(0)

  const load = useCallback(async () => {
    const res = await fetch(`/api/sign/quotes/${encodeURIComponent(token)}`)
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setRefusal(typeof body?.error === 'string' && body.error ? body.error : t('quoteSign.unavailable'))
      return
    }
    const body = (await res.json()) as QuoteLine
    setQuote(body)
    setName((current) => current || body.signature?.signerName || '')
  }, [token, t])

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
        setRefusal(typeof body?.error === 'string' && body.error ? body.error : t('quoteSign.unavailable'))
        return
      }
      if (action === 'decline') {
        setRefusal(t('quoteSign.declinedConfirm'))
        return
      }
      // The confirmation renders what the POST actually did: a synchronously
      // activated subscription reads as active, otherwise the signature alone
      // stands — never a promised future sender action without its mechanism.
      const signed = (await res.json().catch(() => null)) as { subscriptionIds?: unknown } | null
      setActivatedCount(Array.isArray(signed?.subscriptionIds) ? signed.subscriptionIds.length : 0)
      setDone(true)
    } finally {
      setBusy(false)
    }
  }

  if (refusal) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="font-medium text-slate-900 dark:text-slate-100">{t('quoteSign.unavailableTitle')}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{refusal}</p>
      </div>
    )
  }

  if (done) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('quoteSign.signedTitle')}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {activatedCount > 0 ? t('quoteSign.signedActiveBody') : t('quoteSign.signedBody')}
        </p>
      </div>
    )
  }

  if (!quote) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-sm text-slate-500">{t('quoteSign.loading')}</p>
      </div>
    )
  }

  if (!quote.signature) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="font-medium text-slate-900 dark:text-slate-100">{t('quoteSign.missingTitle')}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{t('quoteSign.resendBody')}</p>
      </div>
    )
  }

  if (quote.signature.status === 'signed') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">{t('quoteSign.signedTitle')}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {t('quoteSign.signedAgainBody')}
        </p>
      </div>
    )
  }

  if (quote.signature.status === 'declined') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="font-medium text-slate-900 dark:text-slate-100">{t('quoteSign.declinedTitle')}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {t('quoteSign.declinedBody')}
        </p>
      </div>
    )
  }

  if (quote.signature.status !== 'sent' && quote.signature.status !== 'viewed') {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="font-medium text-slate-900 dark:text-slate-100">{t('quoteSign.closedTitle')}</p>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{t('quoteSign.resendBody')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-500">{t('quoteSign.quoteEyebrow', { number: quote.quoteNumber })}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{money(quote.tcv, quote.currency, locale)}</p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {t('quoteSign.quotedLine', { count: quote.terms.length, date: quote.documentDate })}
        </p>
      </div>
      <ul className="divide-y rounded-lg border">
        {quote.terms.map((term, i) => (
          <li key={i} className="p-3 text-sm">
            <p className="font-medium">
              {term.planName} · {t('quoteCash.termMonths', { count: term.termMonths })}
            </p>
            <p className="mt-1 text-xs tabular-nums text-slate-500">
              {term.periods.map((p, j) => (
                <span key={j} className="mr-3">
                  {t('quoteCash.periodLine', {
                    price: money(p.unitPrice, quote.currency, locale),
                    qty: p.quantity,
                    amount: money(p.periodAmount, quote.currency, locale),
                  })}
                </span>
              ))}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {t('quoteSign.startsBilled', {
                start: t(
                  (START_RULE_KEYS as Record<string, string>)[term.startRule] ?? 'quoteCash.startRule',
                ),
                timing: t(
                  (BILLING_TIMING_KEYS as Record<string, string>)[term.billingTiming] ??
                    'quoteCash.billingTiming',
                ),
              })}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-600 dark:text-slate-400">{quote.signature.consentText}</p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">{t('quoteSign.nameLabel')}</span>
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
        <span>{t('quoteSign.acceptLabel')}</span>
      </label>
      <p className="text-xs text-slate-500">{t('quoteSign.expiryNote', { date: quote.signature.expiresAt.slice(0, 10) })}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !name.trim() || !consented}
          onClick={() => void submit('sign')}
          className="rounded-md bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? t('quoteSign.signing') : t('quoteSign.sign')}
        </button>
        <button
          type="button"
          disabled={busy || !name.trim()}
          onClick={() => void submit('decline')}
          className="rounded-md border px-4 py-2 text-sm"
        >
          {t('quoteSign.decline')}
        </button>
      </div>
    </div>
  )
}
