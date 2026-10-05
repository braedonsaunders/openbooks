'use client'

import * as React from 'react'
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
import { readApiErrorMessage } from '@/lib/api-error'
import { createMoneyFormatter, displayMinorAmount } from '@/lib/money-format'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'
import { channelRequest } from './channel-client'
import type { ChannelOrderDrawerData } from './order-detail'

function statusVariant(status: string): 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success' {
  if (status === 'posted' || status === 'summarized') return 'success'
  if (status === 'exception') return 'destructive'
  if (status === 'excluded') return 'secondary'
  if (status === 'pending') return 'warning'
  return 'outline'
}

interface AssistanceCandidate {
  rank: number
  kind: 'link_variant' | 'map_account' | 'map_location' | 'manual'
  label: string
  detail: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
}

interface AssistanceSuggestion {
  orderId: string
  code: string
  candidates: AssistanceCandidate[]
  similarCount: number
  explanation: string
  modelRanked: boolean
}

function confidenceVariant(confidence: string): 'success' | 'secondary' | 'outline' {
  if (confidence === 'high') return 'success'
  if (confidence === 'medium') return 'secondary'
  return 'outline'
}

/**
 * Classified fix proposal for one parked order. Everyday depth is the top
 * candidate chip with Apply; the candidate list is the configure depth;
 * evidence and the posting consequence sit inside a collapsed advanced
 * section. Approving asks for confirmation first and never posts by itself.
 */
