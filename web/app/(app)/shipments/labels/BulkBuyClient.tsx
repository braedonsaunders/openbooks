'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Label,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { RecordTabs } from '@/components/module-home/record-tabs'
import { useAppAction } from '@/lib/use-app-action'
import { createMoneyFormatter } from '@/lib/money-format'
import type { ShippingAccountOption } from '../../_fulfillment/types'
import { addExact } from '../_fulfillment/shipping-display'

interface CandidateView {
  shipmentId: string
  documentNumber: string
  customerName: string | null
  promisedDate: string | null
  labelCount: number
}

type PreviewRowView =
  | {
      shipmentId: string
      documentNumber: string
      ok: true
      providerRateId: string
      carrier: string
      service: string
      amount: string
      currency: string
      deliveryDate: string | null
    }
  | {
      shipmentId: string
      documentNumber: string | null
      ok: false
      code: string
      message: string
      remedy?: string
    }

type BuyRowView =
  | { shipmentId: string; ok: true; labelId: string; trackingNumber: string | null; duplicate: boolean }
  | { shipmentId: string; ok: false; code: string; message: string; remedy?: string }

type Rule = 'cheapest' | 'fastest' | 'cheapest_by_date'

/**
 * Bulk label buying: draft shipments without a label, a buying rule, a
 * priced preview with every failure named beside its fix, then one buy for
 * the ready rows with a merged PDF for the printer. Preview rates; buying
 * spends carrier money, so the buy step stays behind the shipping grant.
 */
