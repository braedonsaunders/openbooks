'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle, Badge, Button, DisclosureSection, EmptyState } from '@openbooks/ui'
import { Banknote, HeartHandshake, KeyRound, Percent, ShieldAlert, Timer } from 'lucide-react'
import { StatTile, CockpitPanel } from '../../../components/cockpit/ui'
import { createMoneyFormatter } from '@/lib/money-format'
import type { CollectionPolicyNotice, RecoveryDashboardData } from './view'

/**
 * Revenue recovery at a glance: what automatic collection brought back in
 * the trailing window, and the three queues that need a human — customers
 * who must verify a payment, cards about to expire, and hard declines with
 * no backup on file. Every queue row carries its one-click remedy; the
 * class/provider breakdown lives one disclosure down, and the full history
 * in the Reports hub.
 */
export function RecoveryDashboard({ data, notice }: { data: RecoveryDashboardData | null; notice?: CollectionPolicyNotice | null }) {
  const t = useTranslations('ar.collections.recovery')
  const locale = useLocale()
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  // Automatic collection is on but no collection policy is: the dashboard
  // has no schedule to report against, so its slot carries the setup remedy
  // and the rest of the page renders around it.
  if (!data) {
    if (!notice) return null
    return (
      <Alert variant="warning">
        <AlertTitle>{notice.title}</AlertTitle>
        <AlertDescription>
          <p>{notice.description}</p>
          <Button asChild size="sm" variant="outline" className="mt-3">
            <Link href={notice.actionHref}>{notice.actionLabel}</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  const { money } = createMoneyFormatter(locale, 'USD')
  const rate = data.metrics.recoveryRate
  // Recovered revenue is shown per currency — a multi-currency book never
  // presents a mixed-currency sum as one number.
  const recoveredValue = data.metrics.recoveredByCurrency
    .map((row) => money(row.amount, { currency: row.currency }))
    .join(' · ')
  const attentionCount =
    data.awaitingAuth.length + data.expiring.length + data.hardStuck.length

  const copyAuthLink = async (authUrl: string | null) => {
    if (!authUrl) return
    try {
      await navigator.clipboard.writeText(authUrl)
      toast.success(t('linkCopied'))
    } catch {
      toast.error(t('linkCopyFailed'))
    }
  }

  const sendUpdateLink = async (row: RecoveryDashboardData['expiring'][number]) => {
    const key = `expiring:${row.methodId}`
    setBusy(key)
    try {
      const setupRes = await fetch('/api/autopay/methods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partyId: row.partyId, provider: row.provider, currency: row.currency }),
      })
      if (!setupRes.ok) {
        toast.error(t('updateLinkFailed'))
        return
      }
      const setup = (await setupRes.json()) as { setupUrl?: string }
      if (!setup.setupUrl) {
        toast.error(t('updateLinkFailed'))
        return
      }
      await navigator.clipboard.writeText(`${window.location.origin}${setup.setupUrl}`)
      const markRes = await fetch(`/api/autopay/methods/${row.methodId}/outreach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!markRes.ok) {
        toast.error(t('outreachMarkFailed'))
        return
      }
      toast.success(t('updateLinkSent'))
      router.refresh()
    } catch {
      toast.error(t('updateLinkFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          label={t('recovered')}
          value={recoveredValue === '' ? '—' : recoveredValue}
          sub={t('recoveredSub', { count: data.metrics.recoveredInvoices })}
          icon={Banknote}
          accent="emerald"
          tone={data.metrics.recoveredInvoices > 0 ? 'positive' : 'neutral'}
        />
        <StatTile
          label={t('recoveryRate')}
          value={rate === null ? '—' : `${(rate * 100).toFixed(1)}%`}
          sub={t('recoveryRateSub', { failed: data.metrics.invoicesWithFailures })}
          icon={Percent}
          accent="teal"
          tone="neutral"
        />
        <StatTile
          label={t('waitingOnCustomers')}
          value={String(data.metrics.awaitingAuthentication)}
          sub={t('waitingOnCustomersSub')}
          icon={KeyRound}
          accent="amber"
          tone={data.metrics.awaitingAuthentication > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label={t('churnPrevented')}
          value={String(data.metrics.churnPrevented)}
          sub={t('churnPreventedSub', { attempts: data.metrics.attempts })}
          icon={HeartHandshake}
          accent="sky"
          tone={data.metrics.churnPrevented > 0 ? 'positive' : 'neutral'}
        />
      </div>

      <CockpitPanel
        title={t('attentionTitle')}
        icon={ShieldAlert}
        hint={attentionCount === 0 ? t('attentionClear') : t('attentionCount', { count: attentionCount })}
      >
        {attentionCount === 0 ? (
          <EmptyState title={t('attentionEmptyTitle')} description={t('attentionEmptyDescription')} />
        ) : (
          <div className="flex flex-col gap-4">
            {data.awaitingAuth.map((row) => (
              <div key={row.attemptId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant="warning">{t('needsAuth')}</Badge>
                <a className="text-sm font-medium underline" href={`/collections?attempt=${row.attemptId}`}>
                  {row.invoiceNumber}
                </a>
                <span className="text-sm text-muted-foreground">
                  {row.customerName} · {money(row.amount, { currency: row.currency })}
                </span>
                <span className="flex-1" />
                <Button
                  variant="outline"
                  disabled={!row.authUrl}
                  onClick={() => void copyAuthLink(row.authUrl)}
                >
                  {t('copyAuthLink')}
                </Button>
              </div>
            ))}
            {data.expiring.map((row) => (
              <div key={row.methodId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant="warning">{t('cardExpiring')}</Badge>
                <span className="text-sm font-medium">
                  {row.partyName ?? row.partyId} · {row.brand ?? ''} •••• {row.last4 ?? ''}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('expiresOn', { date: row.expiresOn })}
                </span>
                <span className="flex-1" />
                <Button
                  variant="outline"
                  disabled={busy === `expiring:${row.methodId}`}
                  onClick={() => void sendUpdateLink(row)}
                >
                  {t('sendUpdateLink')}
                </Button>
              </div>
            ))}
            {data.hardStuck.map((row) => (
              <div key={row.attemptId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge variant="destructive">{t('hardStuck')}</Badge>
                <a className="text-sm font-medium underline" href={`/collections?attempt=${row.attemptId}`}>
                  {row.invoiceNumber}
                </a>
                <span className="text-sm text-muted-foreground">
                  {row.customerName} · {money(row.amount, { currency: row.currency })}
                  {row.declineCode ? ` · ${row.declineCode}` : ''}
                </span>
                <span className="flex-1" />
                <span className="text-sm text-muted-foreground">{t('hardStuckHint')}</span>
              </div>
            ))}
          </div>
        )}
        <DisclosureSection
          title={t('breakdownTitle')}
          summary={t('breakdownSummary')}
        >
          <div className="flex flex-col gap-3">
            {data.metrics.byDeclineClass.map((row) => (
              <div key={row.declineClass} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Badge variant="secondary">{row.declineClass}</Badge>
                <span className="text-muted-foreground">
                  {t('breakdownRow', {
                    failed: row.failedAttempts,
                    recovered: row.recoveredInvoices,
                    rate: row.recoveryRate === null ? '—' : `${(row.recoveryRate * 100).toFixed(1)}%`,
                  })}
                </span>
              </div>
            ))}
            {data.metrics.byProvider.map((row) => (
              <div key={row.provider} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <Badge variant="outline">{row.provider}</Badge>
                <span className="text-muted-foreground">
                  {t('breakdownRow', {
                    failed: row.failedAttempts,
                    recovered: row.recoveredInvoices,
                    rate: row.recoveryRate === null ? '—' : `${(row.recoveryRate * 100).toFixed(1)}%`,
                  })}
                </span>
              </div>
            ))}
            <a className="text-sm font-medium underline" href="/reports">
              <Timer size={13} className="mr-1 inline" />
              {t('openReports')}
            </a>
          </div>
        </DisclosureSection>
      </CockpitPanel>
    </div>
  )
}
