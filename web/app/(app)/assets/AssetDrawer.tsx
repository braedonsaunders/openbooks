'use client'

import { useMoney } from '@/components/money-provider'
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  Input,
  Label,
  Popover,
  SearchSelect,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  UrlDrawer,
  cn,
} from '@openbooks/ui'
import { defaultFormLayout, type FormLayoutConfig, type HeaderFieldPlacement } from '@openbooks/customization'
import { CustomFieldInput } from '../../../components/custom-field-input'
import type { CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { AttachmentPanel } from '../../../components/attachment-panel'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { JournalEntryLink } from '../../../components/journal-entry-link'
import { confirmDialog } from '../../../lib/confirm'
import { DisposeButton } from './DisposeButton'
import { RemeasureButton } from './RemeasureButton'
import { DepreciationInputButton } from './DepreciationInputButton'
import type { AssetPayload } from '../../api/assets/_lib'

interface AccountOpt { id: string; number?: string | null; name?: string | null }
interface CategoryOpt { id: string; name: string }
interface SubsidiaryOpt { id: string; name: string; depth: number }
interface FormOpt { id: string; name: string }
interface DepreciationMethodOpt { id: string; code: string; name: string }
interface TaxConfiguration { code: string; name: string; class_attribute: string; classes: { code: string; name: string }[] }

const METHODS = ['straight_line', 'declining_balance', 'double_declining', 'units_of_production', 'manual'] as const
const CONVENTIONS = ['full_month', 'mid_month', 'half_year'] as const
type AssetTab = 'details' | 'tax' | 'schedule' | 'files'

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline'> = {
  in_service: 'success',
  fully_depreciated: 'secondary',
  draft: 'outline',
  disposed: 'warning',
  written_off: 'warning',
}

