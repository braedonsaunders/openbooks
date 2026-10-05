'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import {
  Badge,
  Button,
  DisclosureSection,
  EmptyState,
  Label,
  Select,
  SearchSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { DrawerTabStrip } from '../../../../components/drawer-tab-strip'
import { useAppAction } from '@/lib/use-app-action'
import { readApiErrorMessage } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'
import { promptDialog } from '@/lib/prompt'
import { createMoneyFormatter } from '@/lib/money-format'
import type { PackagePresetOption, ShippingAccountOption } from '../../_fulfillment/types'
import { minorToMajor } from './shipping-display'

interface RateView {
  providerRateId: string
  providerShipmentId: string
  parcelIndexes: number[]
  carrier: string
  service: string
  amount: string
  currency: string
  markedUpAmount: string
  deliveryDate: string | null
  deliveryDays: number | null
  badges: Array<'cheapest' | 'fastest' | 'best_value'>
}

interface QuoteView {
  shipmentId: string
  documentNumber: string
  accountId: string
  accountName: string
  cached: boolean
  rates: RateView[]
}

interface LabelEventView {
  id: string | null
  status: string
  detail: string | null
  occurredAt: string | null
}

interface LabelView {
  id: string
  accountName: string
  provider: string
  carrier: string
  service: string
  trackingNumber: string | null
  trackingStatus: string
  status: string
  amountMinor: string
  currency: string
  labelUrl: string | null
  hasFile: boolean
  costEntryId: string | null
  purchasedAt: string
  voidedAt: string | null
  events: LabelEventView[]
}

function rateBadgeVariant(badge: RateView['badges'][number]): 'success' | 'secondary' | 'default' {
  if (badge === 'cheapest') return 'success'
  if (badge === 'fastest') return 'secondary'
  return 'default'
}

function trackingVariant(status: string): 'success' | 'destructive' | 'warning' | 'secondary' | 'outline' {
  if (status === 'delivered') return 'success'
  if (status === 'exception') return 'destructive'
  if (status === 'in_transit' || status === 'out_for_delivery') return 'warning'
  if (status === 'pre_transit') return 'secondary'
  return 'outline'
}

function labelStatusVariant(status: string): 'success' | 'warning' | 'outline' {
  if (status === 'purchased') return 'success'
  if (status === 'refunded') return 'warning'
  return 'outline'
}

/**
 * The Shipping tab separates rate shopping from purchased labels. Selecting
 * a label keeps its print, refresh, void and tracking evidence together. Live rate shopping with
 * buy. Rating never spends money; buying stamps the carrier, service and
 * tracking number onto the shipment and posts the label cost, so the drawer
 * refreshes behind every purchase and the existing notify flow picks the
 * tracking up. Refusals name the remedy the server gave.
 */
