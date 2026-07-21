'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, Select } from '@openbooks/ui'
import { PagedTable } from '../../../components/paged-table'
import { money } from '../../../lib/format'

type Data = {
  versions: { id: string; book_name: string; currency: string; effective_from: string }[]
  rules: { id: string; code: string; name: string; lane: string; method: string; amount: string | null; percent: string | null; currency: string; priority: number; status: string; effective_from: string; book_name: string }[]
}

export function ItemLaborRatesEditor({ itemId, canManage }: { itemId: string; canManage: boolean }) {
  const t = useTranslations('items.laborRates')
  const common = useTranslations('common')
  const [data, setData] = useState<Data>({ versions: [], rules: [] })
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [versionId, setVersionId] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [lane, setLane] = useState('bill')
  const [method, setMethod] = useState('fixed')
  const [value, setValue] = useState('0')
  const [priority, setPriority] = useState('100')

  async function load() {
    const response = await fetch(`/api/items/${itemId}/labor-rates`)
    if (!response.ok) return
    const next = await response.json() as Data
    setData(next)
    setVersionId((current) => current || next.versions[0]?.id || '')
  }
  useEffect(() => { void load() }, [itemId])

  async function save() {
    const version = data.versions.find((entry) => entry.id === versionId)
    setBusy(true)
    const response = await fetch(`/api/items/${itemId}/labor-rates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId, code, name, lane, method, amount: method === 'fixed' ? value : null, percent: method.includes('cost') && method !== 'at_cost' ? value : null, currency: version?.currency, priority }),
    })
    const result = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) return toast.error(result.error ?? t('saveFailed'))
    toast.success(t('saved'))
    setEditing(false)
    setCode(''); setName(''); setValue('0')
    await load()
  }

  return <section className="space-y-3">
    <div className="flex items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>
      <div className="flex items-center gap-2">
        <Link href="/docs/labor-rates" className="text-xs font-medium text-teal-700 hover:underline dark:text-teal-300">{t('documentation')}</Link>
        {canManage && !editing ? <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t('addRule')}</Button> : null}
      </div>
    </div>
    {editing ? <Card><CardContent className="space-y-4 p-4">
      {data.versions.length === 0 ? <p className="text-sm text-amber-700 dark:text-amber-300">{t('draftRequired')}</p> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1"><Label>{t('version')}</Label><Select value={versionId} onChange={(e) => setVersionId(e.target.value)}>{data.versions.map((v) => <option key={v.id} value={v.id}>{v.book_name} · {v.effective_from}</option>)}</Select></div>
        <div className="space-y-1"><Label>{t('code')}</Label><Input value={code} onChange={(e) => setCode(e.target.value)} /></div>
        <div className="space-y-1"><Label>{common('labels.name')}</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-1"><Label>{t('lane')}</Label><Select value={lane} onChange={(e) => { const next = e.target.value; setLane(next); if (next === 'direct_cost') setMethod('fixed') }}>{['direct_cost','bill','transfer','planning_cost','planning_bill'].map((v) => <option key={v} value={v}>{t(`lanes.${v}`)}</option>)}</Select></div>
        <div className="space-y-1"><Label>{t('method')}</Label><Select value={method} onChange={(e) => setMethod(e.target.value)}>{(lane === 'direct_cost' ? ['fixed'] : ['fixed','at_cost','markup_on_cost','margin_on_cost']).map((v) => <option key={v} value={v}>{t(`methods.${v}`)}</option>)}</Select></div>
        {method !== 'at_cost' ? <div className="space-y-1"><Label>{method === 'fixed' ? t('hourlyRate') : t('percent')}</Label><Input inputMode="decimal" className="text-right tabular-nums" value={value} onChange={(e) => setValue(e.target.value)} /></div> : null}
        <div className="space-y-1"><Label>{t('priority')}</Label><Input inputMode="numeric" className="text-right tabular-nums" value={priority} onChange={(e) => setPriority(e.target.value)} /></div>
      </div>}
      <div className="flex gap-2"><Button disabled={busy || !versionId || !code.trim() || !name.trim()} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button><Button variant="outline" onClick={() => setEditing(false)}>{common('actions.cancel')}</Button></div>
    </CardContent></Card> : null}
    <PagedTable rows={data.rules} rowKey={(row) => row.id} searchable empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>} columns={[
      { key: 'rule', header: t('rule'), cell: (r) => <span><span className="font-medium">{r.code}</span> · {r.name}</span>, search: (r) => `${r.code} ${r.name}` },
      { key: 'book', header: t('book'), cell: (r) => `${r.book_name} · ${r.effective_from}`, search: (r) => r.book_name },
      { key: 'lane', header: t('lane'), cell: (r) => t(`lanes.${r.lane}` as never) },
      { key: 'value', header: t('value'), cell: (r) => r.amount != null ? `${money(r.amount)} ${r.currency}/${t('hour')}` : r.percent != null ? `${r.percent}%` : t('atCost') },
      { key: 'priority', header: t('priority'), cell: (r) => <span className="tabular-nums">{r.priority}</span> },
      { key: 'status', header: common('labels.status'), cell: (r) => <Badge variant={r.status === 'active' ? 'success' : 'secondary'}>{r.status}</Badge> },
    ]} />
  </section>
}
