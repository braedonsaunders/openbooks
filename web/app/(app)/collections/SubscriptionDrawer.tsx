'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, DisclosureSection, SearchSelect } from '@openbooks/ui'
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
  const router = useRouter()
  const { money } = useMoney()
  const amount = money(drawer.amount, { currency: drawer.currency })
  const [billTo, setBillTo] = useState<string | null>(drawer.billTo?.id ?? null)
  const [payer, setPayer] = useState<string | null>(drawer.payer?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const options = drawer.customers.map((c) => ({ value: c.id, label: c.name }))
  const dirty =
    (billTo ?? null) !== (drawer.billTo?.id ?? null) || (payer ?? null) !== (drawer.payer?.id ?? null)

  async function onSaveOverrides() {
    setBusy(true)
    setFailure(null)
    try {
      const res = await fetch('/api/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'updateSubscription', id: drawer.id, billToPartyId: billTo, payerPartyId: payer }),
      })
      // The refusal names the remedy; parsing the body first would turn it
      // into a JSON error the operator cannot act on.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        throw new Error(typeof body?.error === 'string' && body.error ? body.error : t('overrides.saveFailed'))
      }
      toast.success(t('overrides.saved'))
      router.refresh()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : t('overrides.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

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
      <DisclosureSection title={t('billing.title')} summary={t('billing.summary')}>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('billing.customer')}</dt>
            <dd>{drawer.customer.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t('billing.autoPost')}</dt>
            <dd>{drawer.autoPost ? common('yes') : common('no')}</dd>
          </div>
        </dl>
        {drawer.canManage ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">{t('overrides.hint')}</p>
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">{t('overrides.billTo')}</span>
              <SearchSelect
                searchable
                clearable
                value={billTo ?? ''}
                onChange={(value) => setBillTo(value || null)}
                options={options}
                placeholder={t('billing.sameAsCustomer')}
              />
            </div>
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">{t('overrides.payer')}</span>
              <SearchSelect
                searchable
                clearable
                value={payer ?? ''}
                onChange={(value) => setPayer(value || null)}
                options={options}
                placeholder={t('billing.sameAsCustomer')}
              />
            </div>
            {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
            <Button variant="outline" disabled={!dirty || busy} onClick={onSaveOverrides}>
              {t('overrides.save')}
            </Button>
          </div>
        ) : (
          <dl className="mt-2 space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('billing.billTo')}</dt>
              <dd>{drawer.billTo ? drawer.billTo.name : t('billing.sameAsCustomer')}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('billing.payer')}</dt>
              <dd>{drawer.payer ? drawer.payer.name : t('billing.sameAsCustomer')}</dd>
            </div>
          </dl>
        )}
      </DisclosureSection>
    </TransactionDrawer>
  )
}
