'use client'

import { useBusinessToday } from '@/components/business-date-provider'
import { useMoney } from '@/components/money-provider'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { LineGrid, type LineGridColumn } from '../../../components/line-grid'
import { PagedTable } from '../../../components/paged-table'

export interface Tier extends Record<string, unknown> {
  unitCode: string
  unitName: string
  baseQuantity: string
  costRate: string
  billRate: string
  timeTypeBillRates: Record<string, string>
}

interface RateData {
  books: { id: string; code: string; name: string; currency: string; is_default: boolean }[]
  profile: { base_unit: string; pricing_policy: string; invoice_presentation: string } | null
  versions: { id: string; rate_book_id: string; rate_book_name: string; effective_from: string; effective_to: string | null; status: string; tiers: Tier[] }[]
  timeTypes: { id: string; name: string; bill_multiplier: string }[]
}

export function defaultRateTiers(
  itemKind: string,
  itemUnit: string,
  names: { day: string; week: string; month: string },
): Tier[] {
  if (itemKind === 'equipment_charge') {
    return [
      { unitCode: 'day', unitName: names.day, baseQuantity: '1', costRate: '0', billRate: '0', timeTypeBillRates: {} },
      { unitCode: 'week', unitName: names.week, baseQuantity: '4', costRate: '0', billRate: '0', timeTypeBillRates: {} },
      { unitCode: 'month', unitName: names.month, baseQuantity: '12', costRate: '0', billRate: '0', timeTypeBillRates: {} },
    ]
  }
  const unitCode = itemKind === 'labor' ? 'hour' : (itemUnit.trim().toLowerCase() || 'each')
  return [{
    unitCode,
    unitName: itemKind === 'labor' ? 'Hour' : (itemUnit.trim() || 'Each'),
    baseQuantity: '1',
    costRate: '0',
    billRate: '0',
    timeTypeBillRates: {},
  }]
}

function errorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') return payload.error
  return fallback
}