export function BulkBuyClient({
  accounts,
  canBuy,
}: {
  accounts: ShippingAccountOption[]
  canBuy: boolean
}) {
  const t = useTranslations('fulfillment')
  const locale = useLocale()
  const { busy, refusal, execute, refuse } = useAppAction()
  const [activeTab, setActiveTab] = useState<'shipments' | 'rates' | 'labels'>('shipments')
  const [candidates, setCandidates] = useState<CandidateView[] | null>(null)
  const [candidatesError, setCandidatesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [accountId, setAccountId] = useState(() => accounts.find((account) => account.isDefault)?.id ?? '')
  const [rule, setRule] = useState<Rule>('cheapest')
  const [promisedDate, setPromisedDate] = useState('')
  const [preview, setPreview] = useState<PreviewRowView[] | null>(null)
  const [bought, setBought] = useState<BuyRowView[] | null>(null)
  const [merged, setMerged] = useState<{ pages: number; pdfBase64: string } | null>(null)

  const moneyFor = useCallback((currency: string) => createMoneyFormatter(locale, currency), [locale])

  const loadCandidates = useCallback(async (keepPurchase = false) => {
    const result = await fetchAction<{ candidates: CandidateView[] }>('/api/shipping/bulk', { cache: 'no-store' })
    if (!result.ok) {
      setCandidatesError(result.error.displayMessage(t('shipping.bulk.fail.candidates')))
      setCandidates([])
      return
    }
    setCandidatesError(null)
    setCandidates(result.data.candidates)
    setSelected(new Set(result.data.candidates.map((candidate) => candidate.shipmentId)))
    setPreview(null)
    if (!keepPurchase) {
      setBought(null)
      setMerged(null)
      setActiveTab('shipments')
    }
  }, [t])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadCandidates(), 0)
    return () => window.clearTimeout(timer)
  }, [loadCandidates])

  function invalidatePreview() {
    setPreview(null)
    setBought(null)
    setMerged(null)
    setActiveTab('shipments')
  }

  function toggle(shipmentId: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(shipmentId)) next.delete(shipmentId)
      else next.add(shipmentId)
      return next
    })
    setPreview(null)
    setBought(null)
    setMerged(null)
  }

  function toggleAll() {
    if (!candidates) return
    setSelected((current) =>
      current.size === candidates.length ? new Set() : new Set(candidates.map((candidate) => candidate.shipmentId)),
    )
    setPreview(null)
    setBought(null)
    setMerged(null)
  }

  const readyRows = useMemo(() => (preview ?? []).filter((row) => row.ok), [preview])
  const failedRows = useMemo(() => (preview ?? []).filter((row) => !row.ok), [preview])

  const totals = useMemo(() => {
    const sums = new Map<string, string>()
    for (const row of readyRows) {
      if (!row.ok) continue
      const running = sums.get(row.currency) ?? '0'
      const next = addExact(running, row.amount)
      if (next !== null) sums.set(row.currency, next)
    }
    return [...sums.entries()]
  }, [readyRows])

  async function previewRates() {
    if (selected.size === 0) {
      refuse(null, t('shipping.bulk.fail.nothingSelected'))
      return
    }
    if (rule === 'cheapest_by_date' && !promisedDate) {
      refuse(null, t('shipping.bulk.fail.dateRequired'))
      return
    }
    setBought(null)
    setMerged(null)
    await execute(
      () =>
        fetchAction<{ rows: PreviewRowView[] }>('/api/shipping/bulk', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shipmentIds: [...selected],
            ...(accountId ? { accountId } : {}),
            rule,
            ...(rule === 'cheapest_by_date' ? { promisedDate } : {}),
          }),
        }),
      {
        fallbackMessage: t('shipping.bulk.fail.preview'),
        onOk: (result) => { setPreview(result.rows); setActiveTab('rates') },
      },
    )
  }

  async function buyReady() {
    if (!canBuy || readyRows.length === 0) return
    await execute(
      () =>
        fetchAction<{ rows: BuyRowView[]; merged: { pages: number; pdfBase64: string } | null }>('/api/shipping/bulk/buy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(accountId ? { accountId } : {}),
            items: readyRows.filter((row) => row.ok).map((row) => ({
              shipmentId: row.shipmentId,
              providerRateId: row.providerRateId,
            })),
          }),
        }),
      {
        fallbackMessage: t('shipping.bulk.fail.buy'),
        successMessage: t('shipping.bulk.bought'),
        onOk: (result) => {
          setBought(result.rows)
          setMerged(result.merged)
          setActiveTab('labels')
          void loadCandidates(true)
        },
      },
    )
  }

  return (
    <div className="space-y-6">
      <ActionAlert error={refusal} fallbackMessage={t('actionFailed')} />
      {candidatesError ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {candidatesError}
        </p>
      ) : null}

      <RecordTabs
        label={t('shipping.bulk.preview')}
        active={activeTab}
        onChange={setActiveTab}
        tabs={[
          { key: 'shipments', label: t('shipping.bulk.tabs.shipments') },
          { key: 'rates', label: t('shipping.bulk.tabs.rates'), disabled: preview === null },
          { key: 'labels', label: t('shipping.bulk.tabs.labels'), disabled: bought === null },
        ]}
      >
        {activeTab === 'shipments' ? <>
      {candidates === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('shipping.bulk.loading')}</p>
      ) : candidates.length === 0 ? (
        <EmptyState
          title={t('shipping.bulk.emptyTitle')}
          description={t('shipping.bulk.emptyDescription')}
          action={<Button asChild><Link href="/shipments">{t('shipping.bulk.backToShipments')}</Link></Button>}
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="bulk-account">{t('shipping.rateAccount')}</Label>
              <Select id="bulk-account" value={accountId} onChange={(event) => { setAccountId(event.target.value); invalidatePreview() }}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.provider === 'shippo' ? 'Shippo' : 'EasyPost'}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bulk-rule">{t('shipping.bulk.rule')}</Label>
              <Select id="bulk-rule" value={rule} onChange={(event) => { setRule(event.target.value as Rule); invalidatePreview() }}>
                <option value="cheapest">{t('shipping.bulk.rules.cheapest')}</option>
                <option value="fastest">{t('shipping.bulk.rules.fastest')}</option>
                <option value="cheapest_by_date">{t('shipping.bulk.rules.cheapest_by_date')}</option>
              </Select>
            </div>
            {rule === 'cheapest_by_date' ? (
              <div className="space-y-1.5">
                <Label htmlFor="bulk-date">{t('shipping.bulk.promisedDate')}</Label>
                <Input id="bulk-date" type="date" value={promisedDate} onChange={(event) => { setPromisedDate(event.target.value); invalidatePreview() }} />
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Button disabled={busy || selected.size === 0} onClick={() => void previewRates()}>
                {t('shipping.bulk.preview')}
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label={t('shipping.bulk.selectAll')}
                      checked={selected.size === candidates.length && candidates.length > 0}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                  </TableHead>
                  <TableHead>{t('shipping.bulk.colShipment')}</TableHead>
                  <TableHead>{t('shipping.bulk.colCustomer')}</TableHead>
                  <TableHead>{t('shipping.bulk.colPromised')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((candidate) => (
                  <TableRow key={candidate.shipmentId}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={candidate.documentNumber}
                        checked={selected.has(candidate.shipmentId)}
                        onChange={() => toggle(candidate.shipmentId)}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                    </TableCell>
                    <TableCell className="font-mono">{candidate.documentNumber}</TableCell>
                    <TableCell>{candidate.customerName ?? '—'}</TableCell>
                    <TableCell>{candidate.promisedDate ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

        </>
      )}
        </> : null}
          {activeTab === 'rates' && preview ? (
            <section aria-label={t('shipping.bulk.previewTitle')} className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t('shipping.bulk.previewTitle', { ready: readyRows.length, failed: failedRows.length })}
              </h3>
              {totals.length > 0 ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {t('shipping.bulk.totalLabel')}{' '}
                  {totals.map(([currency, total]) => moneyFor(currency).money(total, { currency })).join(' · ')}
                </p>
              ) : null}
              {readyRows.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('shipping.bulk.colShipment')}</TableHead>
                        <TableHead>{t('shipping.colRate')}</TableHead>
                        <TableHead>{t('shipping.colDelivery')}</TableHead>
                        <TableHead className="text-right">{t('shipping.colPrice')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {readyRows.map((row) =>
                        row.ok ? (
                          <TableRow key={row.shipmentId}>
                            <TableCell className="font-mono">{row.documentNumber}</TableCell>
                            <TableCell>{row.carrier} · {row.service}</TableCell>
                            <TableCell>{row.deliveryDate ?? '—'}</TableCell>
                            <TableCell className="text-right font-medium tabular-nums">
                              {moneyFor(row.currency).money(row.amount, { currency: row.currency })}
                            </TableCell>
                          </TableRow>
                        ) : null,
                      )}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
              {failedRows.length > 0 ? (
                <ul className="space-y-2">
                  {failedRows.map((row) =>
                    !row.ok ? (
                      <li key={row.shipmentId} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                        <span className="font-medium">{row.documentNumber ?? row.shipmentId}</span>
                        {' — '}{row.message}
                        {row.remedy ? <> {row.remedy}</> : null}{' '}
                        <Link href={`/shipments?shipment=${encodeURIComponent(row.shipmentId)}`} className="font-medium underline">
                          {t('shipping.bulk.openShipment')}
                        </Link>
                      </li>
                    ) : null,
                  )}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button disabled={!canBuy || busy || readyRows.length === 0} onClick={() => void buyReady()}>
                  {t('shipping.bulk.buy')}
                </Button>
                {!canBuy ? <span className="text-sm text-slate-500 dark:text-slate-400">{t('shipping.noBuyGrant')}</span> : null}
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('shipping.costNote')}</p>
            </section>
          ) : null}

          {activeTab === 'labels' && bought ? (
            <section aria-label={t('shipping.bulk.resultTitle')} className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('shipping.bulk.resultTitle')}</h3>
              {merged ? (
                <Button asChild>
                  <a href={`data:application/pdf;base64,${merged.pdfBase64}`} download="shipping-labels.pdf">
                    {t('shipping.bulk.printMerged')}
                  </a>
                </Button>
              ) : null}
              <ul className="space-y-2">
                {bought.map((row) =>
                  row.ok ? (
                    <li key={row.shipmentId} className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                      <Badge variant="success">{t('shipping.bulk.boughtOne')}</Badge>
                      <span className="font-mono">{row.trackingNumber ?? row.labelId}</span>
                      {row.duplicate ? <span>{t('shipping.bulk.duplicate')}</span> : null}
                    </li>
                  ) : (
                    <li key={row.shipmentId} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                      <span className="font-mono">{row.shipmentId}</span>{' — '}{row.message}
                      {row.remedy ? <> {row.remedy}</> : null}
                    </li>
                  ),
                )}
              </ul>
            </section>
          ) : null}
      </RecordTabs>
    </div>
  )
}