function ExceptionAssistance({ orderId, canManage }: { orderId: string; canManage: boolean }) {
  const t = useTranslations('channels')
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [suggestion, setSuggestion] = React.useState<AssistanceSuggestion | null>(null)
  const [modelNote, setModelNote] = React.useState<string | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [rank, setRank] = React.useState(0)

  React.useEffect(() => {
    let live = true
    fetch(`/api/channels/exceptions/${orderId}/suggestion`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          if (live) setLoadError(await readApiErrorMessage(res, 'The proposed fix did not load.'))
          return
        }
        const body = (await res.json()) as {
          suggestion: AssistanceSuggestion
          ranking: { modelRanked: boolean; note: string | null }
        }
        if (live) {
          setSuggestion(body.suggestion)
          setModelNote(body.ranking.note)
          setRank(0)
        }
      })
      .catch(() => {
        if (live) setLoadError('The proposed fix did not load. Check your connection and try again.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [orderId])

  const candidate = suggestion?.candidates[rank] ?? null

  const onApprove = async (applyToSimilar: boolean) => {
    if (!suggestion || !candidate || candidate.kind === 'manual') return
    const confirmed = await confirmDialog({
      title: t('assistance.confirmTitle'),
      message: t('assistance.confirmBody', {
        fix: candidate.detail,
        count: applyToSimilar ? suggestion.similarCount : 1,
      }),
      confirmLabel: t('assistance.apply'),
    })
    if (!confirmed) return
    await execute(
      () =>
        channelRequest<{ applied: string; replay: { replayed: number; posted: number; parked: number; waiting: number } }>(
          `/api/channels/exceptions/${orderId}/approve`,
          { method: 'POST', body: { rank, applyToSimilar } },
          t('assistance.apply'),
        ),
      {
        fallbackMessage: t('assistance.apply'),
        onOk: (outcome) => {
          router.refresh()
          toast.success(t('assistance.approved', { posted: outcome.replay.posted, parked: outcome.replay.parked }))
        },
      },
    )
  }

  const onReject = async () => {
    const reason = await promptDialog({ title: t('assistance.rejectTitle'), label: t('assistance.rejectLabel') })
    if (reason === null) return
    await execute(
      () => channelRequest(`/api/channels/exceptions/${orderId}/reject`, { method: 'POST', body: { reason } }, t('assistance.reject')),
      {
        fallbackMessage: t('assistance.reject'),
        onOk: () => {
          router.refresh()
          toast.success(t('assistance.rejected'))
        },
      },
    )
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <p className="text-sm text-slate-500">{t('assistance.loading')}</p>
      </div>
    )
  }
  if (loadError || !suggestion || !candidate) {
    return (
      <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <p className="text-sm text-slate-500">{loadError ?? t('assistance.loadFailed')}</p>
      </div>
    )
  }
  return (
    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
      <ActionAlert error={refusal} fallbackMessage={t('assistance.apply')} />
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={candidate.kind === 'manual' ? 'warning' : confidenceVariant(candidate.confidence)}>{candidate.label}</Badge>
        {suggestion.similarCount > 1 ? (
          <span className="text-xs text-slate-500">{t('assistance.similar', { count: suggestion.similarCount })}</span>
        ) : null}
      </div>
      <p className="mt-2 text-sm text-slate-700 dark:text-slate-200">{modelNote ?? suggestion.explanation}</p>
      {suggestion.candidates.length > 1 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestion.candidates.map((entry) => (
            <Button key={entry.rank} size="sm" variant={entry.rank === rank ? 'default' : 'outline'} disabled={busy} onClick={() => setRank(entry.rank)}>
              {entry.label}
            </Button>
          ))}
        </div>
      ) : null}
      <DisclosureSection title={t('assistance.evidence')} summary={t('assistance.evidenceSummary', { count: candidate.evidence.length })}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-200">
          {candidate.evidence.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-slate-500">{candidate.detail}</p>
      </DisclosureSection>
      {canManage && candidate.kind !== 'manual' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => onApprove(false)}>
            {t('assistance.apply')}
          </Button>
          {suggestion.similarCount > 1 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onApprove(true)}>
              {t('assistance.applySimilar', { count: suggestion.similarCount })}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={onReject}>
            {t('assistance.reject')}
          </Button>
        </div>
      ) : null}
      {canManage && candidate.kind === 'manual' ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={onReject}>
            {t('assistance.reject')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
const COMPONENT_ORDER = [
  'net_revenue',
  'discount',
  'cogs',
  'processor_fee',
  'shipping_label',
  'marketplace_fee',
  'stored_value_funding',
  'returns',
  'restocking_fee',
  'ad_spend',
]

export function ChannelOrderDrawer({ drawer, closeHref }: { drawer: ChannelOrderDrawerData; closeHref: string }) {
  const t = useTranslations('channels')
  const locale = useLocale()
  const router = useRouter()
  const { busy, refusal: replayRefusal, execute } = useAppAction()
  const { busy: refreshBusy, refusal: refreshRefusal, execute: executeRefresh } = useAppAction()
  const money = createMoneyFormatter(locale, drawer.currency)
  // Precision comes from the authoritative registry via currencyUnits. A
  // missing, malformed, or out-of-range precision renders the named notice
  // for that currency instead of guessing /100 or unmounting the drawer.
  // The registry exponent rides as both fraction digits: Intl defaults
  // would otherwise override it for private/custom codes.
  const amountIn = (minor: string, currency: string) => {
    const display = displayMinorAmount(minor, drawer.currencyUnits[currency])
    if (display === null) return t('drawer.unknownPrecision', { currency })
    const formatter = currency === drawer.currency ? money : createMoneyFormatter(locale, currency)
    return formatter.money(display.major, {
      currency,
      minimumFractionDigits: display.digits,
      maximumFractionDigits: display.digits,
    })
  }
  const amount = (minor: string) => amountIn(minor, drawer.currency)

  const onRefreshEconomics = async () => {
    await executeRefresh(
      () => channelRequest<{ inserted: number; retired: number }>(`/api/channels/orders/${drawer.id}/economics`, { method: 'POST' }, t('drawer.refreshEconomics')),
      {
        fallbackMessage: t('drawer.refreshEconomics'),
        onOk: (outcome) => {
          router.refresh()
          toast.success(t('drawer.refreshedEconomics', { inserted: outcome.inserted, retired: outcome.retired }))
        },
      },
    )
  }

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
          key: 'activity',
          label: t('drawer.activity'),
          content: drawer.timeline.length === 0 ? (
            <p className="p-1 text-sm text-slate-500">{t('timeline.empty')}</p>
          ) : (
            <ol className="space-y-4 p-1">
              {drawer.timeline.map((item) => (
                <li key={item.id} className="flex gap-3">
                  <span aria-hidden className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {item.outbound ? t('timeline.pushed') : t(`timeline.kind.${item.kind}`)}
                      </Badge>
                      <Badge variant={statusVariant(item.status)}>{t(`timeline.status.${item.status}`)}</Badge>
                      <span className="text-xs text-slate-500">
                        {new Date(item.occurredAt).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    {item.amountMinor ? (
                      <p className="text-sm font-medium">{amount(item.amountMinor)}{item.restocks ? ` · ${t('timeline.restocks')}` : ''}</p>
                    ) : null}
                    {item.tracking ? <p className="font-mono text-xs text-slate-600 dark:text-slate-300">{item.tracking}</p> : null}
                    {item.summary ? <p className="text-xs text-slate-600 dark:text-slate-300">{item.summary}</p> : null}
                    {item.reason ? <p className="text-sm text-slate-700 dark:text-slate-200">{item.reason}</p> : null}
                    {item.document && item.documentHref ? (
                      <Link href={item.documentHref} className="text-sm font-medium text-sky-700 hover:underline dark:text-sky-300">
                        {item.document.number ?? t('drawer.document')}
                      </Link>
                    ) : null}
                    {item.exception ? (
                      <p className="text-xs text-slate-600 dark:text-slate-300">
                        <span className="font-medium">{t(`exceptionCodes.${item.exception.code}`)}: </span>
                        {item.exception.reason} {item.exception.remedy}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
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
        {drawer.exception ? <ExceptionAssistance orderId={drawer.id} canManage={drawer.canManage} /> : null}
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
        {drawer.economics ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">{t('drawer.cm2')}</p>
              <p className="font-mono text-base font-semibold">{amount(drawer.economics.cm2Minor)}</p>
            </div>
            <div className="flex items-center gap-2">
              {drawer.economics.estimatedAny ? <Badge variant="warning">{t('drawer.estimated')}</Badge> : null}
              {drawer.economics.marginPct != null ? (
                <Badge variant="secondary">{t('drawer.marginPct', { pct: drawer.economics.marginPct })}</Badge>
              ) : null}
            </div>
          </div>
        ) : null}
        <ActionAlert error={refreshRefusal} fallbackMessage={t('drawer.refreshEconomics')} />
        {drawer.economics ? (
          <DisclosureSection
            title={t('drawer.economicsTitle')}
            summary={t('drawer.economicsSummary', { cm2: amount(drawer.economics.cm2Minor) })}
            forceOpen={drawer.economics.estimatedAny}
          >
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{t('drawer.revenue')}</dt>
                <dd className="font-mono">{amount(drawer.economics.revenueMinor)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{t('drawer.cm1')}</dt>
                <dd className="font-mono">{amount(drawer.economics.cm1Minor)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{t('drawer.cm2')}</dt>
                <dd className="font-mono font-semibold">{amount(drawer.economics.cm2Minor)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">{t('drawer.cm3')}</dt>
                <dd className="font-mono">{amount(drawer.economics.cm3Minor)}</dd>
              </div>
            </dl>
            <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
              {[...drawer.economics.components]
                .sort((a, b) => COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component))
                .map((row) => (
                  <li key={`${row.component}|${row.sourceKind}|${row.currency}`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="font-medium">{t(`drawer.components.${row.component}`)}</span>
                      <span className="text-slate-500"> · {t(`drawer.sources.${row.sourceKind}`)}</span>
                      {row.estimated ? (
                        <Badge variant="warning" className="ml-2">
                          {t('drawer.estimated')}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="shrink-0 font-mono">{amountIn(row.amountMinor, row.currency)}</span>
                  </li>
                ))}
            </ul>
            {drawer.economics.storedValueMinor !== '0' ? (
              <p className="mt-3 text-sm text-slate-500">
                {t('drawer.storedValueNote', { amount: amount(drawer.economics.storedValueMinor) })}
              </p>
            ) : null}
            {drawer.economics.mixedCurrency ? (
              <p className="mt-1 text-sm text-slate-500">{t('drawer.mixedCurrencyNote')}</p>
            ) : null}
            <div className="mt-3 flex gap-2">
              {drawer.canManage ? (
                <Button size="sm" variant="outline" disabled={refreshBusy} onClick={onRefreshEconomics}>
                  {t('drawer.refreshEconomics')}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" asChild>
                <Link href="/reports">{t('drawer.openReport')}</Link>
              </Button>
            </div>
          </DisclosureSection>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-300 p-4 dark:border-slate-700">
            <p className="text-sm font-medium">{t('drawer.noEconomicsTitle')}</p>
            <p className="mt-1 text-sm text-slate-500">{t('drawer.noEconomicsBody')}</p>
            {drawer.canManage ? (
              <div className="mt-3">
                <Button size="sm" variant="outline" disabled={refreshBusy} onClick={onRefreshEconomics}>
                  {t('drawer.refreshEconomics')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
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
