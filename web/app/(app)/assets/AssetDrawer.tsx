'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UrlDrawer,
} from '@openbooks/ui'
import { money } from '../../../lib/format'
import { confirmDialog } from '../../../lib/confirm'
import { DisposeButton } from './DisposeButton'
import { RemeasureButton } from './RemeasureButton'
import { DepreciationInputButton } from './DepreciationInputButton'
import type { AssetPayload } from '../../api/assets/_lib'

interface AccountOpt {
  id: string
  number?: string | null
  name?: string | null
}
interface CategoryOpt {
  id: string
  name: string
}
interface SubsidiaryOpt { id: string; name: string; depth: number }

const METHODS = ['straight_line', 'declining_balance', 'double_declining', 'units_of_production', 'manual'] as const
const CONVENTIONS = ['full_month', 'mid_month', 'half_year'] as const

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  in_service: 'success',
  fully_depreciated: 'secondary',
  draft: 'outline',
  disposed: 'warning',
  written_off: 'warning',
}

const field = 'space-y-1.5'

export function AssetDrawer({
  payload,
  categories,
  accounts,
  subsidiaries,
  canManage,
}: {
  payload: AssetPayload
  categories: CategoryOpt[]
  accounts: AccountOpt[]
  subsidiaries: SubsidiaryOpt[]
  canManage: boolean
}) {
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const a = payload.asset
  const isDraft = a.status === 'draft'
  // source platform-style record model: flyout ALWAYS opens READ-ONLY (view mode) —
  // even for drafts — with an Edit button. Draft/in_service are editable;
  // disposed/written_off are not. Save is EXPLICIT — one Save button.
  const canEditStatus = a.status === 'draft' || a.status === 'in_service'
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canEditStatus && canManage

  const isPlaceholderName = a.name === 'New asset'

  // -- form state ----------------------------------------------------------
  const [name, setName] = useState<string>(isPlaceholderName ? '' : (a.name ?? ''))
  const [assetNumber, setAssetNumber] = useState<string>(a.asset_number ?? '')
  const [description, setDescription] = useState<string>(a.description ?? '')
  const [categoryId, setCategoryId] = useState<string>(a.category_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState<string>(a.subsidiary_id ?? '')
  const [cost, setCost] = useState<string>(a.acquisition_cost != null ? String(a.acquisition_cost) : '')
  const [salvage, setSalvage] = useState<string>(a.salvage_value != null ? String(a.salvage_value) : '0.0000')
  const [acquiredOn, setAcquiredOn] = useState<string>(a.acquired_on ?? '')
  const [inServiceOn, setInServiceOn] = useState<string>(a.in_service_on ?? '')
  const [serialNumber, setSerialNumber] = useState<string>(a.serial_number ?? '')
  const [method, setMethod] = useState<string>(a.depreciation_method ?? payload.category?.default_method ?? 'straight_line')
  const [lifeMonths, setLifeMonths] = useState<string>(
    a.useful_life_months != null ? String(a.useful_life_months) : (payload.category?.default_life_months != null ? String(payload.category.default_life_months) : ''),
  )
  const [ratePercent, setRatePercent] = useState<string>(a.depreciation_rate_percent != null ? String(a.depreciation_rate_percent) : '')
  const [unitsTotal, setUnitsTotal] = useState<string>(a.depreciation_units_total != null ? String(a.depreciation_units_total) : '')
  const [convention, setConvention] = useState<string>(a.depreciation_convention ?? payload.category?.default_convention ?? 'full_month')
  const [assetAccountId, setAssetAccountId] = useState<string>(payload.accounts.assetAccountId ?? '')
  const [accumAccountId, setAccumAccountId] = useState<string>(payload.accounts.accumulatedDepreciationAccountId ?? '')
  const [expenseAccountId, setExpenseAccountId] = useState<string>(payload.accounts.depreciationExpenseAccountId ?? '')

  const [status, setStatus] = useState<string>(a.status)
  const [busy, setBusy] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [dirty, setDirty] = useState(false)

  const accountOptions = useMemo(
    () => accounts.map((x) => ({ value: x.id, label: `${x.number ?? ''} ${x.name ?? ''}`.trim() })),
    [accounts],
  )
  const subsidiaryOptions = useMemo(
    () => subsidiaries.map((x) => ({ value: x.id, label: `${'\u2003'.repeat(x.depth)}${x.name}` })),
    [subsidiaries],
  )

  const showRate = method === 'declining_balance'

  // -- dirty tracking (no autosave) ---------------------------------------
  const payloadBody = useMemo(
    () => ({
      name: name.trim() || 'New asset',
      assetNumber: assetNumber.trim(),
      description: description || null,
      categoryId: categoryId || null,
      subsidiaryId: subsidiaryId || null,
      acquisitionCost: cost || '0',
      salvageValue: salvage || '0',
      acquiredOn: acquiredOn || null,
      inServiceOn: inServiceOn || null,
      serialNumber: serialNumber || null,
      method,
      lifeMonths: lifeMonths || null,
      ratePercent: ratePercent || null,
      unitsTotal: unitsTotal || null,
      convention,
      assetAccountId: assetAccountId || null,
      accumulatedDepreciationAccountId: accumAccountId || null,
      depreciationExpenseAccountId: expenseAccountId || null,
    }),
    [name, assetNumber, description, categoryId, subsidiaryId, cost, salvage, acquiredOn, inServiceOn, serialNumber, method, lifeMonths, ratePercent, unitsTotal, convention, assetAccountId, accumAccountId, expenseAccountId],
  )
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadBody])

  function resetForm() {
    setName(isPlaceholderName ? '' : (a.name ?? ''))
    setAssetNumber(a.asset_number ?? '')
    setDescription(a.description ?? '')
    setCategoryId(a.category_id ?? '')
    setSubsidiaryId(a.subsidiary_id ?? '')
    setCost(a.acquisition_cost != null ? String(a.acquisition_cost) : '')
    setSalvage(a.salvage_value != null ? String(a.salvage_value) : '0.0000')
    setAcquiredOn(a.acquired_on ?? '')
    setInServiceOn(a.in_service_on ?? '')
    setSerialNumber(a.serial_number ?? '')
    setMethod(a.depreciation_method ?? payload.category?.default_method ?? 'straight_line')
    setLifeMonths(a.useful_life_months != null ? String(a.useful_life_months) : (payload.category?.default_life_months != null ? String(payload.category.default_life_months) : ''))
    setRatePercent(a.depreciation_rate_percent != null ? String(a.depreciation_rate_percent) : '')
    setUnitsTotal(a.depreciation_units_total != null ? String(a.depreciation_units_total) : '')
    setConvention(a.depreciation_convention ?? payload.category?.default_convention ?? 'full_month')
    setAssetAccountId(payload.accounts.assetAccountId ?? '')
    setAccumAccountId(payload.accounts.accumulatedDepreciationAccountId ?? '')
    setExpenseAccountId(payload.accounts.depreciationExpenseAccountId ?? '')
  }

  async function patch(extra: Record<string, unknown>) {
    const res = await fetch(`/api/assets/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payloadBody, ...extra }),
    })
    if (!res.ok) {
      const err = (await res.json()).error ?? t('drawer.saveFailed')
      throw new Error(err === 'invalid_subsidiary' ? t('errors.invalidSubsidiary') : err)
    }
    return res.json()
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    try {
      await patch({})
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } catch (e) {
      setSaveState('error')
      toast.error(e instanceof Error ? e.message : t('drawer.saveFailed'))
    }
    setBusy(false)
  }

  function cancel() {
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function placeInService() {
    setBusy(true)
    try {
      await patch({ status: 'in_service' })
      setStatus('in_service')
      setDirty(false)
      setMode('view')
      toast.success(t('status.in_service'))
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('drawer.saveFailed'))
    }
    setBusy(false)
  }

  async function runForAsset() {
    setBusy(true)
    const res = await fetch('/api/assets/run-depreciation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assetId: a.id }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('drawer.runFailed'))
    else if (data.posted > 0) toast.success(t('run.posted', { count: data.posted, amount: money(data.totalAmount) }))
    else toast.message(t('run.nothingDue'))
    setBusy(false)
    router.refresh()
  }

  async function remove() {
    if (
      !(await confirmDialog({
        title: t('drawer.deleteTitle'),
        message: t('drawer.deleteMessage'),
        confirmLabel: tCommon('actions.delete'),
        tone: 'danger',
      }))
    )
      return
    setBusy(true)
    const res = await fetch(`/api/assets/${a.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(t('drawer.deleted'))
      router.push('/assets')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('drawer.saveFailed'))
      setBusy(false)
    }
  }

  const displayName = (editable ? name.trim() : a.name) || t('drawer.newAsset')
  const hasAccountingEvidence = payload.schedule.some(
    (line) => line.postedAmount != null || line.input != null || line.source === 'imported',
  )

  return (
    <UrlDrawer
      open
      closeHref="/assets"
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">{assetNumber || a.asset_number}</span>
          <span>{displayName}</span>
          <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{t(`status.${status}`) ?? status}</Badge>
        </span>
      }
      description={mode === 'edit' ? t('drawer.editing') : (payload.category?.name ?? undefined)}
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tCommon('actions.cancel')}
              </Button>
            </>
          ) : (
            <>
              {canManage && canEditStatus ? (
                <Button variant="outline" onClick={() => setMode('edit')}>
                  {tCommon('actions.edit')}
                </Button>
              ) : null}
              {canManage && isDraft ? (
                <Button disabled={busy} onClick={placeInService}>
                  {t('drawer.placeInService')}
                </Button>
              ) : null}
              {canManage && status === 'in_service' ? (
                <Button variant="outline" disabled={busy} onClick={runForAsset}>
                  {t('drawer.runForAsset')}
                </Button>
              ) : null}
              {canManage && status === 'in_service' && (method === 'manual' || method === 'units_of_production') ? (
                <DepreciationInputButton assetId={a.id} method={method as 'manual' | 'units_of_production'} />
              ) : null}
              {canManage && status === 'in_service' ? (
                <RemeasureButton assetId={a.id} />
              ) : null}
              {canManage && (status === 'in_service' || status === 'fully_depreciated') ? (
                <DisposeButton assetId={a.id} accountOptions={accountOptions} />
              ) : null}
              {canManage && isDraft && !hasAccountingEvidence ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={remove}
                  className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  {tCommon('actions.delete')}
                </Button>
              ) : null}
            </>
          )}
        </>
      }
      footer={
        <div className="flex w-full items-center gap-3">
          <span
            className={
              'text-xs ' +
              (saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')
            }
          >
            {mode === 'edit'
              ? saveState === 'saving'
                ? tCommon('actions.saving')
                : dirty
                  ? t('drawer.unsavedChanges')
                  : null
              : null}
          </span>
          <span className="flex-1" />
          <span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">
            {t('labels.cost')} {money(a.acquisition_cost)} · {t('labels.accumulated')} {money(payload.totals.accumulated)} ·{' '}
            <strong className="text-slate-900 dark:text-slate-100">
              {t('labels.nbv')} {money(payload.totals.netBookValue)}
            </strong>
          </span>
        </div>
      }
    >
      <div className="space-y-7 p-1">
        {/* -- identity -------------------------------------------------- */}
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t('drawer.identity')}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={`${field} lg:col-span-2`}>
              <Label>
                {tCommon('labels.name')}
                {editable ? <span className="text-red-500"> *</span> : null}
              </Label>
              {editable ? (
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              ) : (
                <p className="text-sm">{a.name}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.number')}</Label>
              {editable ? (
                <Input value={assetNumber} onChange={(e) => setAssetNumber(e.target.value)} className="font-mono" />
              ) : (
                <p className="font-mono text-sm">{a.asset_number}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.category')}</Label>
              {editable ? (
                <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm">{payload.category?.name ?? '—'}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.serialNumber')}</Label>
              {editable ? (
                <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} />
              ) : (
                <p className="text-sm">{a.serial_number ?? '—'}</p>
              )}
            </div>
            {subsidiaries.length > 0 ? (
              <div className={field}>
                <Label>{tCommon('labels.subsidiary')}</Label>
                {editable ? (
                  <SearchSelect
                    value={subsidiaryId}
                    onChange={(value) => setSubsidiaryId(value ?? '')}
                    options={subsidiaryOptions}
                    ariaLabel={tCommon('labels.subsidiary')}
                  />
                ) : (
                  <p className="text-sm">{subsidiaryOptions.find((option) => option.value === subsidiaryId)?.label.trim() ?? '—'}</p>
                )}
              </div>
            ) : null}
            <div className={`${field} lg:col-span-3`}>
              <Label>{t('labels.description')}</Label>
              {editable ? (
                <Input value={description} onChange={(e) => setDescription(e.target.value)} />
              ) : (
                <p className="text-sm">{a.description ?? '—'}</p>
              )}
            </div>
          </div>
        </section>

        {/* -- depreciation --------------------------------------------- */}
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t('drawer.depreciation')}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className={field}>
              <Label>{t('labels.cost')}</Label>
              {editable ? (
                <Input inputMode="decimal" className="text-right tabular-nums" value={cost} onChange={(e) => setCost(e.target.value)} />
              ) : (
                <p className="text-right text-sm tabular-nums">{money(a.acquisition_cost)}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.salvage')}</Label>
              {editable ? (
                <Input inputMode="decimal" className="text-right tabular-nums" value={salvage} onChange={(e) => setSalvage(e.target.value)} />
              ) : (
                <p className="text-right text-sm tabular-nums">{money(a.salvage_value)}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.acquiredOn')}</Label>
              {editable ? (
                <Input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)} />
              ) : (
                <p className="text-sm">{a.acquired_on ?? '—'}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.inServiceOn')}</Label>
              {editable ? (
                <Input type="date" value={inServiceOn} onChange={(e) => setInServiceOn(e.target.value)} />
              ) : (
                <p className="text-sm">{a.in_service_on ?? '—'}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.method')}</Label>
              {editable ? (
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map((m) => (
                    <option key={m} value={m}>
                      {t(`methods.${m}`)}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm">{t(`methods.${method}`)}</p>
              )}
            </div>
            {method !== 'manual' && method !== 'units_of_production' ? (
              <div className={field}>
                <Label>{t('labels.lifeMonths')}</Label>
                {editable ? (
                  <Input inputMode="numeric" className="text-right tabular-nums" value={lifeMonths} onChange={(e) => setLifeMonths(e.target.value)} />
                ) : (
                  <p className="text-right text-sm tabular-nums">{lifeMonths || '—'}</p>
                )}
              </div>
            ) : null}
            {showRate ? (
              <div className={field}>
                <Label>{t('labels.ratePercent')}</Label>
                {editable ? (
                  <Input inputMode="decimal" className="text-right tabular-nums" value={ratePercent} onChange={(e) => setRatePercent(e.target.value)} />
                ) : (
                  <p className="text-right text-sm tabular-nums">{ratePercent || '—'}</p>
                )}
              </div>
            ) : null}
            {method === 'units_of_production' ? (
              <div className={field}>
                <Label>{t('labels.unitsTotal')}</Label>
                {editable ? (
                  <Input inputMode="decimal" className="text-right tabular-nums" value={unitsTotal} onChange={(e) => setUnitsTotal(e.target.value)} />
                ) : (
                  <p className="text-right text-sm tabular-nums">{unitsTotal || '—'}</p>
                )}
              </div>
            ) : null}
            {method !== 'manual' ? (
              <div className={field}>
                <Label>{t('labels.convention')}</Label>
                {editable ? (
                  <Select value={convention} onChange={(e) => setConvention(e.target.value)}>
                    {CONVENTIONS.map((item) => <option key={item} value={item}>{t(`conventions.${item}`)}</option>)}
                  </Select>
                ) : (
                  <p className="text-sm">{t(`conventions.${convention}`)}</p>
                )}
              </div>
            ) : null}
          </div>
        </section>

        {/* -- GL accounts ---------------------------------------------- */}
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t('drawer.accounts')}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={field}>
              <Label>{t('labels.assetAccount')}</Label>
              {editable ? (
                <SearchSelect
                  value={assetAccountId}
                  onChange={(v) => setAssetAccountId(v ?? '')}
                  options={accountOptions}
                  clearable
                  placeholder={t('drawer.selectAccount')}
                  ariaLabel={t('labels.assetAccount')}
                />
              ) : (
                <p className="text-sm">{payload.accountNames.asset ?? '—'}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.accumulatedAccount')}</Label>
              {editable ? (
                <SearchSelect
                  value={accumAccountId}
                  onChange={(v) => setAccumAccountId(v ?? '')}
                  options={accountOptions}
                  clearable
                  placeholder={t('drawer.selectAccount')}
                  ariaLabel={t('labels.accumulatedAccount')}
                />
              ) : (
                <p className="text-sm">{payload.accountNames.accumulated ?? '—'}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('labels.expenseAccount')}</Label>
              {editable ? (
                <SearchSelect
                  value={expenseAccountId}
                  onChange={(v) => setExpenseAccountId(v ?? '')}
                  options={accountOptions}
                  clearable
                  placeholder={t('drawer.selectAccount')}
                  ariaLabel={t('labels.expenseAccount')}
                />
              ) : (
                <p className="text-sm">{payload.accountNames.expense ?? '—'}</p>
              )}
            </div>
          </div>
        </section>

        {/* -- schedule ------------------------------------------------- */}
        <section>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t('drawer.schedule')}
          </h3>
          {payload.schedule.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('drawer.scheduleEmpty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('drawer.period')}</TableHead>
                  <TableHead className="text-right">{t('drawer.planned')}</TableHead>
                  <TableHead className="text-right">{t('drawer.postedAmount')}</TableHead>
                  <TableHead>{t('drawer.evidence')}</TableHead>
                  <TableHead className="text-right">{t('labels.accumulated')}</TableHead>
                  <TableHead className="text-right">{t('labels.nbv')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload.schedule.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-[13px]">
                      {s.journalEntryId ? (
                        <Link href={`/journal/${s.journalEntryId}`} className="text-teal-700 hover:underline dark:text-teal-300">
                          {s.periodName}
                        </Link>
                      ) : (
                        s.periodName
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(s.plannedAmount)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.postedAmount != null ? (
                        <Badge variant="success">{money(s.postedAmount)}</Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-56 text-xs">
                      {s.input ? (
                        <div>
                          <p className="font-medium text-slate-700 dark:text-slate-200">{s.input.evidenceReference}</p>
                          <p className="truncate text-slate-500 dark:text-slate-400">{s.input.memo}</p>
                          {s.input.productionUnits ? <p className="tabular-nums text-slate-500">{t('drawer.productionUnits', { units: s.input.productionUnits })}</p> : null}
                        </div>
                      ) : s.source === 'imported' ? (
                        <span className="text-slate-500 dark:text-slate-400">{t('drawer.importedEvidence')}</span>
                      ) : (
                        <span className="text-slate-400">{t('drawer.formulaGenerated')}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(s.accumulated)}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(s.netBookValue)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    </UrlDrawer>
  )
}
