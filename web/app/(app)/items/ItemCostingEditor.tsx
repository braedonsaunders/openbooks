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
  unit_conversions: Record<string, number> | null
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

export type CostingOffsetField =
  | 'cogsAccountId'
  | 'adjustmentAccountId'
  | 'varianceAccountId'
  | 'receivedNotBilledAccountId'

export interface CostingAccountSelection {
  assetAccountId: string
  cogsAccountId: string
  adjustmentAccountId: string
  varianceAccountId: string
  receivedNotBilledAccountId: string
}

const OFFSET_FIELDS: readonly CostingOffsetField[] = [
  'cogsAccountId',
  'adjustmentAccountId',
  'varianceAccountId',
  'receivedNotBilledAccountId',
]

/**
 * Client mirror of the server's inventoryOffsetAccountProblem rule
 * (engine/src/inventory/journal.ts): every offset account must differ from the
 * inventory asset account, or PUT /api/items/[id]/costing answers 422.
 * Checked inline before any submit (F-t09-002) so the form can refuse the
 * combination itself instead of surfacing it as a transient toast.
 */
export function costingOffsetConflicts(selection: CostingAccountSelection): CostingOffsetField[] {
  const asset = selection.assetAccountId.trim().toLowerCase()
  if (!asset) return []
  const out: CostingOffsetField[] = []
  for (const key of OFFSET_FIELDS) {
    const value = selection[key].trim().toLowerCase()
    if (value && value === asset) out.push(key)
  }
  return out
}

export interface ConversionRowInput {
  unit: string
  factor: string
}

export interface ConversionRowIssue {
  index: number
  field: 'unit' | 'factor'
  code: 'required' | 'invalid' | 'duplicate'
}

/**
 * Client mirror of the server's parseUnitConversions rule
 * (engine/src/inventory/profile-policy.ts): names must be non-blank, factors
 * positive numbers with at most four decimal places, and no unit twice under
 * any spelling (posting folds case). Checked inline before any submit so the
 * form refuses a row the PUT would answer 422, instead of surfacing it as a
 * transient toast.
 */
