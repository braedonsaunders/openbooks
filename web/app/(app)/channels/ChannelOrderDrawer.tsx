'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Badge, Button } from '@openbooks/ui'
import { DisclosureSection } from '@openbooks/ui'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { TransactionDrawer } from '../../../components/transaction-drawer'
import { useAppAction } from '@/lib/use-app-action'
import { createMoneyFormatter, minorToMajorText } from '@/lib/money-format'
import { channelRequest } from './channel-client'
import type { ChannelOrderDrawerData } from './order-detail'

function statusVariant(status: string): 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success' {
  if (status === 'posted' || status === 'summarized') return 'success'
  if (status === 'exception') return 'destructive'
  if (status === 'excluded') return 'secondary'
  if (status === 'pending') return 'warning'
  return 'outline'
}

export function ChannelOrderDrawer({ drawer, closeHref }: { drawer: ChannelOrderDrawerData; closeHref: string }) {
  const t = useTranslations('channels')
  const locale = useLocale()
  const router = useRouter()
  const { busy, refusal: replayRefusal, execute } = useAppAction()
  const money = createMoneyFormatter(locale, drawer.currency)
  const amount = (minor: string) => money.money(minorToMajorText(minor), { currency: drawer.currency })

  const onReplay = async () => {
    await execute(
      () => channelRequest<{ status: string }>(`/api/channels/orders/${drawer.id}/replay`, { method: 'POST' }, t('drawer.replay')),
      {
        fallbackMessage: t('drawer.replay'),
        onOk: (outcome) => {
          router.refresh()
          toast.success(
            t('drawer.replayed', {
              count: 1,
              posted: outcome.status === 'posted' ? 1 : 0,
              parked: outcome.status === 'exception' ? 1 : 0,
            }),
          )
        },
      },
    )
  }

  const actions = (
    <>
      {drawer.documentHref && drawer.document ? (
        <Button variant="outline" asChild>
          <Link href={drawer.documentHref}>{drawer.document.number ?? t('drawer.document')}</Link>
        </Button>
      ) : null}
      {drawer.canManage && (drawer.status === 'exception' || drawer.status === 'pending') ? (
        <Button variant="outline" disabled={busy} onClick={onReplay}>
          {t('drawer.replay')}
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
          <span className="font-mono">{drawer.orderNumber}</span>
          <Badge variant={statusVariant(drawer.status)}>{t(`orderStatus.${drawer.status}`)}</Badge>
        </span>
      }
      description={[drawer.channelName, drawer.customerEmail ?? drawer.customerName].filter(Boolean).join(' · ') || undefined}
      actions={actions}
      detailTabs={[
        {
          key: 'lines',
          label: t('drawer.lines'),
          content: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('drawer.item')}</TableHead>
                  <TableHead>{t('drawer.quantity')}</TableHead>
                  <TableHead className="text-right">{t('drawer.price')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.lines.map((line, index) => (
                  <TableRow key={`${line.sku ?? line.title}-${index}`}>
                    <TableCell>
                      <div className="font-medium">{line.title}</div>
                      {line.sku ? <div className="font-mono text-xs text-slate-500">{line.sku}</div> : null}
                    </TableCell>
                    <TableCell>{line.quantity}</TableCell>
                    <TableCell className="text-right">{amount(line.unitMinor)}</TableCell>
                  </TableRow>
                ))}
                {drawer.shipping.map((line, index) => (
                  <TableRow key={`shipping-${index}`}>
                    <TableCell>
                      <div className="font-medium">{line.title}</div>
                    </TableCell>
                    <TableCell>1</TableCell>
                    <TableCell className="text-right">{amount(line.amountMinor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ),
        },
        {
          key: 'payment',
          label: t('drawer.tenders'),
          content: (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('drawer.gateway')}</TableHead>
                  <TableHead>{t('drawer.reference')}</TableHead>
                  <TableHead className="text-right">{t('drawer.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drawer.tenders.map((tender, index) => (
                  <TableRow key={`${tender.gateway}-${index}`}>
                    <TableCell>
                      {tender.gateway}
                      {tender.giftCard ? (
                        <Badge variant="secondary" className="ml-2">
                          {t('drawer.giftCard')}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tender.reference ?? '—'}</TableCell>
                    <TableCell className="text-right">{amount(tender.amountMinor)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ),
        },
      ]}
    >
      <div className="space-y-6 p-1">
        <ActionAlert error={replayRefusal} fallbackMessage={t('drawer.replay')} />
        {drawer.exception ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
            <div className="flex items-center gap-2">
              <Badge variant="destructive">{t(`exceptionCodes.${drawer.exception.code}`)}</Badge>
            </div>
            <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{drawer.exception.reason}</p>
            <p className="mt-1 text-sm font-medium text-slate-900 dark:text-white">{drawer.exception.remedy}</p>
            {drawer.canManage ? (
              <div className="mt-3 flex gap-2">
                <Button size="sm" disabled={busy} onClick={onReplay}>
                  {t('drawer.replay')}
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <Link href={`/channels/exceptions?code=${drawer.exception.code}`}>{t('drawer.filterByCause')}</Link>
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500">{t('drawer.customer')}</dt>
            <dd className="font-medium">{drawer.customerName ?? drawer.customerEmail ?? '—'}</dd>
          </div>
          <div className="text-right">
            <dt className="text-slate-500">{t('drawer.tenders')}</dt>
            <dd className="font-mono text-base font-semibold">{amount(drawer.totalMinor)}</dd>
          </div>
        </dl>
        <DisclosureSection title={t('drawer.posting')} summary={drawer.policyMode ? t(`posting.${drawer.policyMode === 'daily_summary' ? 'modeDailySummary' : 'modePerOrder'}`) : undefined}>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">{t('drawer.document')}</dt>
              <dd>
                {drawer.document && drawer.documentHref ? (
                  <Link href={drawer.documentHref} className="font-medium text-sky-700 hover:underline dark:text-sky-300">
                    {drawer.document.number ?? drawer.document.id}
                  </Link>
                ) : (
                  <span className="text-slate-500">{t('drawer.noDocument')}</span>
                )}
              </dd>
            </div>
            {drawer.summary ? (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{t('drawer.summary')}</dt>
                <dd className="font-medium">
                  {drawer.summary.summaryDate}
                  {drawer.summary.documentNumber ? ` · ${drawer.summary.documentNumber}` : ''}
                </dd>
              </div>
            ) : null}
            {drawer.presentmentCurrency !== drawer.currency && drawer.presentmentRate ? (
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{drawer.presentmentCurrency}</dt>
                <dd className="font-mono">{drawer.presentmentRate}</dd>
              </div>
            ) : null}
          </dl>
        </DisclosureSection>
      </div>
    </TransactionDrawer>
  )
}
