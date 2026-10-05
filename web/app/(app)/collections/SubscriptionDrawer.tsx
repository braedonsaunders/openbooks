'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge, Button, DisclosureSection } from '@openbooks/ui'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { useMoney } from '../../../components/money-provider'
import type { SubscriptionDrawerData } from './subscription-drawer'

function statusVariant(status: SubscriptionDrawerData['status']): 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success' {
  if (status === 'active') return 'success'
  if (status === 'suspended') return 'destructive'
  if (status === 'paused') return 'warning'
  return 'secondary'
}

/**
 * Minimal subscription record: status, the next bill, and who pays — with
 * the bill-to/payer overrides and the revenue contract one disclosure down.
 * Opens from a collections row, a revenue contract source link, or the
 * subscription list-drawer route; one drawer shell through loading, refusal
 * and retry.
 */
export function SubscriptionDrawer({ drawer, closeHref }: { drawer: SubscriptionDrawerData; closeHref: string }) {
  const t = useTranslations('ar.collections.subscriptions.drawer')
  const common = useTranslations('common')
  const money = useMoney()
  const amount = money(drawer.amount, { currency: drawer.currency })

  const actions = (
    <>
      {drawer.contract ? (
        <Button variant="outline" asChild>
          <Link href={`/revenue?contract=${encodeURIComponent(drawer.contract.id)}`}>{drawer.contract.number}</Link>
        </Button>
      ) : null}
      {drawer.lastInvoice ? (
        <Button variant="outline" asChild>
          <Link href={`/ar/invoices?doc=${encodeURIComponent(drawer.lastInvoice.id)}`}>{drawer.lastInvoice.number}</Link>
        </Button>
      ) : null}
    </>
  )

  return (
    <TransactionDrawer
      closeHref={closeHref}
      recordId={drawer.id}
      title={
        <span className="flex items-center gap-2.5">
          <span>{drawer.planName}</span>
          <Badge variant={statusVariant(drawer.status)}>{t(`status.${drawer.status}`)}</Badge>
        </span>
      }
      description={[drawer.customer.name, t('every', { count: drawer.intervalCount, unit: drawer.interval })].filter(Boolean).join(' · ')}
      actions={actions}
      detailTabs={[]}
    >
      <div className="space-y-2">
        <p className="tabular-nums text-lg font-semibold">
          {amount} <span className="text-sm font-normal text-muted-foreground">/ {t('every', { count: drawer.intervalCount, unit: drawer.interval })}</span>
        </p>
        <p className="text-sm text-muted-foreground">
          {t('nextBill', { date: drawer.nextBillOn })}
        </p>
        {drawer.lastError ? (
          <p className="text-sm text-destructive">{drawer.lastError}</p>
        ) : null}
      </div>
      <DisclosureSection summary={t('billing.title')}>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('billing.customer')}</dt>
            <dd>{drawer.customer.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('billing.billTo')}</dt>
            <dd>{drawer.billTo ? drawer.billTo.name : t('billing.sameAsCustomer')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('billing.payer')}</dt>
            <dd>{drawer.payer ? drawer.payer.name : t('billing.sameAsCustomer')}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('billing.autoPost')}</dt>
            <dd>{drawer.autoPost ? common('yes') : common('no')}</dd>
          </div>
        </dl>
      </DisclosureSection>
    </TransactionDrawer>
  )
}
