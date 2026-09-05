'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, Label, SearchSelect, Select } from '@openbooks/ui'

interface AccountOpt {
  id: string
  number?: string | null
  name?: string | null
}
interface Profile {
  updated_at: string
  costing_method: string
  tracking: string
  asset_account_id: string | null
  cogs_account_id: string | null
  adjustment_account_id: string | null
  variance_account_id: string | null
  received_not_billed_account_id: string | null
  standard_cost: string | null
  base_unit: string
  reorder_point: string | null
  preferred_stock_level: string | null
  allow_negative_inventory: boolean
  negative_cost_basis: string
  provisional_unit_cost: string | null
}

const METHODS = ['fifo', 'moving_average', 'standard'] as const
const TRACKING = ['none', 'lot', 'serial'] as const
const NEGATIVE_COST_BASIS = ['last_receipt', 'standard', 'configured'] as const
const field = 'space-y-1.5'

/**
 * Per-item costing profile (item_inventory_profiles), re-homed from Setup onto
 * the item record. Only shown for item kinds that carry stock. Loads the profile
 * on mount and upserts via /api/items/[id]/costing.
 */
export function ItemCostingEditor({
  itemId,
  kind,
  accounts,
  canManage,
}: {
  itemId: string
  kind: string
  accounts: AccountOpt[]
  canManage: boolean
}) {
  const t = useTranslations('items.costing')
  const common = useTranslations('common')
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!canManage) setEditing(false)
  }, [canManage])
  const [busy, setBusy] = useState(false)

  const [costingMethod, setCostingMethod] = useState('moving_average')
  const [tracking, setTracking] = useState('none')
  const [assetAccountId, setAssetAccountId] = useState('')
  const [cogsAccountId, setCogsAccountId] = useState('')
  const [adjustmentAccountId, setAdjustmentAccountId] = useState('')
  const [varianceAccountId, setVarianceAccountId] = useState('')
  const [receivedNotBilledAccountId, setReceivedNotBilledAccountId] = useState('')
  const [standardCost, setStandardCost] = useState('')
  const [baseUnit, setBaseUnit] = useState('ea')
  const [reorderPoint, setReorderPoint] = useState('')
  const [preferredStockLevel, setPreferredStockLevel] = useState('')
  const [allowNegativeInventory, setAllowNegativeInventory] = useState(false)
  const [negativeCostBasis, setNegativeCostBasis] = useState('last_receipt')
  const [provisionalUnitCost, setProvisionalUnitCost] = useState('')

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
    [accounts],
  )
  const accountLabel = (id: string | null) =>
    id ? (accountOptions.find((a) => a.value === id)?.label ?? id) : '—'

  function hydrate(p: Profile | null) {
    setCostingMethod(p?.costing_method ?? 'moving_average')
    setTracking(p?.tracking ?? 'none')
    setAssetAccountId(p?.asset_account_id ?? '')
    setCogsAccountId(p?.cogs_account_id ?? '')
    setAdjustmentAccountId(p?.adjustment_account_id ?? '')
    setVarianceAccountId(p?.variance_account_id ?? '')
    setReceivedNotBilledAccountId(p?.received_not_billed_account_id ?? '')
    setStandardCost(p?.standard_cost ?? '')
    setBaseUnit(p?.base_unit ?? 'ea')
    setReorderPoint(p?.reorder_point ?? '')
    setPreferredStockLevel(p?.preferred_stock_level ?? '')
    setAllowNegativeInventory(p?.allow_negative_inventory ?? false)
    setNegativeCostBasis(p?.negative_cost_basis ?? 'last_receipt')
    setProvisionalUnitCost(p?.provisional_unit_cost ?? '')
  }

  async function load(signal?: AbortSignal) {
    const res = await fetch(`/api/items/${itemId}/costing`, { signal })
    if (!res.ok) throw new Error(common('feedback.loadFailed'))
    const next = (await res.json()) as { profile: Profile | null }
    if (signal?.aborted) return
    setProfile(next.profile)
    hydrate(next.profile)
    setLoaded(true)
  }
  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false)
    setEditing(false)
    setProfile(null)
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) toast.error(common('feedback.loadFailed'))
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/items/${itemId}/costing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedUpdatedAt: profile?.updated_at ?? null,
          costingMethod, tracking, assetAccountId, cogsAccountId,
          adjustmentAccountId, varianceAccountId, receivedNotBilledAccountId,
          standardCost, baseUnit, reorderPoint, preferredStockLevel,
          allowNegativeInventory, negativeCostBasis, provisionalUnitCost,
        }),
      })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) toast.error(result.error ?? common('feedback.saveFailed'))
      else {
        toast.success(common('feedback.saved'))
        setEditing(false)
        await load()
      }
    } catch {
      toast.error(common('feedback.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  function cancel() {
    hydrate(profile)
    setEditing(false)
  }

  // Costing only applies to items that actually hold stock.
  if (!['inventory', 'assembly', 'kit'].includes(kind)) return null

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('description')}</p>
        </div>
        {canManage && !editing ? (
          <Button variant="outline" size="sm" disabled={!loaded || busy} onClick={() => setEditing(true)}>
            {profile ? common('actions.edit') : t('configure')}
          </Button>
        ) : null}
      </div>

      {editing ? (
        <Card>
          <CardContent className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={field}>
              <Label>{t('method')}</Label>
              <Select value={costingMethod} onChange={(e) => setCostingMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>{t(`methods.${m}`)}</option>
                ))}
              </Select>
            </div>
            <div className={field}>
              <Label>{t('tracking')}</Label>
              <Select value={tracking} onChange={(e) => setTracking(e.target.value)}>
                {TRACKING.map((tr) => (
                  <option key={tr} value={tr}>{t(`trackingOptions.${tr}`)}</option>
                ))}
              </Select>
            </div>
            <div className={field}>
              <Label>{t('baseUnit')}</Label>
              <Input value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} />
            </div>
            <div className={field}>
              <Label>{t('assetAccount')}<span className="text-red-500"> *</span></Label>
              <SearchSelect value={assetAccountId} onChange={setAssetAccountId} options={accountOptions}
                placeholder={t('selectAccount')} sheetTitle={t('assetAccount')} ariaLabel={t('assetAccount')} />
            </div>
            <div className={field}>
              <Label>{t('cogsAccount')}<span className="text-red-500"> *</span></Label>
              <SearchSelect value={cogsAccountId} onChange={setCogsAccountId} options={accountOptions}
                placeholder={t('selectAccount')} sheetTitle={t('cogsAccount')} ariaLabel={t('cogsAccount')} />
            </div>
            <div className={field}>
              <Label>{t('adjustmentAccount')}</Label>
              <SearchSelect value={adjustmentAccountId} onChange={setAdjustmentAccountId} options={accountOptions}
                clearable placeholder={t('selectAccount')} sheetTitle={t('adjustmentAccount')} ariaLabel={t('adjustmentAccount')} />
            </div>
            <div className={field}>
              <Label>{t('varianceAccount')}</Label>
              <SearchSelect value={varianceAccountId} onChange={setVarianceAccountId} options={accountOptions}
                clearable placeholder={t('selectAccount')} sheetTitle={t('varianceAccount')} ariaLabel={t('varianceAccount')} />
            </div>
            <div className={field}>
              <Label>{t('receivedNotBilledAccount')}</Label>
              <SearchSelect value={receivedNotBilledAccountId} onChange={setReceivedNotBilledAccountId} options={accountOptions}
                clearable placeholder={t('selectAccount')} sheetTitle={t('receivedNotBilledAccount')} ariaLabel={t('receivedNotBilledAccount')} />
            </div>
            <div className={field}>
              <Label>{t('standardCost')}</Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={standardCost} onChange={(e) => setStandardCost(e.target.value)} />
            </div>
            <div className={field}>
              <Label>{t('reorderPoint')}</Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={reorderPoint} onChange={(e) => setReorderPoint(e.target.value)} />
            </div>
            <div className={field}>
              <Label>{t('preferredStockLevel')}</Label>
              <Input inputMode="decimal" className="text-right tabular-nums" value={preferredStockLevel} onChange={(e) => setPreferredStockLevel(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={allowNegativeInventory} onChange={(event) => setAllowNegativeInventory(event.target.checked)} />
              {t('allowNegativeInventory')}
            </label>
            {allowNegativeInventory ? (
              <>
                <div className={field}>
                  <Label>{t('negativeCostBasis')}</Label>
                  <Select value={negativeCostBasis} onChange={(event) => setNegativeCostBasis(event.target.value)}>
                    {NEGATIVE_COST_BASIS.map((basis) => <option key={basis} value={basis}>{t(`negativeCostBasisOptions.${basis}`)}</option>)}
                  </Select>
                </div>
                {negativeCostBasis === 'configured' ? (
                  <div className={field}>
                    <Label>{t('provisionalUnitCost')}</Label>
                    <Input inputMode="decimal" className="text-right tabular-nums" value={provisionalUnitCost} onChange={(event) => setProvisionalUnitCost(event.target.value)} />
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-3">
              <Button disabled={busy} onClick={save}>{busy ? common('actions.saving') : common('actions.save')}</Button>
              <Button variant="outline" onClick={cancel}>{common('actions.cancel')}</Button>
            </div>
          </CardContent>
        </Card>
      ) : loaded && !profile ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('empty')}</p>
      ) : profile ? (
        <Card>
          <CardContent className="grid gap-x-6 gap-y-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Detail label={t('method')} value={t(`methods.${profile.costing_method}`)} />
            <Detail label={t('tracking')} value={t(`trackingOptions.${profile.tracking}`)} />
            <Detail label={t('baseUnit')} value={profile.base_unit} />
            <Detail label={t('assetAccount')} value={accountLabel(profile.asset_account_id)} />
            <Detail label={t('cogsAccount')} value={accountLabel(profile.cogs_account_id)} />
            <Detail label={t('adjustmentAccount')} value={accountLabel(profile.adjustment_account_id)} />
            <Detail label={t('standardCost')} value={profile.standard_cost ?? '—'} />
            <Detail label={t('reorderPoint')} value={profile.reorder_point ?? '—'} />
            <Detail label={t('preferredStockLevel')} value={profile.preferred_stock_level ?? '—'} />
            <Detail label={t('allowNegativeInventory')} value={profile.allow_negative_inventory ? common('labels.yes') : common('labels.no')} />
            {profile.allow_negative_inventory ? <Detail label={t('negativeCostBasis')} value={t(`negativeCostBasisOptions.${profile.negative_cost_basis}`)} /> : null}
            {profile.allow_negative_inventory && profile.negative_cost_basis === 'configured' ? <Detail label={t('provisionalUnitCost')} value={profile.provisional_unit_cost ?? '—'} /> : null}
          </CardContent>
        </Card>
      ) : null}
    </section>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  )
}
