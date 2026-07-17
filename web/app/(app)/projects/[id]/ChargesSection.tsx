'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, SearchSelect } from '@openbooks/ui'
import { money } from '../../../../lib/format'

export interface ChargeItemOption {
  id: string
  name: string
  defaultCost: string | null
  defaultRate: string | null
}
export interface ChargeRow {
  id: string
  documentNumber: string
  documentDate: string
  status: string
  cost: string
  billValue: string
  lines: number
  billed: boolean | null
}

const field = 'space-y-1.5'

export function ChargesSection({
  projectId,
  charges,
  items,
  absorption,
  canManage,
}: {
  projectId: string
  charges: ChargeRow[]
  items: ChargeItemOption[]
  absorption: { recovered: string; billValue: string }
  canManage: boolean
}) {
  const t = useTranslations('projects.charges')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [costRate, setCostRate] = useState('')
  const [billRate, setBillRate] = useState('')

  const itemOptions = useMemo(() => items.map((i) => ({ value: i.id, label: i.name })), [items])
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])

  function pickItem(id: string) {
    setItemId(id)
    const it = itemById.get(id)
    if (it) {
      if (!costRate && it.defaultCost != null) setCostRate(Number(it.defaultCost).toString())
      if (!billRate && it.defaultRate != null) setBillRate(Number(it.defaultRate).toString())
    }
  }

  async function submit() {
    if (!itemId) return toast.error(t('pickItem'))
    setBusy(true)
    const res = await fetch('/api/project-charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        lines: [{ itemId, quantity, costRate: costRate || null, billRate: billRate || null, isBillable: true }],
      }),
    })
    if (res.ok) {
      toast.success(t('created'))
      setItemId(''); setQuantity('1'); setCostRate(''); setBillRate('')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('failed'))
    }
    setBusy(false)
  }

  const statusVariant = (s: string) => (s === 'posted' ? 'success' : s === 'voided' ? 'outline' : 'secondary')

  return (
    <div className="space-y-6">
      {/* Absorption / recovery summary */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4">
          <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('costRecovered')}</span>
          <span className="block text-xl font-semibold tabular-nums text-teal-700 dark:text-teal-300">{money(absorption.recovered)}</span>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('billValue')}</span>
          <span className="block text-xl font-semibold tabular-nums">{money(absorption.billValue)}</span>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <span className="block text-xs font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400">{t('count')}</span>
          <span className="block text-xl font-semibold tabular-nums">{charges.length}</span>
        </CardContent></Card>
      </section>

      {/* Add a charge */}
      {canManage ? (
        <Card>
          <CardContent className="space-y-4 p-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('addTitle')}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('addHint')}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className={`${field} lg:col-span-2`}>
                <Label>{t('item')}</Label>
                <SearchSelect value={itemId} onChange={(v) => pickItem(v ?? '')} options={itemOptions} placeholder={t('selectItem')} sheetTitle={t('item')} ariaLabel={t('item')} />
              </div>
              <div className={field}>
                <Label>{t('quantity')}</Label>
                <Input inputMode="decimal" className="text-right tabular-nums" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className={field}>
                <Label>{t('costRate')}</Label>
                <Input inputMode="decimal" className="text-right tabular-nums" value={costRate} onChange={(e) => setCostRate(e.target.value)} placeholder="0.00" />
              </div>
              <div className={field}>
                <Label>{t('billRate')}</Label>
                <Input inputMode="decimal" className="text-right tabular-nums" value={billRate} onChange={(e) => setBillRate(e.target.value)} placeholder="0.00" />
              </div>
            </div>
            <Button onClick={submit} disabled={busy || !itemId}>{busy ? tCommon('actions.saving') : t('post')}</Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Charges list */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
        {charges.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('none')}</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-3 py-2">{tCommon('labels.number')}</th>
                  <th className="px-3 py-2">{tCommon('labels.date')}</th>
                  <th className="px-3 py-2">{tCommon('labels.status')}</th>
                  <th className="px-3 py-2 text-right">{t('cost')}</th>
                  <th className="px-3 py-2 text-right">{t('billValue')}</th>
                  <th className="px-3 py-2">{t('billed')}</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                    <td className="px-3 py-2 font-mono text-[13px] font-semibold">{c.documentNumber}</td>
                    <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{c.documentDate}</td>
                    <td className="px-3 py-2"><Badge variant={statusVariant(c.status)}>{c.status}</Badge></td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(c.cost)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(c.billValue)}</td>
                    <td className="px-3 py-2">{c.billed ? <Badge variant="success">{t('billedYes')}</Badge> : <span className="text-slate-400">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
