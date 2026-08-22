'use client'

import { useMoney } from '@/components/money-provider'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Card, CardContent, Input, Label, SearchSelect } from '@openbooks/ui'
import { KpiStrip } from '../../../../components/kpi-strip'
import { PagedTable } from '../../../../components/paged-table'
export interface ChargeItemOption {
  id: string
  name: string
  defaultCost: string | null
  defaultRate: string | null
}
export interface ChargeEquipmentOption { id: string; name: string; unitNumber: string; itemId: string }
/** An employee an equipment charge can be attributed to (→ parties). */
export interface ChargeOperatorOption { id: string; displayName: string }
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
  equipment,
  operators,
  absorption,
  formOpen,
  onFormOpenChange,
  showKpis = true,
  showList = true,
  equipmentEnabled = false,
}: {
  projectId: string
  charges: ChargeRow[]
  items: ChargeItemOption[]
  equipment: ChargeEquipmentOption[]
  operators: ChargeOperatorOption[]
  absorption: { recovered: string; billValue: string }
  /** The add-charge form is driven by the flyout Actions menu (repository conventions:
   *  secondary creates live behind the Actions menu, not a bolted-on section). */
  formOpen: boolean
  onFormOpenChange: (open: boolean) => void
  /** Project summary surfaces may opt into charge recovery metrics. */
  showKpis?: boolean
  /** Transactions owns the canonical list; false keeps only creation controls. */
  showList?: boolean
  /** Equipment attribution writes a unit link — hide that picker while Equipment is off. */
  equipmentEnabled?: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('projects.charges')
  const tCommon = useTranslations('common')
  /** New keys ship with the catalogue, not with this slice (web/messages is
   *  owned elsewhere); read through a fallback so the field is usable today. */
  const tOr = (key: string, english: string) => (t.has(key as never) ? t(key as never) : english)
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [itemId, setItemId] = useState('')
  const [equipmentUnitId, setEquipmentUnitId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [costRate, setCostRate] = useState('')
  const [billRate, setBillRate] = useState('')

  const itemOptions = useMemo(() => items.map((i) => ({ value: i.id, label: i.name })), [items])
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const equipmentOptions = useMemo(() => equipment.map((e) => ({ value: e.id, label: `${e.unitNumber} · ${e.name}` })), [equipment])
  const operatorOptions = useMemo(() => operators.map((o) => ({ value: o.id, label: o.displayName })), [operators])

  function pickItem(id: string) {
    setItemId(id)
    const it = itemById.get(id)
    if (it) {
      if (!costRate && it.defaultCost != null) setCostRate(Number(it.defaultCost).toString())
      if (!billRate && it.defaultRate != null) setBillRate(Number(it.defaultRate).toString())
    }
  }

  function pickEquipment(id: string) {
    setEquipmentUnitId(id)
    // Clearing the unit clears the operator: an operator without a unit is not
    // an equipment attribution, and the service refuses it.
    if (!id) setEmployeeId('')
    const unit = equipment.find((e) => e.id === id)
    if (unit) { setItemId(unit.itemId); setCostRate(''); setBillRate('') }
  }

  async function submit() {
    if (!itemId) return toast.error(t('pickItem'))
    setBusy(true)
    const res = await fetch('/api/project-charges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        lines: [{ itemId, quantity,
          costRate: equipmentEnabled && equipmentUnitId ? null : (costRate || null),
          billRate: equipmentEnabled && equipmentUnitId ? null : (billRate || null),
          isBillable: true,
          ...(equipmentEnabled ? { equipmentUnitId: equipmentUnitId || null, employeeId: (equipmentUnitId && employeeId) || null } : {}) }],
      }),
    })
    if (res.ok) {
      toast.success(t('created'))
      setItemId(''); setEquipmentUnitId(''); setEmployeeId(''); setQuantity('1'); setCostRate(''); setBillRate('')
      onFormOpenChange(false)
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('failed'))
    }
    setBusy(false)
  }

  const statusVariant = (s: string) => (s === 'posted' ? 'success' : s === 'voided' ? 'outline' : 'secondary')

  return (
    <div className="space-y-6">
      {showKpis ? (
        <KpiStrip
          items={[
            { label: t('costRecovered'), value: money(absorption.recovered), tone: 'good' },
            { label: t('billValue'), value: money(absorption.billValue) },
            { label: t('count'), value: String(charges.length) },
          ]}
        />
      ) : null}

      {/* Add-charge form — opened from the Actions menu, not always-on. */}
      {formOpen ? (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('addTitle')}</h3>
              <Button variant="ghost" size="sm" onClick={() => onFormOpenChange(false)}>{tCommon('actions.cancel')}</Button>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('addHint')}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
              {equipmentEnabled ? (
                <div className={`${field} lg:col-span-2`}>
                  <Label>{t('equipmentUnit')}</Label>
                  <SearchSelect value={equipmentUnitId} onChange={(v) => pickEquipment(v ?? '')} options={equipmentOptions} clearable placeholder={t('selectEquipment')} sheetTitle={t('equipmentUnit')} ariaLabel={t('equipmentUnit')} />
                </div>
              ) : null}
              {/* Operator — only for an equipment line, because that is the only
                  line an equipment incentive can pay on. Optional by design:
                  refusing to record the charge because nobody remembered who ran
                  the machine would cost the customer their job cost and their
                  invoice, which is worse. The incentive rule is what refuses,
                  and it refuses loudly. */}
              {equipmentEnabled ? (
                <div className={`${field} lg:col-span-2`}>
                  <Label>{tOr('operator', 'Operator')}</Label>
                  <SearchSelect
                    value={employeeId}
                    onChange={(v) => setEmployeeId(v ?? '')}
                    options={operatorOptions}
                    disabled={!equipmentUnitId}
                    clearable
                    placeholder={equipmentUnitId ? tOr('selectOperator', 'Select an operator…') : tOr('operatorNeedsEquipment', 'Equipment lines only')}
                    sheetTitle={tOr('operator', 'Operator')}
                    ariaLabel={tOr('operator', 'Operator')}
                  />
                </div>
              ) : null}
              <div className={`${field} lg:col-span-2`}>
                <Label>{t('item')}</Label>
                <SearchSelect value={itemId} onChange={(v) => pickItem(v ?? '')} options={itemOptions} disabled={!!equipmentUnitId} placeholder={t('selectItem')} sheetTitle={t('item')} ariaLabel={t('item')} />
              </div>
              <div className={field}>
                <Label>{t('quantity')}</Label>
                <Input inputMode="decimal" className="text-right tabular-nums" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className={field}>
                <Label>{t('costRate')}</Label>
                <Input disabled={!!equipmentUnitId} inputMode="decimal" className="text-right tabular-nums" value={costRate} onChange={(e) => setCostRate(e.target.value)} placeholder={equipmentUnitId ? t('automaticRate') : '0.00'} />
              </div>
              <div className={field}>
                <Label>{t('billRate')}</Label>
                <Input disabled={!!equipmentUnitId} inputMode="decimal" className="text-right tabular-nums" value={billRate} onChange={(e) => setBillRate(e.target.value)} placeholder={equipmentUnitId ? t('automaticRate') : '0.00'} />
              </div>
            </div>
            <Button onClick={submit} disabled={busy || !itemId}>{busy ? tCommon('actions.saving') : t('post')}</Button>
          </CardContent>
        </Card>
      ) : null}

      {/* The project Transactions tab is the canonical record list. This
          optional list remains reusable outside that cockpit. */}
      {showList ? <div className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
        <PagedTable
          rows={charges}
          rowKey={(r) => r.id}
          searchable
          empty={<p className="text-sm text-slate-500 dark:text-slate-400">{t('none')}</p>}
          columns={[
            { key: 'number', header: tCommon('labels.number'), cell: (c) => <span className="font-mono text-[13px] font-semibold">{c.documentNumber}</span>, search: (c) => c.documentNumber },
            { key: 'date', header: tCommon('labels.date'), cell: (c) => <span className="text-slate-600 dark:text-slate-300">{c.documentDate}</span> },
            { key: 'status', header: tCommon('labels.status'), cell: (c) => <Badge variant={statusVariant(c.status)}>{tCommon.has(`status.${c.status}`) ? tCommon(`status.${c.status}`) : c.status}</Badge> },
            { key: 'cost', header: t('cost'), align: 'right', cell: (c) => money(c.cost) },
            { key: 'billValue', header: t('billValue'), align: 'right', cell: (c) => money(c.billValue) },
            { key: 'billed', header: t('billed'), cell: (c) => (c.billed ? <Badge variant="success">{t('billedYes')}</Badge> : <span className="text-slate-400">—</span>) },
          ]}
        />
      </div> : null}
    </div>
  )
}