export function AssetDrawer({
  payload,
  categories,
  accounts,
  taxConfigurations,
  subsidiaries,
  canManage,
  canCustomize,
  layout,
  forms,
  currentFormId,
  fieldDefs,
  depreciationMethods,
}: {
  payload: AssetPayload
  categories: CategoryOpt[]
  accounts: AccountOpt[]
  taxConfigurations: TaxConfiguration[]
  subsidiaries: SubsidiaryOpt[]
  canManage: boolean
  canCustomize: boolean
  layout?: FormLayoutConfig
  forms: FormOpt[]
  currentFormId: string | null
  fieldDefs: CustomFieldDefClient[]
  depreciationMethods: DepreciationMethodOpt[]
}) {
  const { money } = useMoney()
  const t = useTranslations('assets')
  const tCommon = useTranslations('common')
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const currentParams = useMemo(() => Object.fromEntries(searchParams.entries()), [searchParams])

  const a = payload.asset
  const isDraft = a.status === 'draft'
  const canEditStatus = a.status === 'draft' || a.status === 'in_service'
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [tab, setTab] = useState<AssetTab>('details')
  const [actionsOpen, setActionsOpen] = useState(false)
  const editable = mode === 'edit' && canEditStatus && canManage
  const isPlaceholderName = a.name === 'New asset'

  const [name, setName] = useState(isPlaceholderName ? '' : (a.name ?? ''))
  const [assetNumber, setAssetNumber] = useState(a.asset_number ?? '')
  const [description, setDescription] = useState(a.description ?? '')
  const [categoryId, setCategoryId] = useState(a.category_id ?? '')
  const [subsidiaryId, setSubsidiaryId] = useState(a.subsidiary_id ?? '')
  const [cost, setCost] = useState(a.acquisition_cost != null ? String(a.acquisition_cost) : '')
  const [salvage, setSalvage] = useState(a.salvage_value != null ? String(a.salvage_value) : '0.0000')
  const [acquiredOn, setAcquiredOn] = useState(a.acquired_on ?? '')
  const [inServiceOn, setInServiceOn] = useState(a.in_service_on ?? '')
  const [serialNumber, setSerialNumber] = useState(a.serial_number ?? '')
  const [method, setMethod] = useState(a.depreciation_method ?? payload.category?.default_method ?? 'straight_line')
  const [depreciationMethodId, setDepreciationMethodId] = useState<string>(a.depreciation_method_id ?? payload.category?.default_depreciation_method_id ?? '')
  const [lifeMonths, setLifeMonths] = useState(
    a.useful_life_months != null ? String(a.useful_life_months) : (payload.category?.default_life_months != null ? String(payload.category.default_life_months) : ''),
  )
  const [ratePercent, setRatePercent] = useState(a.depreciation_rate_percent != null ? String(a.depreciation_rate_percent) : '')
  const [unitsTotal, setUnitsTotal] = useState(a.depreciation_units_total != null ? String(a.depreciation_units_total) : '')
  const [convention, setConvention] = useState(a.depreciation_convention ?? payload.category?.default_convention ?? 'full_month')
  const [assetAccountId, setAssetAccountId] = useState(payload.accounts.assetAccountId ?? '')
  const [accumAccountId, setAccumAccountId] = useState(payload.accounts.accumulatedDepreciationAccountId ?? '')
  const [expenseAccountId, setExpenseAccountId] = useState(payload.accounts.depreciationExpenseAccountId ?? '')
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(fieldDefs.map((def) => [def.key, (a.custom ?? {})[def.key]])),
  )
  const [taxValues, setTaxValues] = useState<Record<string, Record<string, unknown>>>(() => {
    const root = a.custom?.taxDepreciation
    return root && typeof root === 'object' && !Array.isArray(root) ? structuredClone(root) : {}
  })
  const [status, setStatus] = useState(a.status)
  const [busy, setBusy] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [dirty, setDirty] = useState(false)

  const effectiveLayout = layout ?? defaultFormLayout('fixed_asset')
  const customByKey = useMemo(() => new Map(fieldDefs.map((def) => [def.key, def])), [fieldDefs])
  const accountOptions = useMemo(
    () => accounts.map((x) => ({ value: x.id, label: `${x.number ?? ''} ${x.name ?? ''}`.trim() })),
    [accounts],
  )
  const subsidiaryOptions = useMemo(
    () => subsidiaries.map((x) => ({ value: x.id, label: `${'\u2003'.repeat(x.depth)}${x.name}` })),
    [subsidiaries],
  )
  const selectedMethodValue = depreciationMethodId ? `formula:${depreciationMethodId}` : `builtin:${method}`
  const selectedMethodLabel = depreciationMethodId
    ? depreciationMethods.find((item) => item.id === depreciationMethodId)?.name ?? t('drawer.unknownFormula')
    : t(`methods.${method}`)
  const inputSchedules = payload.books
    .filter((book): book is typeof book & { method: 'manual' | 'units_of_production' } =>
      !book.depreciationMethodId && (book.method === 'manual' || book.method === 'units_of_production'))
    .map((book) => ({ bookId: book.id, bookName: book.name, method: book.method }))

  function chooseMethod(value: string) {
    if (value.startsWith('formula:')) {
      setDepreciationMethodId(value.slice('formula:'.length))
      setMethod('straight_line')
    } else {
      setDepreciationMethodId('')
      setMethod(value.slice('builtin:'.length))
    }
  }

  const payloadBody = useMemo(() => ({
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
    depreciationMethodId: depreciationMethodId || null,
    lifeMonths: lifeMonths || null,
    ratePercent: ratePercent || null,
    unitsTotal: unitsTotal || null,
    convention,
    assetAccountId: assetAccountId || null,
    accumulatedDepreciationAccountId: accumAccountId || null,
    depreciationExpenseAccountId: expenseAccountId || null,
    custom: customValues,
    taxDepreciation: taxValues,
  }), [name, assetNumber, description, categoryId, subsidiaryId, cost, salvage, acquiredOn, inServiceOn, serialNumber, method, depreciationMethodId, lifeMonths, ratePercent, unitsTotal, convention, assetAccountId, accumAccountId, expenseAccountId, customValues, taxValues])

  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    if (editable) { setDirty(true); setSaveState('dirty') }
  }, [payloadBody, editable])

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
    setDepreciationMethodId(a.depreciation_method_id ?? payload.category?.default_depreciation_method_id ?? '')
    setLifeMonths(a.useful_life_months != null ? String(a.useful_life_months) : (payload.category?.default_life_months != null ? String(payload.category.default_life_months) : ''))
    setRatePercent(a.depreciation_rate_percent != null ? String(a.depreciation_rate_percent) : '')
    setUnitsTotal(a.depreciation_units_total != null ? String(a.depreciation_units_total) : '')
    setConvention(a.depreciation_convention ?? payload.category?.default_convention ?? 'full_month')
    setAssetAccountId(payload.accounts.assetAccountId ?? '')
    setAccumAccountId(payload.accounts.accumulatedDepreciationAccountId ?? '')
    setExpenseAccountId(payload.accounts.depreciationExpenseAccountId ?? '')
    setCustomValues(Object.fromEntries(fieldDefs.map((def) => [def.key, (a.custom ?? {})[def.key]])))
    const taxRoot = a.custom?.taxDepreciation
    setTaxValues(taxRoot && typeof taxRoot === 'object' && !Array.isArray(taxRoot) ? structuredClone(taxRoot) : {})
  }

  async function patchAsset(extra: Record<string, unknown>) {
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
    setBusy(true); setSaveState('saving')
    try {
      await patchAsset({})
      setSaveState('saved'); setDirty(false); setMode('view'); router.refresh()
    } catch (error) {
      setSaveState('error')
      toast.error(error instanceof Error ? error.message : t('drawer.saveFailed'))
    } finally { setBusy(false) }
  }

  function cancel() {
    resetForm(); setDirty(false); setSaveState('saved'); setMode('view')
  }

  async function placeInService() {
    setBusy(true)
    try {
      await patchAsset({ status: 'in_service' })
      setStatus('in_service'); setDirty(false); setMode('view')
      toast.success(t('status.in_service')); router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('drawer.saveFailed'))
    } finally { setBusy(false); setActionsOpen(false) }
  }

  async function runForAsset(bookId: string) {
    setBusy(true)
    try {
      const res = await fetch('/api/assets/run-depreciation', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: a.id, bookId }),
      })
      const data = await res.json()
      if (!res.ok) toast.error(data.error ?? t('drawer.runFailed'))
      else if (data.posted > 0) toast.success(t('run.posted', { count: data.posted, amount: money(data.totalAmount) }))
      else toast.message(t('run.nothingDue'))
      router.refresh()
    } finally { setBusy(false); setActionsOpen(false) }
  }

  async function remove() {
    if (!(await confirmDialog({
      title: t('drawer.deleteTitle'), message: t('drawer.deleteMessage'),
      confirmLabel: tCommon('actions.delete'), tone: 'danger',
    }))) return
    setBusy(true)
    const res = await fetch(`/api/assets/${a.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success(t('drawer.deleted')); router.push('/assets'); router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('drawer.saveFailed')); setBusy(false)
    }
  }

  function selectForm(formId: string) {
    const next = new URLSearchParams(searchParams.toString())
    if (formId) next.set('form', formId); else next.delete('form')
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    setActionsOpen(false)
  }

  const labelFor = (placement: HeaderFieldPlacement, fallback: string) => placement.labelOverride?.trim() || fallback
  const requiredFor = (placement: HeaderFieldPlacement, required = false) => required || placement.required === true
  const fieldLabel = (placement: HeaderFieldPlacement, fallback: string, required = false) => (
    <Label>{labelFor(placement, fallback)}{editable && requiredFor(placement, required) ? <span className="text-red-500"> *</span> : null}</Label>
  )
  const textValue = (value: unknown) => value == null || value === '' ? '—' : String(value)

  function renderAssetField(placement: HeaderFieldPlacement) {
    const key = placement.key
    if (key.startsWith('cf_')) {
      const def = customByKey.get(key.slice(3))
      if (!def) return null
      return <CustomFieldInput
        def={{ ...def, label: labelFor(placement, def.label), isRequired: requiredFor(placement, def.isRequired) }}
        value={customValues[def.key]}
        onChange={(value) => setCustomValues((current) => ({ ...current, [def.key]: value }))}
        readOnly={!editable}
      />
    }
    switch (key) {
      case 'name': return <>{fieldLabel(placement, tCommon('labels.name'), true)}{editable ? <Input value={name} onChange={(e) => setName(e.target.value)} /> : <p className="text-sm">{textValue(name)}</p>}</>
      case 'asset_number': return <>{fieldLabel(placement, t('labels.number'), true)}{editable ? <Input className="font-mono" value={assetNumber} onChange={(e) => setAssetNumber(e.target.value)} /> : <p className="font-mono text-sm">{textValue(assetNumber)}</p>}</>
      case 'status': return <>{fieldLabel(placement, tCommon('labels.status'))}<Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{t(`status.${status}`)}</Badge></>
      case 'category_id': return <>{fieldLabel(placement, t('labels.category'), true)}{editable ? <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</Select> : <p className="text-sm">{categories.find((category) => category.id === categoryId)?.name ?? '—'}</p>}</>
      case 'subsidiary_id': return subsidiaries.length === 0 ? null : <>{fieldLabel(placement, tCommon('labels.subsidiary'), true)}{editable ? <SearchSelect value={subsidiaryId} onChange={(value) => setSubsidiaryId(value ?? '')} options={subsidiaryOptions} ariaLabel={tCommon('labels.subsidiary')} /> : <p className="text-sm">{subsidiaryOptions.find((option) => option.value === subsidiaryId)?.label.trim() ?? '—'}</p>}</>
      case 'serial_number': return <>{fieldLabel(placement, t('labels.serialNumber'))}{editable ? <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} /> : <p className="text-sm">{textValue(serialNumber)}</p>}</>
      case 'description': return <>{fieldLabel(placement, t('labels.description'))}{editable ? <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /> : <p className="whitespace-pre-wrap text-sm">{textValue(description)}</p>}</>
      case 'acquisition_cost': return <>{fieldLabel(placement, t('labels.cost'), true)}{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={cost} onChange={(e) => setCost(e.target.value)} /> : <p className="text-right text-sm tabular-nums">{money(cost)}</p>}</>
      case 'salvage_value': return <>{fieldLabel(placement, t('labels.salvage'))}{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={salvage} onChange={(e) => setSalvage(e.target.value)} /> : <p className="text-right text-sm tabular-nums">{money(salvage)}</p>}</>
      case 'acquired_on': return <>{fieldLabel(placement, t('labels.acquiredOn'))}{editable ? <Input type="date" value={acquiredOn} onChange={(e) => setAcquiredOn(e.target.value)} /> : <p className="text-sm">{textValue(acquiredOn)}</p>}</>
      case 'in_service_on': return <>{fieldLabel(placement, t('labels.inServiceOn'))}{editable ? <Input type="date" value={inServiceOn} onChange={(e) => setInServiceOn(e.target.value)} /> : <p className="text-sm">{textValue(inServiceOn)}</p>}</>
      case 'depreciation_method': return <>{fieldLabel(placement, t('labels.method'))}{editable ? <Select value={selectedMethodValue} onChange={(e) => chooseMethod(e.target.value)}>{METHODS.map((item) => <option key={item} value={`builtin:${item}`}>{t(`methods.${item}`)}</option>)}{depreciationMethods.map((item) => <option key={item.id} value={`formula:${item.id}`}>{t('drawer.formulaMethod', { name: item.name })}</option>)}</Select> : <p className="text-sm">{selectedMethodLabel}</p>}</>
      case 'useful_life_months': return !depreciationMethodId && (method === 'manual' || method === 'units_of_production') ? null : <>{fieldLabel(placement, t('labels.lifeMonths'))}{editable ? <Input inputMode="numeric" className="text-right tabular-nums" value={lifeMonths} onChange={(e) => setLifeMonths(e.target.value)} /> : <p className="text-right text-sm tabular-nums">{textValue(lifeMonths)}</p>}</>
      case 'depreciation_rate_percent': return depreciationMethodId || method !== 'declining_balance' ? null : <>{fieldLabel(placement, t('labels.ratePercent'))}{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={ratePercent} onChange={(e) => setRatePercent(e.target.value)} /> : <p className="text-right text-sm tabular-nums">{textValue(ratePercent)}</p>}</>
      case 'depreciation_units_total': return depreciationMethodId || method !== 'units_of_production' ? null : <>{fieldLabel(placement, t('labels.unitsTotal'))}{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={unitsTotal} onChange={(e) => setUnitsTotal(e.target.value)} /> : <p className="text-right text-sm tabular-nums">{textValue(unitsTotal)}</p>}</>
      case 'depreciation_convention': return !depreciationMethodId && method === 'manual' ? null : <>{fieldLabel(placement, t('labels.convention'))}{editable ? <Select value={convention} onChange={(e) => setConvention(e.target.value)}>{CONVENTIONS.map((item) => <option key={item} value={item}>{t(`conventions.${item}`)}</option>)}</Select> : <p className="text-sm">{t(`conventions.${convention}`)}</p>}</>
      case 'asset_account_id': return <>{fieldLabel(placement, t('labels.assetAccount'))}{editable ? <SearchSelect value={assetAccountId} onChange={(value) => setAssetAccountId(value ?? '')} options={accountOptions} clearable placeholder={t('drawer.selectAccount')} ariaLabel={t('labels.assetAccount')} /> : <p className="text-sm">{payload.accountNames.asset ?? '—'}</p>}</>
      case 'accumulated_depreciation_account_id': return <>{fieldLabel(placement, t('labels.accumulatedAccount'))}{editable ? <SearchSelect value={accumAccountId} onChange={(value) => setAccumAccountId(value ?? '')} options={accountOptions} clearable placeholder={t('drawer.selectAccount')} ariaLabel={t('labels.accumulatedAccount')} /> : <p className="text-sm">{payload.accountNames.accumulated ?? '—'}</p>}</>
      case 'depreciation_expense_account_id': return <>{fieldLabel(placement, t('labels.expenseAccount'))}{editable ? <SearchSelect value={expenseAccountId} onChange={(value) => setExpenseAccountId(value ?? '')} options={accountOptions} clearable placeholder={t('drawer.selectAccount')} ariaLabel={t('labels.expenseAccount')} /> : <p className="text-sm">{payload.accountNames.expense ?? '—'}</p>}</>
      default: return null
    }
  }

  const hasAccountingEvidence = payload.hasAccountingEvidence
  const displayName = (editable ? name.trim() : a.name) || t('drawer.newAsset')
  const actionClass = 'justify-start'
  const setTaxValue = (regime: string, key: string, value: unknown) => setTaxValues((current) => ({
    ...current,
    [regime]: { ...(current[regime] ?? {}), [key]: value },
  }))

  return <UrlDrawer
    open
    closeHref="/assets"
    size="2xl"
    title={<span className="flex items-center gap-2.5"><span className="font-mono text-sm text-slate-500 dark:text-slate-400">{assetNumber || a.asset_number}</span><span>{displayName}</span><Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{t(`status.${status}`)}</Badge></span>}
    description={mode === 'edit' ? t('drawer.editing') : (payload.category?.name ?? undefined)}
    subtabs={<nav className="-mb-px flex gap-1" aria-label={t('drawer.tabsAria')}>
      {(['details', ...(taxConfigurations.length ? ['tax' as const] : []), 'schedule', 'files'] as const).map((item) => <button
        key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}
        className={cn('border-b-2 px-3 py-3 text-sm font-medium transition-colors', tab === item ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200')}
      >{item === 'details' ? tCommon('auditTrail.tabs.details') : item === 'tax' ? t('drawer.taxDepreciation') : item === 'files' ? tCommon('labels.attachments') : t('drawer.schedule')}</button>)}
    </nav>}
    headerActions={mode === 'edit' ? <div className="flex items-center gap-1.5">
      <Button size="sm" variant="outline" disabled={busy} onClick={cancel}>{tCommon('actions.cancel')}</Button>
      <Button size="sm" disabled={busy} onClick={save}>{busy ? tCommon('actions.saving') : tCommon('actions.save')}</Button>
    </div> : canManage || canCustomize ? <div className="flex items-center gap-1.5">
      {canManage && canEditStatus ? <Button variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={() => setMode('edit')}>{tCommon('actions.edit')}</Button> : null}
      <Popover open={actionsOpen} onOpenChange={setActionsOpen} align="end" className="w-64 p-1.5" trigger={<Button variant="outline" size="sm" className="h-8 gap-1.5 px-2.5 text-xs" onClick={() => setActionsOpen((open) => !open)} aria-expanded={actionsOpen}>{tCommon('labels.actions')}<ChevronDown className={cn('h-3.5 w-3.5 transition-transform', actionsOpen && 'rotate-180')} aria-hidden /></Button>}>
      {forms.length > 0 ? <div className="mb-1 border-b border-slate-200 p-2 dark:border-slate-800"><Label className="mb-1 block text-xs">{t('drawer.customForm')}</Label><Select value={currentFormId ?? ''} onChange={(event) => selectForm(event.target.value)}>{forms.map((form) => <option key={form.id} value={form.id}>{form.name}</option>)}</Select></div> : null}
      <div className="space-y-0.5 [&_button]:h-8 [&_button]:w-full [&_button]:justify-start [&_button]:rounded [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-2 [&_button]:text-xs [&_button]:shadow-none [&_button:hover]:bg-slate-100 dark:[&_button:hover]:bg-slate-800">
        {canManage && isDraft ? <Button variant="ghost" className={actionClass} disabled={busy} onClick={placeInService}>{t('drawer.placeInService')}</Button> : null}
        {canManage && status === 'in_service' ? payload.books.filter((book) => book.postsGl).map((book) => <Button key={book.id} variant="ghost" className={actionClass} disabled={busy} onClick={() => runForAsset(book.id)}>{t('drawer.runForBook', { book: book.name })}</Button>) : null}
        {canManage && status === 'in_service' && inputSchedules.length > 0 ? <DepreciationInputButton assetId={a.id} schedules={inputSchedules} /> : null}
        {canManage && status === 'in_service' ? <RemeasureButton assetId={a.id} /> : null}
        {canManage && (status === 'in_service' || status === 'fully_depreciated') ? <DisposeButton assetId={a.id} accountOptions={accountOptions} /> : null}
        {canCustomize ? <Button asChild variant="ghost"><Link href="/admin/customization?recordType=fixed_asset&tab=forms">{tCommon('actions.customize')}</Link></Button> : null}
        {canManage && isDraft && !hasAccountingEvidence ? <><div className="my-1 border-t border-slate-200 dark:border-slate-800" /><Button variant="ghost" disabled={busy} onClick={remove} className="text-red-600 dark:text-red-400">{tCommon('actions.delete')}</Button></> : null}
      </div>
      </Popover>
    </div> : undefined}
    footer={<div className="flex w-full items-center gap-3"><span className={cn('text-xs', saveState === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400')}>{mode === 'edit' ? saveState === 'saving' ? tCommon('actions.saving') : dirty ? t('drawer.unsavedChanges') : null : null}</span><span className="flex-1" /><span className="text-sm text-slate-600 tabular-nums dark:text-slate-300">{t('labels.cost')} {money(a.acquisition_cost)} · {t('labels.accumulated')} {money(payload.totals.accumulated)} · <strong className="text-slate-900 dark:text-slate-100">{t('labels.nbv')} {money(payload.totals.netBookValue)}</strong></span></div>}
  >
    {tab === 'details' ? <div className="p-1"><HeaderFields layout={effectiveLayout} editable={editable} renderField={renderAssetField} /></div> : null}
    {tab === 'tax' ? <div className="space-y-5 p-1">{taxConfigurations.map((config) => {
      const values = taxValues[config.code] ?? {}
      const categoryDefault = payload.category?.tax_attributes?.[config.class_attribute]
      return <section key={config.code} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">{config.name}</h3>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('drawer.taxCategoryDefault', { value: categoryDefault || t('drawer.notAssigned') })}</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>{t('drawer.taxClass')}</Label>{editable ? <Select value={String(values.classCode ?? '')} onChange={(event) => setTaxValue(config.code, 'classCode', event.target.value)}><option value="">{t('drawer.useCategoryDefault')}</option>{config.classes.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</Select> : <p className="text-sm">{String(values.classCode ?? categoryDefault ?? '—')}</p>}</div>
          <div className="space-y-1.5"><Label>{t('drawer.businessUsePercent')}</Label>{editable ? <Input inputMode="decimal" value={String(values.businessUsePercent ?? 100)} onChange={(event) => setTaxValue(config.code, 'businessUsePercent', event.target.value)} /> : <p className="text-sm tabular-nums">{String(values.businessUsePercent ?? 100)}%</p>}</div>
          {config.code === 'us_macrs' ? <>
            <div className="space-y-1.5"><Label>{t('drawer.section179')}</Label>{editable ? <Input inputMode="decimal" value={String(values.section179 ?? 0)} onChange={(event) => setTaxValue(config.code, 'section179', event.target.value)} /> : <p className="text-sm tabular-nums">{money(String(values.section179 ?? 0))}</p>}</div>
            <div className="space-y-1.5"><Label>{t('drawer.bonusPercent')}</Label>{editable ? <Input inputMode="decimal" value={String(values.bonusPercent ?? 0)} onChange={(event) => setTaxValue(config.code, 'bonusPercent', event.target.value)} /> : <p className="text-sm tabular-nums">{String(values.bonusPercent ?? 0)}%</p>}</div>
          </> : null}
        </div>
      </section>
    })}</div> : null}
    {tab === 'schedule' ? <div className="space-y-3 p-1">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput paramKey="deprq" pageParamKey="deprpage" placeholder={t('drawer.searchSchedule')} />
        <FilterChips basePath={pathname} currentParams={currentParams} paramKey="deprbook" pageParamKey="deprpage" label={t('run.book')} options={payload.books.map((book) => ({ value: book.id, label: book.name }))} />
      </div>
      {payload.schedule.length === 0 ? <p className="text-sm text-slate-500 dark:text-slate-400">{t('drawer.scheduleEmpty')}</p> : <Table>
      <TableHeader><TableRow><TableHead>{t('run.book')}</TableHead><TableHead>{t('drawer.period')}</TableHead><TableHead className="text-right">{t('drawer.planned')}</TableHead><TableHead className="text-right">{t('drawer.postedAmount')}</TableHead><TableHead>{t('drawer.evidence')}</TableHead><TableHead className="text-right">{t('labels.accumulated')}</TableHead><TableHead className="text-right">{t('labels.nbv')}</TableHead></TableRow></TableHeader>
      <TableBody>{payload.schedule.map((line) => <TableRow key={line.id}>
        <TableCell><Badge variant="outline">{line.bookCode}</Badge></TableCell>
        <TableCell className="font-mono text-[13px]">{line.journalEntryId ? <JournalEntryLink entryId={line.journalEntryId} className="text-teal-700 hover:underline dark:text-teal-300">{line.periodName}</JournalEntryLink> : line.periodName}</TableCell>
        <TableCell className="text-right tabular-nums">{money(line.plannedAmount)}</TableCell>
        <TableCell className="text-right tabular-nums">{line.postedAmount != null ? <Badge variant="success">{money(line.postedAmount)}</Badge> : <span className="text-slate-400">—</span>}</TableCell>
        <TableCell className="max-w-56 text-xs">{line.input ? <div><a href={`/api/file-cabinet/files/${line.input.evidenceFileId}/download`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">{line.input.evidenceFileName}</a><p className="truncate text-slate-500 dark:text-slate-400">{line.input.memo}</p>{line.input.productionUnits ? <p className="tabular-nums text-slate-500">{t('drawer.productionUnits', { units: line.input.productionUnits })}</p> : null}</div> : line.source === 'imported' ? <span className="text-slate-500 dark:text-slate-400">{t('drawer.importedEvidence')}</span> : <span className="text-slate-400">{t('drawer.formulaGenerated')}</span>}</TableCell>
        <TableCell className="text-right tabular-nums">{money(line.accumulated)}</TableCell><TableCell className="text-right tabular-nums">{money(line.netBookValue)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>}
      <Pagination basePath={pathname} currentParams={currentParams} total={payload.schedulePage.total} page={payload.schedulePage.page} perPage={payload.schedulePage.perPage} pageParamKey="deprpage" />
    </div> : null}
    {tab === 'files' ? <AttachmentPanel targetTable="fixed_assets" targetId={a.id} canEdit={canManage} /> : null}
  </UrlDrawer>
}