export function validateConversionRows(rows: ConversionRowInput[]): ConversionRowIssue[] {
  const issues: ConversionRowIssue[] = []
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const unit = row.unit.trim()
    if (!unit) {
      issues.push({ index, field: 'unit', code: 'required' })
    } else {
      const folded = unit.toLowerCase()
      if (seen.has(folded)) {
        issues.push({ index, field: 'unit', code: 'duplicate' })
      } else {
        seen.add(folded)
      }
    }
    // The server receives a JSON number, so validate the parsed value, not
    // the keystrokes: ".5" and "12." both arrive as exact decimals.
    const numeric = Number(row.factor.trim())
    if (
      row.factor.trim() === '' ||
      !Number.isFinite(numeric) ||
      numeric <= 0 ||
      !/^\d+(\.\d{1,4})?$/.test(String(numeric))
    ) {
      issues.push({ index, field: 'factor', code: 'invalid' })
    }
  })
  return issues
}

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
  // A read-only viewer must never hold the form in edit mode. Adjusted during
  // render (same committed value, no extra render).
  if (!canManage && editing) setEditing(false)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)

  const [costingMethod, setCostingMethod] = useState('moving_average')
  const [tracking, setTracking] = useState('none')
  const [assetAccountId, setAssetAccountId] = useState('')
  const [cogsAccountId, setCogsAccountId] = useState('')
  const [adjustmentAccountId, setAdjustmentAccountId] = useState('')
  const [varianceAccountId, setVarianceAccountId] = useState('')
  const [receivedNotBilledAccountId, setReceivedNotBilledAccountId] = useState('')
  const [standardCost, setStandardCost] = useState('')
  const [baseUnit, setBaseUnit] = useState('ea')
  const [conversions, setConversions] = useState<(ConversionRowInput & { id: string })[]>([])
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

  const conflicts = useMemo(
    () =>
      costingOffsetConflicts({
        assetAccountId,
        cogsAccountId,
        adjustmentAccountId,
        varianceAccountId,
        receivedNotBilledAccountId,
      }),
    [assetAccountId, cogsAccountId, adjustmentAccountId, varianceAccountId, receivedNotBilledAccountId],
  )
  const conflicted = useMemo(() => new Set<CostingOffsetField>(conflicts), [conflicts])
  const conversionIssues = useMemo(() => validateConversionRows(conversions), [conversions])
  const conversionIssueAt = (index: number, field: 'unit' | 'factor') =>
    conversionIssues.find((issue) => issue.index === index && issue.field === field)?.code ?? null
  const conversionIssueMessage = (code: 'required' | 'invalid' | 'duplicate') =>
    code === 'required' ? t('conversionUnitRequired')
    : code === 'duplicate' ? t('conversionDuplicate')
    : t('conversionFactorInvalid')
  const conflictNote = (key: CostingOffsetField) =>
    conflicted.has(key) ? (
      <p role="alert" className="text-xs text-red-600 dark:text-red-400">
        {t('separationConflict')}
      </p>
    ) : null

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
    setConversions(
      Object.entries(p?.unit_conversions ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([unit, factor]) => ({ id: crypto.randomUUID(), unit, factor: String(factor) })),
    )
    setReorderPoint(p?.reorder_point ?? '')
    setPreferredStockLevel(p?.preferred_stock_level ?? '')
    setAllowNegativeInventory(p?.allow_negative_inventory ?? false)
    setNegativeCostBasis(p?.negative_cost_basis ?? 'last_receipt')
    setProvisionalUnitCost(p?.provisional_unit_cost ?? '')
  }

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  function load(signal?: AbortSignal) {
    return fetch(`/api/items/${itemId}/costing`, { signal })
      .then((res) => {
        if (!res.ok) throw new Error(common('feedback.loadFailed'))
        return (res.json() as Promise<{ profile: Profile | null }>).then((next) => {
          if (signal?.aborted) return
          setProfile(next.profile)
          hydrate(next.profile)
          setLoaded(true)
        })
      })
  }
  // Clear the costing view while reloading for another item, during render
  // (same committed values, no extra render).
  const [prevItemId, setPrevItemId] = useState(itemId)
  if (prevItemId !== itemId) {
    setPrevItemId(itemId)
    setLoaded(false)
    setEditing(false)
    setProfile(null)
  }
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) toast.error(common('feedback.loadFailed'))
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId])

  async function save() {
    // Refuse the combination inline: the server answers 422 for any offset
    // account equal to the asset account, and for any malformed conversion
    // row, so never issue that PUT.
    if (conflicts.length > 0 || conversionIssues.length > 0) {
      setBlocked(true)
      return
    }
    setBlocked(false)
    setServerError(null)
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
          // Explicit object replaces the stored map (rows already validated
          // inline, so the server's 422 is unreachable from this form).
          unitConversions: Object.fromEntries(
            conversions.map((row) => [row.unit.trim(), Number(row.factor.trim())]),
          ),
        }),
      })
      const result = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        const message = result.error ?? common('feedback.saveFailed')
        // A rejected save must persist as an inline error, not only a toast.
        setServerError(message)
        toast.error(message)
      } else {
        toast.success(common('feedback.saved'))
        setEditing(false)
        await load()
      }
    } catch {
      const message = common('feedback.saveFailed')
      setServerError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  function cancel() {
    hydrate(profile)
    setBlocked(false)
    setServerError(null)
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
            <div className={`${field} sm:col-span-2 lg:col-span-3`}>
              <Label>{t('unitConversions')}</Label>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('unitConversionsDescription')}</p>
              {conversions.map((row, index) => {
                const unitIssue = conversionIssueAt(index, 'unit')
                const factorIssue = conversionIssueAt(index, 'factor')
                return (
                  <div key={row.id} className="flex items-start gap-2">
                    <div className="flex-1">
                      <Input
                        aria-label={t('conversionUnit')}
                        placeholder={t('conversionUnit')}
                        aria-invalid={unitIssue ? true : undefined}
                        value={row.unit}
                        onChange={(e) =>
                          setConversions((rows) =>
                            rows.map((r) => (r.id === row.id ? { ...r, unit: e.target.value } : r)),
                          )
                        }
                      />
                      {unitIssue ? (
                        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                          {conversionIssueMessage(unitIssue)}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex-1">
                      <Input
                        aria-label={t('conversionFactor')}
                        placeholder={t('conversionFactor')}
                        inputMode="decimal"
                        className="text-right tabular-nums"
                        aria-invalid={factorIssue ? true : undefined}
                        value={row.factor}
                        onChange={(e) =>
                          setConversions((rows) =>
                            rows.map((r) => (r.id === row.id ? { ...r, factor: e.target.value } : r)),
                          )
                        }
                      />
                      {factorIssue ? (
                        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                          {conversionIssueMessage(factorIssue)}
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConversions((rows) => rows.filter((r) => r.id !== row.id))}
                    >
                      {t('removeConversion')}
                    </Button>
                  </div>
                )
              })}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setConversions((rows) => [...rows, { id: crypto.randomUUID(), unit: '', factor: '' }])
                  }
                >
                  {t('addConversion')}
                </Button>
              </div>
            </div>
            <div className={field}>
              <Label>{t('assetAccount')}<span className="text-red-500"> *</span></Label>
              <SearchSelect value={assetAccountId} onChange={setAssetAccountId} options={accountOptions}
                placeholder={t('selectAccount')} sheetTitle={t('assetAccount')} ariaLabel={t('assetAccount')} />
            </div>
            <div className={field}>
              <Label>{t('cogsAccount')}<span className="text-red-500"> *</span></Label>
              <SearchSelect value={cogsAccountId} onChange={setCogsAccountId} options={accountOptions}
                placeholder={t('selectAccount')} sheetTitle={t('cogsAccount')} ariaLabel={t('cogsAccount')}
                invalid={conflicted.has('cogsAccountId')} />
              {conflictNote('cogsAccountId')}
            </div>
            <div className={field}>
              <Label>{t('adjustmentAccount')}</Label>
              <SearchSelect value={adjustmentAccountId} onChange={setAdjustmentAccountId} options={accountOptions}
                clearable placeholder={t('selectAccount')} sheetTitle={t('adjustmentAccount')} ariaLabel={t('adjustmentAccount')}
                invalid={conflicted.has('adjustmentAccountId')} />
              {conflictNote('adjustmentAccountId')}
            </div>
            <div className={field}>
              <Label>{t('varianceAccount')}</Label>
              <SearchSelect value={varianceAccountId} onChange={setVarianceAccountId} options={accountOptions}
                clearable placeholder={t('selectAccount')} sheetTitle={t('varianceAccount')} ariaLabel={t('varianceAccount')}
                invalid={conflicted.has('varianceAccountId')} />
              {conflictNote('varianceAccountId')}
            </div>
            <div className={field}>
              <Label>{t('receivedNotBilledAccount')}</Label>
              <SearchSelect value={receivedNotBilledAccountId} onChange={setReceivedNotBilledAccountId} options={accountOptions}
                clearable placeholder={t('selectAccount')} sheetTitle={t('receivedNotBilledAccount')} ariaLabel={t('receivedNotBilledAccount')}
                invalid={conflicted.has('receivedNotBilledAccountId')} />
              {conflictNote('receivedNotBilledAccountId')}
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
            {blocked && conflicts.length > 0 ? (
              <p role="alert" className="text-sm text-red-600 sm:col-span-2 lg:col-span-3 dark:text-red-400">
                {t('separationBlocked')}
              </p>
            ) : null}
            {blocked && conversionIssues.length > 0 ? (
              <p role="alert" className="text-sm text-red-600 sm:col-span-2 lg:col-span-3 dark:text-red-400">
                {t('conversionsBlocked')}
              </p>
            ) : null}
            {serverError ? (
              <p role="alert" className="text-sm text-red-600 sm:col-span-2 lg:col-span-3 dark:text-red-400">
                {serverError}
              </p>
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
            <Detail
              label={t('unitConversions')}
              value={
                profile.unit_conversions && Object.keys(profile.unit_conversions).length > 0
                  ? Object.entries(profile.unit_conversions)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([unit, factor]) => `${unit} × ${String(factor)}`)
                      .join(', ')
                  : t('noConversions')
              }
            />
            <Detail label={t('assetAccount')} value={accountLabel(profile.asset_account_id)} />
            <Detail label={t('cogsAccount')} value={accountLabel(profile.cogs_account_id)} />
            <Detail label={t('adjustmentAccount')} value={accountLabel(profile.adjustment_account_id)} />
            <Detail label={t('receivedNotBilledAccount')} value={accountLabel(profile.received_not_billed_account_id)} />
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
