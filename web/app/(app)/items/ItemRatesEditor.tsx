'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../components/paged-table'
import { money } from '../../../lib/format'

interface Tier { unitCode: string; unitName: string; baseQuantity: string; costRate: string; billRate: string }
interface RateData {
  books: { id: string; code: string; name: string; currency: string; is_default: boolean }[]
  profile: { base_unit: string; pricing_policy: string; invoice_presentation: string } | null
  versions: { id: string; rate_book_id: string; rate_book_name: string; effective_from: string; effective_to: string | null; status: string; tiers: any[] }[]
}

export function ItemRatesEditor({ itemId, canManage }: { itemId: string; canManage: boolean }) {
  const t = useTranslations('items.rates')
  const common = useTranslations('common')
  const [data, setData] = useState<RateData | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [rateBookId, setRateBookId] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10))
  const [baseUnit, setBaseUnit] = useState('day')
  const [pricingPolicy, setPricingPolicy] = useState('capped_ladder')
  const [invoicePresentation, setInvoicePresentation] = useState('rate_components')
  const [tiers, setTiers] = useState<Tier[]>([
    { unitCode: 'day', unitName: t('defaults.day'), baseQuantity: '1', costRate: '0', billRate: '0' },
    { unitCode: 'week', unitName: t('defaults.week'), baseQuantity: '4', costRate: '0', billRate: '0' },
    { unitCode: 'month', unitName: t('defaults.month'), baseQuantity: '12', costRate: '0', billRate: '0' },
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/docs/item-rates" className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{t('documentation')}</Link>
          {canManage && !editing ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('newVersion')}</Button> : null}
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
            </div>)}
            <Button variant="outline" size="sm" onClick={() => setTiers((rows) => [...rows, { unitCode: '', unitName: '', baseQuantity: '1', costRate: '0', billRate: '0' }])}>{t('addUnit')}</Button>
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
          { key: 'rates', header: t('rates'), cell: (v) => v.tiers.map((x: any) => `${x.unitName}: ${money(x.billRate)}`).join(' · ') },
        ]}
      />
    </section>
  )
}
