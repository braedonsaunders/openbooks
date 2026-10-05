'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, DisclosureSection, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { createMoneyFormatter } from '@/lib/money-format'

export interface AttemptPayload {
  id: string
  invoiceId: string
  invoiceNumber: string
  customerName: string
  amount: string
  currency: string
  provider: string
  providerRef: string | null
  methodLabel: string | null
  status: string
  declineCode: string | null
  declineKind: string | null
  retryPosition: number
  nextRetryOn: string | null
  receiptId: string | null
  attemptedAt: string
}

/**
 * One collection attempt: its plain-words state and next action up front,
 * retry configuration in the middle, provider detail collapsed at the
 * bottom. The shell stays mounted through retry and its refusal.
 */
export function AttemptDrawer({
  drawer,
}: {
  drawer: { attempt: AttemptPayload; canRetry: boolean; closeHref: string }
}) {
  const t = useTranslations('ar.collections.attempts')
  const tc = useTranslations('common')
  const router = useRouter()
  const { attempt, canRetry, closeHref } = drawer
  const { money } = createMoneyFormatter(useLocale(), attempt.currency)
  const formattedAmount = money(attempt.amount, { currency: attempt.currency })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retryable = canRetry && attempt.status === 'failed' && attempt.declineKind === 'soft'
  const statusLabel =
    attempt.status === 'succeeded' ? t('statusSucceeded')
    : attempt.status === 'failed' ? t('statusFailed')
    : attempt.status === 'processing' ? t('statusProcessing')
    : attempt.status === 'canceled' ? t('statusCanceled')
    : t('statusInitiated')
  const summary =
    attempt.status === 'succeeded' ? t('summarySucceeded', { amount: formattedAmount, invoice: attempt.invoiceNumber })
    : attempt.status === 'failed' ? t('summaryFailed', { amount: formattedAmount, invoice: attempt.invoiceNumber })
    : attempt.status === 'processing' ? t('summaryProcessing', { amount: formattedAmount, invoice: attempt.invoiceNumber })
    : attempt.status === 'canceled' ? t('summaryCanceled', { amount: formattedAmount, invoice: attempt.invoiceNumber })
    : t('summaryInitiated', { amount: formattedAmount, invoice: attempt.invoiceNumber })

  const retryNow = async () => {
    const confirmed = await confirmDialog({
      title: t('retryConfirmTitle'),
      message: t('retryConfirmDescription', { amount: formattedAmount, invoice: attempt.invoiceNumber }),
      confirmLabel: t('retryNow'),
      cancelLabel: tc('actions.cancel'),
    })
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/autopay/attempts/${attempt.id}/retry`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError((body?.error as string | undefined) ?? t('retryFailed'))
        return
      }
      toast.success(t('retryStarted'))
      router.refresh()
    } catch {
      setError(t('retryFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      syncUrlOnClose
      title={
        <span className="flex items-center gap-2.5">
          <span>{t('title', { invoice: attempt.invoiceNumber })}</span>
          <Badge variant={attempt.status === 'succeeded' ? 'success' : attempt.status === 'failed' ? 'destructive' : attempt.status === 'processing' ? 'warning' : 'secondary'}>
            {statusLabel}
          </Badge>
        </span>
      }
      description={attempt.customerName}
      headerActions={
        retryable ? (
          <Button disabled={busy} onClick={() => void retryNow()}>
            {busy ? tc('actions.saving') : t('retryNow')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p className="text-sm">{summary}</p>
        {attempt.status === 'failed' && attempt.nextRetryOn && (
          <p className="text-sm text-muted-foreground">{t('nextRetry', { date: attempt.nextRetryOn })}</p>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('amount')}</dt>
          <dd>{formattedAmount}</dd>
          <dt className="text-muted-foreground">{t('method')}</dt>
          <dd>{attempt.methodLabel ?? tc('labels.notSet')}</dd>
          {attempt.declineCode && (
            <>
              <dt className="text-muted-foreground">{t('decline')}</dt>
              <dd>{attempt.declineCode}</dd>
            </>
          )}
        </dl>
        <DisclosureSection title={t('providerDetail')} summary={attempt.provider} forceOpen={attempt.status === 'processing'}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t('provider')}</dt>
            <dd>{attempt.provider}</dd>
            <dt className="text-muted-foreground">{t('position')}</dt>
            <dd>{attempt.retryPosition + 1}</dd>
            <dt className="text-muted-foreground">{t('providerRef')}</dt>
            <dd className="break-all">{attempt.providerRef ?? tc('labels.notSet')}</dd>
            <dt className="text-muted-foreground">{t('attemptedAt')}</dt>
            <dd>{attempt.attemptedAt}</dd>
          </dl>
        </DisclosureSection>
      </div>
    </UrlDrawer>
  )
}
