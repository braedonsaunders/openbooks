'use client'

import { useBusinessToday } from '@/components/business-date-provider'
import { useMoney } from '@/components/money-provider'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../components/paged-table'
interface Tier { unitCode: string; unitName: string; baseQuantity: string; costRate: string; billRate: string; timeTypeBillRates: Record<string, string> }
interface RateData {
  books: { id: string; code: string; name: string; currency: string; is_default: boolean }[]
  profile: { base_unit: string; pricing_policy: string; invoice_presentation: string } | null
  versions: { id: string; rate_book_id: string; rate_book_name: string; effective_from: string; effective_to: string | null; status: string; tiers: any[] }[]
  timeTypes: { id: string; name: string; bill_multiplier: string }[]
}

export function ItemRatesEditor({
  itemId,
  itemPrice,
  itemCost,
  canManage,
}: {
  itemId: string
  itemPrice: string
  itemCost: string
  canManage: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('items.rates')
  const common = useTranslations('common')
  const [data, setData] = useState<RateData | null>(null)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!canManage) setEditing(false)
  }, [canManage])
  const [busy, setBusy] = useState(false)
  const [rateBookId, setRateBookId] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(useBusinessToday())
  const [baseUnit, setBaseUnit] = useState('day')
  const [pricingPolicy, setPricingPolicy] = useState('capped_ladder')
  const [invoicePresentation, setInvoicePresentation] = useState('rate_components')
  const [tiers, setTiers] = useState<Tier[]>([
    { unitCode: 'day', unitName: t('defaults.day'), baseQuantity: '1', costRate: '0', billRate: '0', timeTypeBillRates: {} },
    { unitCode: 'week', unitName: t('defaults.week'), baseQuantity: '4', costRate: '0', billRate: '0', timeTypeBillRates: {} },
    { unitCode: 'month', unitName: t('defaults.month'), baseQuantity: '12', costRate: '0', billRate: '0', timeTypeBillRates: {} },
  ])

  async function load() {
    const res = await fetch(`/api/items/${itemId}/rates`)
    if (!res.ok) return
    const next = await res.json() as RateData
    setData(next)
    setRateBookId(next.books.find((b) => b.is_default)?.id ?? next.books[0]?.id ?? '')
    if (next.profile) {
      setBaseUnit(next.profile.base_unit)
      setPricingPolicy(next.profile.pricing_policy)
      setInvoicePresentation(next.profile.invoice_presentation)
    }
  }
  useEffect(() => { void load() }, [itemId])

  function updateTier(index: number, key: keyof Tier, value: string) {
    setTiers((rows) => rows.map((row, i) => i === index ? { ...row, [key]: value } : row))
  }

  function updateTierTypeRate(index: number, timeTypeId: string, value: string) {
    setTiers((rows) => rows.map((row, i) => {
      if (i !== index) return row
      const next = { ...row.timeTypeBillRates }
      if (value === '') delete next[timeTypeId]
      else next[timeTypeId] = value
      return { ...row, timeTypeBillRates: next }
    }))
  }

  // Time-type tiers only make sense on hourly/labor lines.
  const tierTypes = (data?.timeTypes ?? []).filter((x) => Number(x.bill_multiplier) !== 1)
  const advancedPricing = data?.profile != null
  const simpleValue = (value: string) => value === '' ? t('notSet') : money(value)

  async function save() {
    setBusy(true)
    const res = await fetch(`/api/items/${itemId}/rates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rateBookId: rateBookId || null, effectiveFrom, baseUnit, pricingPolicy, invoicePresentation, tiers }),
    })
    const result = await res.json()
    if (!res.ok) toast.error(result.error ?? t('saveFailed'))
    else {
      toast.success(t('saved'))
      setEditing(false)
      await load()
    }
    setBusy(false)
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
          {canManage && !editing ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{advancedPricing ? t('newVersion') : t('configure')}</Button> : null}
        </div>
      </div>
      {editing ? (
        <Card><CardContent className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1"><Label>{t('rateBook')}</Label><Select value={rateBookId} onChange={(e) => setRateBookId(e.target.value)}>
              <option value="">{t('standardBook')}</option>{data?.books.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.currency}</option>)}
            </Select></div>
            <div className="space-y-1"><Label>{t('effectiveFrom')}</Label><Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} /></div>
            <div className="space-y-1"><Label>{t('baseUnit')}</Label><Input value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} /></div>
            <div className="space-y-1"><Label>{t('policy')}</Label><Select value={pricingPolicy} onChange={(e) => setPricingPolicy(e.target.value)}>
              <option value="capped_ladder">{t('policies.capped_ladder')}</option><option value="lowest_cost">{t('policies.lowest_cost')}</option>
            </Select></div>
            <div className="space-y-1"><Label>{t('presentation')}</Label><Select value={invoicePresentation} onChange={(e) => setInvoicePresentation(e.target.value)}>
              <option value="rate_components">{t('presentations.rate_components')}</option><option value="summary">{t('presentations.summary')}</option>
            </Select></div>
          </div>
          <div className="space-y-2">
            {tiers.map((tier, index) => <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-6">
              <Input aria-label={t('unitCode')} value={tier.unitCode} onChange={(e) => updateTier(index, 'unitCode', e.target.value)} placeholder={t('unitCode')} />
              <Input aria-label={t('unitName')} value={tier.unitName} onChange={(e) => updateTier(index, 'unitName', e.target.value)} placeholder={t('unitName')} />
              <Input aria-label={t('baseQuantity')} inputMode="decimal" className="text-right tabular-nums" value={tier.baseQuantity} onChange={(e) => updateTier(index, 'baseQuantity', e.target.value)} placeholder={t('baseQuantity')} />
              <Input aria-label={t('costRate')} inputMode="decimal" className="text-right tabular-nums" value={tier.costRate} onChange={(e) => updateTier(index, 'costRate', e.target.value)} placeholder={t('costRate')} />
              <Input aria-label={t('billRate')} inputMode="decimal" className="text-right tabular-nums" value={tier.billRate} onChange={(e) => updateTier(index, 'billRate', e.target.value)} placeholder={t('billRate')} />
              <Button variant="ghost" onClick={() => setTiers((rows) => rows.filter((_, i) => i !== index))}>{common('actions.remove')}</Button>
              {tierTypes.length > 0 ? <div className="flex flex-wrap items-center gap-2 sm:col-span-6">
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('tierOverrides')}</span>
                {tierTypes.map((tt) => <div key={tt.id} className="flex items-center gap-1">
                  <span className="text-xs text-slate-600 dark:text-slate-300">{tt.name}</span>
                  <Input aria-label={tt.name} inputMode="decimal" className="h-8 w-24 text-right tabular-nums" value={tier.timeTypeBillRates[tt.id] ?? ''}
                    placeholder={tier.billRate ? (Number(tier.billRate) * Number(tt.bill_multiplier)).toFixed(2) : t('tierAuto')}
                    onChange={(e) => updateTierTypeRate(index, tt.id, e.target.value)} />
                </div>)}
              </div> : null}
            </div>)}
            <Button variant="outline" size="sm" onClick={() => setTiers((rows) => [...rows, { unitCode: '', unitName: '', baseQuantity: '1', costRate: '0', billRate: '0', timeTypeBillRates: {} }])}>{t('addUnit')}</Button>
          </div>
          <div className="flex gap-2"><Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button><Button variant="outline" onClick={() => setEditing(false)}>{common('actions.cancel')}</Button></div>
        </CardContent></Card>
      ) : null}
      <PagedTable
        rows={data?.versions ?? []} rowKey={(v) => v.id} searchable
        empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>}
        columns={[
          { key: 'book', header: t('rateBook'), cell: (v) => v.rate_book_name, search: (v) => v.rate_book_name },
          { key: 'from', header: t('effectiveFrom'), cell: (v) => v.effective_from },
          { key: 'to', header: t('effectiveTo'), cell: (v) => v.effective_to ?? '—' },
          { key: 'status', header: common('labels.status'), cell: (v) => <Badge variant={v.status === 'active' ? 'success' : 'secondary'}>{v.status}</Badge> },
          { key: 'rates', header: t('rates'), cell: (v) => v.tiers.map((x) => `${x.unitName}: ${money(x.billRate)}`).join(' · ') },
        ]}
      />
    </section>
  )
}
