'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, DisclosureSection, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { providerCommitRetryable, providerCommitStatusVariant } from '../../../components/tax-provider-chip'

export type ProviderActivityExcerpt = {
  postedTax: string
  merchantTax: string
  providerTax: string
  mismatch: string
}

export type ProviderActivityPayload = {
  id: string
  documentId: string
  documentNumber: string
  documentKind: string
  provider: string
  providerCode: string
  kind: string
  status: string
  attempts: number
  nextAttemptAt: string | null
  lastError: string | null
  committedAt: string | null
  excerpt: ProviderActivityExcerpt | null
};

/**
 * One provider commit: its plain-words state and next action up front,
 * retry configuration in the middle, provider evidence collapsed at the
 * bottom. The shell stays mounted through retry and its refusal.
 */
export function ProviderActivityDrawer({
  drawer,
}: {
  drawer: { activity: ProviderActivityPayload; canRetry: boolean; closeHref: string }
}) {
  const t = useTranslations('tax.activity')
  const tc = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { activity, canRetry, closeHref } = drawer
  const retryable = providerCommitRetryable(canRetry, activity.status)
  // The scan always writes the five-key excerpt, but a row predating the
  // shape (or a hand-touched one) must not render undefined figures.
  const excerpt = activity.excerpt != null
    && typeof activity.excerpt.postedTax === 'string'
    && typeof activity.excerpt.merchantTax === 'string'
    && typeof activity.excerpt.providerTax === 'string'
    && typeof activity.excerpt.mismatch === 'string'
    ? activity.excerpt
    : null
  const mismatch = excerpt != null && excerpt.mismatch !== '0'
  const summary =
    activity.status === 'committed' ? t('summaryCommitted', { document: activity.documentNumber, provider: activity.provider })
    : activity.status === 'failed' ? t('summaryFailed', { document: activity.documentNumber, provider: activity.provider })
    : activity.status === 'voided' ? t('summaryVoided', { document: activity.documentNumber, provider: activity.provider })
    : activity.status === 'skipped' ? t('summarySkipped', { document: activity.documentNumber, provider: activity.provider })
    : t('summaryPending', { document: activity.documentNumber, provider: activity.provider })

  const retryNow = async () => {
    const confirmed = await confirmDialog({
      title: t('retryConfirmTitle'),
      message: t('retryConfirmDescription', { document: activity.documentNumber, provider: activity.provider }),
      confirmLabel: t('retryNow'),
      cancelLabel: tc('actions.cancel'),
    })
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/tax/provider-transactions/${activity.id}/retry`, { method: 'POST' })
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
          <span>{t('title', { document: activity.documentNumber })}</span>
          <Badge variant={providerCommitStatusVariant(activity.status)}>
            {t(`status.${activity.status}`)}
          </Badge>
        </span>
      }
      description={activity.provider}
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
        {activity.status === 'failed' && activity.lastError && (
          <p className="text-sm text-muted-foreground">{activity.lastError}</p>
        )}
        {mismatch && excerpt && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            {t('mismatchNotice', { providerTax: excerpt.providerTax, merchantTax: excerpt.merchantTax })}
          </p>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('document')}</dt>
          <dd>{activity.documentNumber}</dd>
          <dt className="text-muted-foreground">{t('direction')}</dt>
          <dd>{t(`direction_${activity.kind}`)}</dd>
          <dt className="text-muted-foreground">{t('providerCode')}</dt>
          <dd className="break-all">{activity.providerCode}</dd>
          <dt className="text-muted-foreground">{t('attempts')}</dt>
          <dd>{activity.attempts}</dd>
          {activity.nextAttemptAt && (
            <>
              <dt className="text-muted-foreground">{t('nextAttempt')}</dt>
              <dd>{activity.nextAttemptAt}</dd>
            </>
          )}
          {activity.committedAt && (
            <>
              <dt className="text-muted-foreground">{t('committedAt')}</dt>
              <dd>{activity.committedAt}</dd>
            </>
          )}
        </dl>
        {excerpt && (
          <DisclosureSection title={t('providerDetail')} forceOpen={mismatch}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t('postedTax')}</dt>
              <dd className="tabular-nums">{excerpt.postedTax}</dd>
              <dt className="text-muted-foreground">{t('merchantTax')}</dt>
              <dd className="tabular-nums">{excerpt.merchantTax}</dd>
              <dt className="text-muted-foreground">{t('providerTax')}</dt>
              <dd className="tabular-nums">{excerpt.providerTax}</dd>
            </dl>
          </DisclosureSection>
        )}
      </div>
    </UrlDrawer>
  )
}