export function ItemRatesEditor({
  itemId,
  itemPrice,
  itemCost,
  itemKind,
  itemUnit,
  canManage,
}: {
  itemId: string
  itemPrice: string
  itemCost: string
  itemKind: string
  itemUnit: string
  canManage: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('items.rates')
  const common = useTranslations('common')
  const today = useBusinessToday()
  const defaults = useMemo(() => defaultRateTiers(itemKind, itemUnit, {
    day: t('defaults.day'), week: t('defaults.week'), month: t('defaults.month'),
  }), [itemKind, itemUnit, t])
  const [data, setData] = useState<RateData | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverError, setServerError] = useState('')
  const [rateBookId, setRateBookId] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [baseUnit, setBaseUnit] = useState(itemKind === 'labor' ? 'hour' : (itemUnit || defaults[0]!.unitCode))
  const [pricingPolicy, setPricingPolicy] = useState('capped_ladder')
  const [invoicePresentation, setInvoicePresentation] = useState('rate_components')
  const [tiers, setTiers] = useState<Tier[]>(defaults)
  const [showPremiums, setShowPremiums] = useState(false)

  // A read-only viewer must never retain an edit form after permissions change.
  useEffect(() => {
    if (!canManage) setEditing(false)
  }, [canManage])

  const load = useCallback(async () => {
    const res = await fetch(`/api/items/${itemId}/rates`)
    if (!res.ok) return
    const next = await res.json() as RateData
    setData(next)
    setRateBookId(next.books.find((book) => book.is_default)?.id ?? next.books[0]?.id ?? '')
    if (next.profile) {
      setBaseUnit(next.profile.base_unit)
      setPricingPolicy(next.profile.pricing_policy)
      setInvoicePresentation(next.profile.invoice_presentation)
    }
  }, [itemId])
  useEffect(() => { void load() }, [load])

  const tierTypes = useMemo(
    () => itemKind === 'labor' && baseUnit === 'hour'
      ? (data?.timeTypes ?? []).filter((type) => Number(type.bill_multiplier) !== 1)
      : [],
    [baseUnit, data?.timeTypes, itemKind],
  )
  const columns = useMemo<LineGridColumn<Tier>[]>(() => [
    { key: 'unitCode', label: t('unitCode'), width: 'minmax(110px,1fr)', type: 'text', required: true },
    { key: 'unitName', label: t('unitName'), width: 'minmax(140px,1.4fr)', type: 'text', required: true },
    { key: 'baseQuantity', label: t('baseQuantity'), width: '120px', type: 'decimal', decimalScale: 4, required: true },
    { key: 'costRate', label: t('costRate'), width: '120px', type: 'amount', required: true },
    { key: 'billRate', label: t('billRate'), width: '120px', type: 'amount', required: true },
    ...(showPremiums ? tierTypes.map<LineGridColumn<Tier>>((type) => ({
      key: `premium_${type.id}`,
      label: type.name,
      help: t('tierOverrides'),
      width: '120px',
      type: 'amount',
    })) : []),
  ], [showPremiums, t, tierTypes])

  function gridRows(): Tier[] {
    return tiers.map((tier) => ({
      ...tier,
      ...Object.fromEntries(tierTypes.map((type) => [`premium_${type.id}`, tier.timeTypeBillRates[type.id] ?? ''])),
    }))
  }

  function updateRows(rows: Tier[]) {
    setTiers(rows.map((row) => ({
      ...row,
      timeTypeBillRates: {
        ...row.timeTypeBillRates,
        ...Object.fromEntries(tierTypes.flatMap((type) => {
          const value = String(row[`premium_${type.id}`] ?? '')
          return value === '' ? [] : [[type.id, value]]
        })),
      },
    })))
  }

  function beginEditing() {
    const latest = data?.versions.find((version) => version.rate_book_id === rateBookId)
    setTiers(latest?.tiers.length ? latest.tiers : defaults)
    setEffectiveFrom(today)
    setServerError('')
    setShowPremiums(false)
    setEditing(true)
  }

  const advancedPricing = data?.profile != null
  const simpleValue = (value: string) => value === '' ? t('notSet') : money(value)

  async function save() {
    setBusy(true)
    setServerError('')
    try {
      const res = await fetch(`/api/items/${itemId}/rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rateBookId: rateBookId || null, effectiveFrom, baseUnit, pricingPolicy, invoicePresentation, tiers }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => null)
        const message = errorMessage(payload, t('saveFailed'))
        setServerError(message)
        toast.error(message)
        return
      }
      toast.success(t('saved'))
      setEditing(false)
      await load()
    } catch {
      const message = common('feedback.saveFailed')
      setServerError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3">
      {data ? (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('guide.title')}</h3>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {advancedPricing ? t('guide.advancedDescription') : t('guide.simpleDescription')}
                </p>
              </div>
              <Badge variant={advancedPricing ? 'success' : 'secondary'}>
                {advancedPricing ? t('guide.advancedMode') : t('guide.simpleMode')}
              </Badge>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('guide.price')}</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{simpleValue(itemPrice)}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('guide.priceHelp')}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('guide.cost')}</p>
                <p className="mt-1 text-base font-semibold tabular-nums text-slate-900 dark:text-slate-100">{simpleValue(itemCost)}</p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('guide.costHelp')}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('guide.advanced')}</p>
                <p className="mt-1 text-base font-semibold text-slate-900 dark:text-slate-100">
                  {advancedPricing ? t('guide.configured', { unit: data.profile?.base_unit ?? '—' }) : t('guide.notConfigured')}
                </p>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {advancedPricing ? t('guide.advancedHelp') : t('guide.simpleHelp')}
                </p>
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
              <p className="font-medium text-slate-800 dark:text-slate-100">{t('guide.resolutionTitle')}</p>
              <p className="mt-1">{advancedPricing ? t('guide.advancedResolution') : t('guide.simpleResolution')}</p>
              <p className="mt-2">{t('guide.rateTypes')}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/docs/item-rates" className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{t('documentation')}</Link>
          {canManage && !editing ? <Button variant="outline" size="sm" onClick={beginEditing}>{advancedPricing ? t('newVersion') : t('configure')}</Button> : null}
        </div>
      </div>

      {editing ? (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1"><Label>{t('rateBook')}</Label><Select value={rateBookId} onChange={(event) => setRateBookId(event.target.value)}>
                <option value="">{t('standardBook')}</option>{data?.books.map((book) => <option key={book.id} value={book.id}>{book.name} · {book.currency}</option>)}
              </Select></div>
              <div className="space-y-1"><Label>{t('effectiveFrom')}</Label><Input type="date" value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} /></div>
              <div className="space-y-1"><Label>{t('baseUnit')}</Label><Input value={baseUnit} onChange={(event) => setBaseUnit(event.target.value)} /></div>
              <div className="space-y-1"><Label>{t('policy')}</Label><Select value={pricingPolicy} onChange={(event) => setPricingPolicy(event.target.value)}>
                <option value="capped_ladder">{t('policies.capped_ladder')}</option><option value="lowest_cost">{t('policies.lowest_cost')}</option>
              </Select></div>
              <div className="space-y-1"><Label>{t('presentation')}</Label><Select value={invoicePresentation} onChange={(event) => setInvoicePresentation(event.target.value)}>
                <option value="rate_components">{t('presentations.rate_components')}</option><option value="summary">{t('presentations.summary')}</option>
              </Select></div>
            </div>

            <LineGrid<Tier>
              columns={columns}
              rows={gridRows()}
              onRowsChange={updateRows}
              emptyRow={() => ({ unitCode: '', unitName: '', baseQuantity: '1', costRate: '0', billRate: '0', timeTypeBillRates: {} })}
              minRows={1}
              addLabel={t('addUnit')}
            />

            {tierTypes.length > 0 ? (
              <button type="button" onClick={() => setShowPremiums((shown) => !shown)} className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">
                {showPremiums ? t('tierOverridesHide') : t('tierOverrides')}
              </button>
            ) : null}
            {serverError ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{serverError}</p> : null}
            <div className="flex gap-2">
              <Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
              <Button variant="outline" onClick={() => setEditing(false)}>{common('actions.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <PagedTable
        rows={data?.versions ?? []}
        rowKey={(version) => version.id}
        searchable
        empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>}
        columns={[
          { key: 'book', header: t('rateBook'), cell: (version) => version.rate_book_name, search: (version) => version.rate_book_name },
          { key: 'from', header: t('effectiveFrom'), cell: (version) => version.effective_from },
          { key: 'to', header: t('effectiveTo'), cell: (version) => version.effective_to ?? '—' },
          { key: 'status', header: common('labels.status'), cell: (version) => <Badge variant={version.status === 'active' ? 'success' : 'secondary'}>{version.status}</Badge> },
          { key: 'rates', header: t('rates'), cell: (version) => version.tiers.map((tier) => `${tier.unitName}: ${money(tier.billRate)}`).join(' · ') },
        ]}
      />
    </section>
  )
}