export function ShippingPanel({
  shipmentId,
  draft,
  canBuy,
  accounts,
  presets,
}: {
  shipmentId: string
  draft: boolean
  canBuy: boolean
  accounts: ShippingAccountOption[]
  presets: PackagePresetOption[]
}) {
  const t = useTranslations('fulfillment')
  const locale = useLocale()
  const router = useRouter()
  const { busy, refusal, execute } = useAppAction()
  const [section, setSection] = useState<'labels' | 'rates'>(draft ? 'rates' : 'labels')
  const [selectedLabelId, setSelectedLabelId] = useState<string | null>(null)
  const [labels, setLabels] = useState<LabelView[] | null>(null)
  const [labelsError, setLabelsError] = useState<string | null>(null)
  const [accountId, setAccountId] = useState(() => accounts.find((account) => account.isDefault)?.id ?? '')
  const [presetId, setPresetId] = useState('')
  const [direction, setDirection] = useState<'outbound' | 'return'>('outbound')
  const [quote, setQuote] = useState<QuoteView | null>(null)
  const [buyingRate, setBuyingRate] = useState<string | null>(null)
  const [voidingId, setVoidingId] = useState<string | null>(null)
  const [refreshingId, setRefreshingId] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<{ valid: boolean; messages: string[] } | null>(null)

  const moneyFor = useCallback(
    (currency: string) => createMoneyFormatter(locale, currency),
    [locale],
  )

  const loadLabels = useCallback(async () => {
    const result = await fetchAction<{ labels: LabelView[] }>(
      `/api/shipping/labels?shipmentId=${encodeURIComponent(shipmentId)}`,
      { cache: 'no-store' },
    )
    if (!result.ok) {
      setLabelsError(result.error.displayMessage(t('shipping.fail.labels')))
      setLabels([])
      return
    }
    setLabelsError(null)
    setLabels(result.data.labels)
  }, [shipmentId, t])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadLabels(), 0)
    return () => window.clearTimeout(timer)
  }, [loadLabels])

  const defaultAccount = useMemo(
    () => accounts.find((account) => account.isDefault) ?? accounts[0] ?? null,
    [accounts],
  )
  const defaultPreset = useMemo(
    () => presets[0] ?? null,
    [presets],
  )

  async function getRates() {
    setQuote(null)
    await execute(
      () =>
        fetchAction<{ quote: QuoteView }>('/api/shipping/rates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shipmentId,
            ...(accountId ? { accountId } : {}),
            ...(presetId ? { presetId } : {}),
            direction,
          }),
        }),
      {
        fallbackMessage: t('shipping.fail.rates'),
        onOk: (result) => setQuote(result.quote),
      },
    )
  }

  async function buyLabel(rate: RateView) {
    if (!canBuy) return
    const confirmed = await confirmDialog({
      title: t('shipping.buyTitle', { carrier: rate.carrier, service: rate.service }),
      message: t('shipping.buyConfirm', {
        amount: moneyFor(rate.currency).money(rate.amount, { currency: rate.currency }),
        carrier: rate.carrier,
        service: rate.service,
      }),
      confirmLabel: t('shipping.buy'),
    })
    if (!confirmed) return
    setBuyingRate(rate.providerRateId)
    try {
      await execute(
        () =>
          fetchAction('/api/shipping/labels', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              shipmentId,
              providerRateId: rate.providerRateId,
              ...(accountId ? { accountId } : {}),
              direction,
            }),
          }),
        {
          fallbackMessage: t('shipping.fail.buy'),
          successMessage: t('shipping.bought', { carrier: rate.carrier }),
          onOk: () => {
            setQuote(null)
            setSection('labels')
            setSelectedLabelId(null)
            void loadLabels()
            router.refresh()
          },
        },
      )
    } finally {
      setBuyingRate(null)
    }
  }

  async function voidLabel(label: LabelView) {
    if (!canBuy) return
    const reason = await promptDialog({
      title: t('shipping.voidTitle', { carrier: label.carrier }),
      label: t('shipping.voidLabel'),
      placeholder: t('shipping.voidPlaceholder'),
      confirmLabel: t('shipping.void'),
    })
    if (!reason) return
    setVoidingId(label.id)
    try {
      await execute(
        () =>
          fetchAction(`/api/shipping/labels/${encodeURIComponent(label.id)}/void`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason }),
          }),
        {
          fallbackMessage: t('shipping.fail.void'),
          successMessage: t('shipping.voided', { carrier: label.carrier }),
          onOk: () => {
            void loadLabels()
            router.refresh()
          },
        },
      )
    } finally {
      setVoidingId(null)
    }
  }

  async function refreshTracking(label: LabelView) {
    setRefreshingId(label.id)
    try {
      await execute(
        () =>
          fetchAction(`/api/shipping/labels/${encodeURIComponent(label.id)}/tracking`, { method: 'POST' }),
        {
          fallbackMessage: t('shipping.fail.tracking'),
          successMessage: t('shipping.refreshed'),
          onOk: () => void loadLabels(),
        },
      )
    } finally {
      setRefreshingId(null)
    }
  }

  async function validateAddress() {
    setValidating(true)
    setValidation(null)
    try {
      const res = await fetch('/api/shipping/validate-address', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shipmentId, ...(accountId ? { accountId } : {}) }),
      })
      if (!res.ok) {
        setValidation({ valid: false, messages: [await readApiErrorMessage(res, t('shipping.fail.validation'))] })
        return
      }
      const body = (await res.json()) as { validation: { valid: boolean; messages: string[] } }
      setValidation(body.validation)
    } finally {
      setValidating(false)
    }
  }

  const selectedLabel = labels?.find((label) => label.id === selectedLabelId) ?? labels?.[0] ?? null

  return (
    <div className="space-y-6 p-1">
      <ActionAlert error={refusal} fallbackMessage={t('actionFailed')} />
      {labelsError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {labelsError}
        </p>
      ) : null}

      {draft ? (
        <DrawerTabStrip
          tabs={[{ key: 'rates', label: t('shipping.ratesTitle') }, { key: 'labels', label: t('shipping.labelsTitle'), count: labels?.length }]}
          activeKey={section}
          onSelect={setSection}
          ariaLabel={t('shipping.labelsTitle')}
        />
      ) : null}
      {section === 'labels' || !draft ? <section aria-label={t('shipping.labelsTitle')} className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('shipping.labelsTitle')}</h3>
        {labels === null ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('shipping.loading')}</p>
        ) : labels.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-300">{t('shipping.labelsEmpty')}</p>
        ) : (
          <>
          {labels.length > 1 ? (
            <SearchSelect
              ariaLabel={t('shipping.labelsTitle')}
              value={selectedLabel?.id ?? ''}
              onChange={setSelectedLabelId}
              options={labels.map((label) => ({ value: label.id, label: `${label.carrier} · ${label.service}${label.trackingNumber ? ` · ${label.trackingNumber}` : ''}` }))}
            />
          ) : null}
          {selectedLabel ? (() => {
            const label = selectedLabel
            const major = minorToMajor(label.amountMinor, label.currency)
            return (
              <article key={label.id} className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {label.carrier} · {label.service}
                  </span>
                  <Badge variant={labelStatusVariant(label.status)}>{t(`shipping.status.${label.status}`)}</Badge>
                  <Badge variant={trackingVariant(label.trackingStatus)}>{t(`shipping.tracking.${label.trackingStatus}`)}</Badge>
                  <span className="ml-auto text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">
                    {major === null ? label.amountMinor : moneyFor(label.currency).money(major, { currency: label.currency })}
                  </span>
                </div>
                {label.trackingNumber ? (
                  <p className="font-mono text-sm text-slate-600 dark:text-slate-300">{label.trackingNumber}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {label.hasFile ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/api/shipping/labels/${encodeURIComponent(label.id)}/file`}>{t('shipping.print')}</a>
                    </Button>
                  ) : label.labelUrl ? (
                    <Button variant="outline" size="sm" asChild>
                      <a href={label.labelUrl} target="_blank" rel="noopener noreferrer">{t('shipping.print')}</a>
                    </Button>
                  ) : null}
                  <Button variant="outline" size="sm" disabled={busy || refreshingId === label.id} onClick={() => void refreshTracking(label)}>
                    {t('shipping.refresh')}
                  </Button>
                  {label.status === 'purchased' && canBuy ? (
                    <Button variant="ghost" size="sm" disabled={busy || voidingId === label.id} onClick={() => void voidLabel(label)} className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40">
                      {t('shipping.void')}
                    </Button>
                  ) : null}
                </div>
                {label.events.length > 0 ? (
                  <ol className="space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
                    {label.events.slice(0, 8).map((event, index) => (
                      <li key={event.id ?? `${label.id}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <Badge variant="outline">{event.status}</Badge>
                        {event.detail ? <span className="text-slate-600 dark:text-slate-300">{event.detail}</span> : null}
                        {event.occurredAt ? (
                          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">{event.occurredAt}</span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </article>
            )
          })() : null}
          </>
        )}
      </section> : null}

      {draft && section === 'rates' ? (
        <section aria-label={t('shipping.ratesTitle')} className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('shipping.ratesTitle')}</h3>
          {accounts.length === 0 ? (
            <EmptyState
              title={t('shipping.noAccountsTitle')}
              description={t('shipping.noAccounts')}
              action={<Button asChild><Link href="/admin/setup/shipping">{t('shipping.setupLink')}</Link></Button>}
            />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label htmlFor="shipping-rate-account">{t('shipping.rateAccount')}</Label>
                  <Select id="shipping-rate-account" value={accountId} onChange={(event) => { setAccountId(event.target.value); setQuote(null); setValidation(null) }}>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name} · {account.provider === 'shippo' ? 'Shippo' : 'EasyPost'} · {account.mode === 'live' ? t('shipping.modeLive') : t('shipping.modeTest')}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shipping-rate-package">{t('shipping.ratePackage')}</Label>
                  <Select id="shipping-rate-package" value={presetId} onChange={(event) => { setPresetId(event.target.value); setQuote(null); setValidation(null) }}>
                    <option value="">{t('shipping.ratePackageAuto')}</option>
                    {presets.map((preset) => (
                      <option key={preset.id} value={preset.id}>{preset.name}</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shipping-rate-direction">{t('shipping.rateDirection')}</Label>
                  <Select id="shipping-rate-direction" value={direction} onChange={(event) => { setDirection(event.target.value as 'outbound' | 'return'); setQuote(null); setValidation(null) }}>
                    <option value="outbound">{t('shipping.direction.outbound')}</option>
                    <option value="return">{t('shipping.direction.return')}</option>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => void getRates()}>{t('shipping.getRates')}</Button>
                <Button variant="outline" disabled={busy || validating} onClick={() => void validateAddress()}>{t('shipping.checkAddress')}</Button>
              </div>
              {validation ? (
                <div role="status" className={validation.valid
                  ? 'rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                  : 'rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'}>
                  <p className="font-medium">{t(validation.valid ? 'shipping.validationValid' : 'shipping.validationIssues')}</p>
                  {validation.messages.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5">
                      {validation.messages.map((message, index) => <li key={index}>{message}</li>)}
                    </ul>
                  ) : null}
                  {!validation.valid ? <p className="mt-1">{t('shipping.addressUnchanged')}</p> : null}
                </div>
              ) : null}
              {!canBuy ? <p className="text-sm text-slate-500 dark:text-slate-400">{t('shipping.noBuyGrant')}</p> : null}
              {quote ? (
                quote.rates.length === 0 ? (
                  <EmptyState title={t('shipping.noRatesTitle')} description={t('shipping.noRates')} />
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      {t('shipping.rateFor', { count: quote.rates.length, account: quote.accountName })}
                    </p>
                    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('shipping.colRate')}</TableHead>
                            <TableHead>{t('shipping.colDelivery')}</TableHead>
                            <TableHead className="text-right">{t('shipping.colPrice')}</TableHead>
                            <TableHead><span className="sr-only">{t('shipping.buy')}</span></TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {quote.rates.map((rate) => (
                            <TableRow key={rate.providerRateId}>
                              <TableCell>
                                <span className="font-medium">{rate.carrier}</span>
                                <span className="text-slate-500 dark:text-slate-400"> · {rate.service}</span>
                                <span className="mt-1 flex flex-wrap gap-1">
                                  {rate.badges.map((badge) => (
                                    <Badge key={badge} variant={rateBadgeVariant(badge)}>{t(`shipping.badges.${badge}`)}</Badge>
                                  ))}
                                </span>
                              </TableCell>
                              <TableCell>
                                {rate.deliveryDate ?? (rate.deliveryDays === null ? '—' : t('shipping.deliveryDays', { count: rate.deliveryDays }))}
                              </TableCell>
                              <TableCell className="text-right font-medium tabular-nums">
                                {moneyFor(rate.currency).money(rate.amount, { currency: rate.currency })}
                              </TableCell>
                              <TableCell>
                                <Button size="sm" disabled={!canBuy || busy || buyingRate === rate.providerRateId} onClick={() => void buyLabel(rate)}>
                                  {t('shipping.buy')}
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{t('shipping.costNote')}</p>
                  </div>
                )
              ) : null}
            </>
          )}
        </section>
      ) : null}

      <DisclosureSection
        title={t('shipping.advancedTitle')}
        summary={t('shipping.advancedSummary')}
        forceOpen={defaultAccount === null}
      >
        <div className="space-y-2 pt-1 text-sm text-slate-600 dark:text-slate-300">
          <p>
            {t('shipping.defaultsLine', {
              account: defaultAccount?.name ?? t('shipping.noDefault'),
              preset: defaultPreset?.name ?? t('shipping.noDefault'),
            })}
          </p>
          <p>
            <Link href="/admin/setup/shipping" className="font-medium underline">{t('shipping.setupLink')}</Link>
          </p>
        </div>
      </DisclosureSection>
    </div>
  )
}
