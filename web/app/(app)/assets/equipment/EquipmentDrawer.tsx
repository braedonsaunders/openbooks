'use client'

import { useMoney } from '@/components/money-provider'
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { ActionError, fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { Badge, Button, Input, Label, Popover, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'
import { KpiStrip } from '../../../../components/kpi-strip'
import { confirmDialog } from '../../../../lib/confirm'
type Opt = { id: string; name: string; code?: string | null; number?: string | null };
/**
 * The loaded unit + KPI metrics as serialized through widget props: uuids as
 * strings, `date` columns as ISO-date strings, numerics as ledger strings.
 */
interface EquipmentUnitRow {
  id: string
  subsidiary_id: string
  unit_number: string
  name: string
  description: string | null
  status: string
  charge_item_id: string | null
  fixed_asset_id: string | null
  rate_book_id: string | null
  purchase_price: string
  acquired_on: string | null
  in_service_on: string | null
  serial_number: string | null
  capacity_quantity: string | null
  capacity_unit: string | null
  charge_item_name: string | null
  rate_book_name: string | null
  fixed_asset_number: string | null
  fixed_asset_cost: string | null
}
interface EquipmentMetricsRow {
  usage: string
  recovery: string
  billable: string
  billed_revenue: string
  direct_costs: string
  depreciation: string
}
export function EquipmentDrawer({ payload, items, assets, books, subsidiaries, canManage, closeHref = '/assets/equipment', fixedAssetsEnabled = false, projectsEnabled = false }: {
  payload: { unit: EquipmentUnitRow; metrics: EquipmentMetricsRow }; items: Opt[]; assets: Opt[]; books: Opt[]; subsidiaries: Opt[]; canManage: boolean; closeHref?: string
  /** Capitalize writes a fixed-asset row — hide that action while Fixed Assets is off. */
  fixedAssetsEnabled?: boolean
  /** Rate books are labor pricing — hide that picker while Projects is off. */
  projectsEnabled?: boolean
}) {
  const { money } = useMoney()
  const t = useTranslations('assets.equipment'); const common = useTranslations('common'); const router = useRouter()
  const e = payload.unit; const m = payload.metrics
  const [mode, setMode] = useState<'view'|'edit'>('view'); const [actionsOpen, setActionsOpen] = useState(false)
  // Saves, deletes and capitalizations run on the shared action path: a
  // refused save pins its reason on the record until the next action
  // (F-t07-006) AND toasts, and busy always releases through the package's
  // finally. The charge-item code flags its field straight from the pin.
  const { busy, refusal, execute, clearRefusal } = useAppAction()
  const [name, setName] = useState(e.name === 'New equipment unit' ? '' : e.name); const [unitNumber, setUnitNumber] = useState(e.unit_number)
  const [description, setDescription] = useState(e.description ?? ''); const [status, setStatus] = useState(e.status)
  const [subsidiaryId, setSubsidiaryId] = useState(e.subsidiary_id); const [chargeItemId, setChargeItemId] = useState(e.charge_item_id ?? '')
  const [fixedAssetId, setFixedAssetId] = useState(e.fixed_asset_id ?? ''); const [rateBookId, setRateBookId] = useState(e.rate_book_id ?? '')
  const [purchasePrice, setPurchasePrice] = useState(String(e.purchase_price ?? '0')); const [acquiredOn, setAcquiredOn] = useState(e.acquired_on ?? '')
  const [inServiceOn, setInServiceOn] = useState(e.in_service_on ?? ''); const [serialNumber, setSerialNumber] = useState(e.serial_number ?? '')
  const [capacityQuantity, setCapacityQuantity] = useState(e.capacity_quantity ?? ''); const [capacityUnit, setCapacityUnit] = useState(e.capacity_unit ?? '')
  const opts = (rows: Opt[]) => rows.map((x) => ({ value: x.id, label: `${x.code ?? x.number ?? ''}${x.code || x.number ? ' · ' : ''}${x.name}` }))
  const form = useMemo(() => ({ name, unitNumber, description, status, subsidiaryId, chargeItemId: chargeItemId || null, fixedAssetId: fixedAssetId || null,
    ...(projectsEnabled ? { rateBookId: rateBookId || null } : {}), purchasePrice, acquiredOn: acquiredOn || null, inServiceOn: inServiceOn || null,
    serialNumber: serialNumber || null, capacityQuantity: capacityQuantity || null, capacityUnit: capacityUnit || null }),
    [name, unitNumber, description, status, subsidiaryId, chargeItemId, fixedAssetId, rateBookId, projectsEnabled, purchasePrice, acquiredOn, inServiceOn, serialNumber, capacityQuantity, capacityUnit])
  async function save(extra: Record<string, unknown> = {}) {
    const ok = await execute(
      async () => {
        const result = await fetchAction(`/api/equipment/${e.id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({...form, ...extra}) })
        // The API names the blocker as a stable code (e.g.
        // charge_item_required at activation): surface its translated
        // reason, not the generic failure (F-t07-006) — and never the raw
        // code, which names no remedy.
        if (!result.ok && result.error.code === 'charge_item_required') {
          return { ok: false, error: new ActionError({ kind: 'refused', code: result.error.code, serverMessage: t('chargeItemRequired') }) }
        }
        return result
      },
      {
        fallbackMessage: t('saveFailed'),
        successMessage: t('saved'),
        onOk: () => {
          if (typeof extra.status === 'string') setStatus(extra.status)
          setActionsOpen(false); setMode('view')
        },
      },
    )
    if (ok) router.refresh()
  }
  async function remove() {
    if (!await confirmDialog({ title: t('deleteTitle'), message: t('deleteMessage'), confirmLabel: common('actions.delete'), tone: 'danger' })) return
    await execute(() => fetchAction(`/api/equipment/${e.id}`, { method:'DELETE' }), {
      fallbackMessage: t('deleteFailed'),
      onOk: () => { router.push('/assets/equipment'); router.refresh() },
    })
  }
  async function capitalize() {
    if (!await confirmDialog({ title: t('capitalizeTitle'), message: t('capitalizeMessage'), confirmLabel: t('capitalize') })) return
    const ok = await execute(
      async () => {
        const result = await fetchAction(`/api/equipment/${e.id}/capitalize`, { method: 'POST' })
        const assetId = (result.ok ? (result.data as { assetId?: unknown } | null)?.assetId : null)
        // The capitalize route answers in kernel codes (already_capitalized,
        // acquisition_cost_invalid): the shared path fills the translated
        // fallback copy, which names the remedy, instead of surfacing a code.
        if (!result.ok || typeof assetId !== 'string' || !assetId) {
          return { ok: false, error: new ActionError({ kind: result.ok ? 'unexpected' : result.error.kind }) }
        }
        return { ok: true, status: 200, data: { assetId } } as const
      },
      {
        fallbackMessage: t('capitalizeFailed'),
        successMessage: t('capitalized'),
        onOk: (data) => {
          router.push(`/assets?asset=${data.assetId}` as never)
        },
      },
    )
    setActionsOpen(false)
    if (ok) router.refresh()
  }
  const editable = mode === 'edit' && canManage
  const input = (label: string, value: string, set: (v:string)=>void, props = {}) => <div className="space-y-1.5"><Label>{label}</Label>{editable ? <Input value={value} onChange={(ev) => set(ev.target.value)} {...props}/> : <p className="text-sm">{value || '—'}</p>}</div>
  const roi = Number(e.purchase_price) > 0
    ? ((Number(m.billed_revenue) - Number(m.recovery) - Number(m.direct_costs) - Number(m.depreciation)) / Number(e.purchase_price)) * 100
    : 0
  const utilization = Number(e.capacity_quantity) > 0 ? Math.min(100, Number(m.usage) / Number(e.capacity_quantity) * 100) : 0
  return <UrlDrawer open closeHref={closeHref} size="2xl" title={<span className="flex items-center gap-2">{name || t('new')}<Badge variant={status === 'active' ? 'success' : 'secondary'}>{t(`statuses.${status}`)}</Badge></span>}
    headerActions={mode === 'edit' ? <><Button size="sm" variant="outline" disabled={busy} onClick={() => { clearRefusal(); setMode('view') }}>{common('actions.cancel')}</Button><Button size="sm" disabled={busy} onClick={() => save()}>{common('actions.save')}</Button></> : canManage ? <><Button size="sm" variant="outline" onClick={() => setMode('edit')}>{common('actions.edit')}</Button><Popover open={actionsOpen} onOpenChange={setActionsOpen} align="end" className="w-52 p-1" trigger={<Button size="sm" variant="outline" onClick={() => setActionsOpen(!actionsOpen)}>{common('labels.actions')}<ChevronDown size={14}/></Button>}><div className="grid gap-1">{status !== 'active' ? <Button variant="ghost" className="justify-start" onClick={() => save({status:'active'})}>{t('activate')}</Button> : <Button variant="ghost" className="justify-start" onClick={() => save({status:'inactive'})}>{t('deactivate')}</Button>} {fixedAssetsEnabled && !e.fixed_asset_id ? <Button variant="ghost" className="justify-start" disabled={busy} onClick={capitalize}>{t('capitalize')}</Button> : null} {status === 'draft' ? <Button variant="ghost" className="justify-start text-red-600" onClick={remove}>{common('actions.delete')}</Button> : null}</div></Popover></> : undefined}>
    <div className="space-y-6">
      <ActionAlert error={refusal} fallbackMessage={t('saveFailed')} />
      <KpiStrip items={[{label:t('metrics.purchasePrice'),value:money(e.purchase_price)},{label:t('metrics.recovery'),value:money(m.recovery)},{label:t('metrics.billedRevenue'),value:money(m.billed_revenue)},{label:t('metrics.roi'),value:`${roi.toFixed(1)}%`},{label:t('metrics.utilization'),value:`${utilization.toFixed(1)}%`}]} />
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {input(common('labels.name'), name, setName)}{input(t('number'), unitNumber, setUnitNumber)}{input(t('serial'), serialNumber, setSerialNumber)}
        <div className="space-y-1.5"><Label>{common('labels.status')}</Label>{editable ? <Select value={status} onChange={(x)=>setStatus(x.target.value)}>{['draft','active','inactive','retired'].map(s=><option key={s} value={s}>{t(`statuses.${s}`)}</option>)}</Select> : <p className="text-sm">{t(`statuses.${status}`)}</p>}</div>
        {subsidiaries.length > 0 ? <div className="space-y-1.5"><Label>{t('subsidiary')}</Label>{editable ? <SearchSelect value={subsidiaryId} onChange={setSubsidiaryId} options={opts(subsidiaries)} sheetTitle={t('subsidiary')} ariaLabel={t('subsidiary')}/> : <p className="text-sm">{subsidiaries.find(x=>x.id===subsidiaryId)?.name ?? '—'}</p>}</div> : null}
        <div className={refusal?.code === 'charge_item_required' ? 'space-y-1.5 rounded-lg border border-red-300 bg-red-50 p-2 dark:border-red-800 dark:bg-red-950/40' : 'space-y-1.5'}><Label>{t('chargeItem')}</Label>{editable ? <SearchSelect value={chargeItemId} onChange={setChargeItemId} options={opts(items)} clearable sheetTitle={t('chargeItem')} ariaLabel={t('chargeItem')}/> : <p className="text-sm">{e.charge_item_name ?? '—'}</p>}</div>
        {fixedAssetsEnabled ? <div className="space-y-1.5"><Label>{t('fixedAsset')}</Label>{editable ? <SearchSelect value={fixedAssetId} onChange={setFixedAssetId} options={opts(assets)} clearable sheetTitle={t('fixedAsset')} ariaLabel={t('fixedAsset')}/> : <p className="text-sm">{e.fixed_asset_number ?? '—'}</p>}</div> : null}
        {projectsEnabled ? (
          <div className="space-y-1.5"><Label>{t('rateBook')}</Label>{editable ? <SearchSelect value={rateBookId} onChange={setRateBookId} options={opts(books)} clearable sheetTitle={t('rateBook')} ariaLabel={t('rateBook')}/> : <p className="text-sm">{e.rate_book_name ?? t('defaultRateBook')}</p>}</div>
        ) : null}
        {input(t('purchasePrice'), purchasePrice, setPurchasePrice, {inputMode:'decimal',className:'text-right tabular-nums'})}{input(t('acquiredOn'), acquiredOn, setAcquiredOn, {type:'date'})}{input(t('inServiceOn'), inServiceOn, setInServiceOn, {type:'date'})}
        {input(t('capacityQuantity'), String(capacityQuantity), setCapacityQuantity, {inputMode:'decimal'})}{input(t('capacityUnit'), capacityUnit, setCapacityUnit)}
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-3"><Label>{t('description')}</Label>{editable ? <Input value={description} onChange={(x)=>setDescription(x.target.value)}/> : <p className="text-sm">{description || '—'}</p>}</div>
      </section>
    </div>
  </UrlDrawer>
}
