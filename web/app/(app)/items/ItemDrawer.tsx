'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  BadgePercent,
  Boxes,
  BriefcaseBusiness,
  Calculator,
  CalendarOff,
  ChartNoAxesCombined,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Layers3,
  Package,
  PackageCheck,
  ReceiptText,
  Repeat2,
  Tags,
  Truck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Popover, SearchSelect, Select, UrlDrawer, cn } from '@openbooks/ui'
import {
  defaultFormLayout,
  isCustomTabKey,
  resolveFormTabs,
  type FormLayoutConfig,
  type HeaderFieldPlacement,
} from '@openbooks/customization'
import { CustomFieldInput } from '../../../components/custom-field-input'
import type { CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { HeaderFields } from '../../../components/transaction-form/header-fields'
import { ItemRatesEditor } from './ItemRatesEditor'
import { ItemPriceMatrixEditor } from './ItemPriceMatrixEditor'
import { ItemCostingEditor } from './ItemCostingEditor'
import { FairValuePricesEditor } from './FairValuePricesEditor'
import { ReadOnlyValue } from '../../../components/read-only-value'

interface AccountOpt {
  id: string
  number?: string | null
  name?: string | null
  type?: string | null
}

/**
 * Account types a service item may point its payroll costing at. Expense and
 * COGS cover the ordinary cases; asset_current_other covers capitalised
 * labour (every shipped inventory/WIP account carries exactly that type).
 * Mirrors PAYROLL_COSTING_ACCOUNT_TYPES in web/app/api/items/[id]/route.ts —
 * the server re-validates, so this filter is guidance, never a gate.
 */
const PAYROLL_COSTING_ACCOUNT_TYPES = new Set([
  'expense',
  'expense_other',
  'expense_deferred',
  'cogs',
  'asset_current_other',
])
interface TaxOpt {
  id: string
  name?: string | null
}
interface RuleOpt {
  id: string
  code?: string | null
  name?: string | null
}

const CREATE_PLANS_ON = ['billing', 'fulfillment', 'arrangement'] as const
const REVENUE_ALLOCATION = ['normal', 'exclude', 'software'] as const
/** The item row as the drawer reads it — column types per the `items`
 *  table (uuids as strings, numerics as ledger strings, `custom` parsed). */
interface ItemRecord {
  id: string
  kind: string
  code: string | null
  name: string
  category: string | null
  income_account_id: string | null
  expense_account_id: string | null
  payroll_expense_account_id: string | null
  deferred_account_id: string | null
  cost_recovery_account_id: string | null
  tax_code_id: string | null
  recognition_rule_id: string | null
  default_rate: string | null
  default_cost: string | null
  standalone_selling_price: string | null
  unit: string | null
  description: string | null
  show_on_timesheet: boolean
  is_active: boolean
  create_plans_on: string
  revenue_allocation: string
  custom: Record<string, unknown>
}
interface ItemPayload {
  item: ItemRecord
  incomeAccountName: string | null
  expenseAccountName: string | null
  payrollCostingAccountName: string | null
  taxCodeName: string | null
}

// item.kind enum values sent to the API — labels come from items.kinds.*
const KIND_VALUES = [
  'service',
  'non_inventory',
  'inventory',
  'assembly',
  'kit',
  'other_charge',
  'equipment_charge',
  'labor',
  'absence',
  'discount',
] as const
const INVENTORY_KINDS = new Set(['inventory', 'assembly', 'kit'])
const KIND_ICONS: Record<(typeof KIND_VALUES)[number], LucideIcon> = {
  service: BriefcaseBusiness,
  non_inventory: Package,
  inventory: Boxes,
  assembly: Layers3,
  kit: PackageCheck,
  other_charge: ReceiptText,
  equipment_charge: Truck,
  labor: Clock3,
  absence: CalendarOff,
  discount: BadgePercent,
}

const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'

/**
 * Keep database decimal text intact while loading an item into the form.
 * Numeric columns are returned as strings, and converting them through
 * Number/toFixed would silently discard valid four-decimal rates.
 */
export function preserveItemDecimal(value: unknown): string {
  return value == null ? '' : String(value)
}

type PricingView = 'landing' | 'simple' | 'matrix' | 'customer' | 'cost' | 'rules' | 'contract'

export function ItemDrawer({
  payload,
  accounts,
  taxCodes,
  fieldDefs,
  layout,
  recognitionRules = [],
  canManage,
  basePath = '/items',
  laborPricing = false,
  inventoryCosting = false,
  fairValuePrices = false,
  timeTracking = false,
  equipmentEnabled = false,
  subscriptionPricing = false,
  initialPricingView = 'landing',
  configuredPricingViews = [],
  createMode = false,
}: {
  payload: ItemPayload
  accounts: AccountOpt[]
  taxCodes: TaxOpt[]
  fieldDefs: CustomFieldDefClient[]
  /** Tenant-resolved form layout, including live custom fields and tabs. */
  layout?: FormLayoutConfig
  recognitionRules?: RuleOpt[]
  canManage: boolean
  basePath?: string
  /** Labor rate books — subordinate Projects capability. */
  laborPricing?: boolean
  /** Inventory costing profile — Inventory Features switch. */
  inventoryCosting?: boolean
  /** Standalone selling prices — Revenue Recognition Features switch. */
  fairValuePrices?: boolean
  /** Show-on-timesheet flag — Time Tracking Features switch. */
  timeTracking?: boolean
  /** Equipment-charge kind — Equipment Features switch. */
  equipmentEnabled?: boolean
  /** Recurring/usage pricing has its own contract lifecycle surface. */
  subscriptionPricing?: boolean
  /** Persisted items open in the editor selected by their active pricing data. */
  initialPricingView?: PricingView
  /**
   * Pricing modes this item already holds data in. Picking a pricing mode is
   * an edit, so the chooser only acts in edit mode; a read-only drawer still
   * opens a configured mode, because opening one is reading.
   */
  configuredPricingViews?: readonly PricingView[]
  /** True for `?item=new`: the payload is in-memory and Save performs POST. */
  createMode?: boolean
}) {
  const t = useTranslations('items')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const it = payload.item
  const requestIdRef = useRef<string | null>(null)

  const kindOptions = useMemo(
    () => KIND_VALUES
      .filter((k) => inventoryCosting || !INVENTORY_KINDS.has(k) || k === (it.kind ?? 'service'))
      .filter((k) => equipmentEnabled || k !== 'equipment_charge' || k === (it.kind ?? 'service'))
      .map((k) => ({ value: k, label: t(`kinds.${k}`) })),
    [t, inventoryCosting, equipmentEnabled, it.kind],
  )
  const kindLocked = !inventoryCosting && INVENTORY_KINDS.has(String(it.kind ?? ''))

  const [kind, setKind] = useState<string>(it.kind ?? 'service')
  const [name, setName] = useState<string>(it.name ?? '')
  const [description, setDescription] = useState<string>(it.description ?? '')
  const [code, setCode] = useState<string>(it.code ?? '')
  const [category, setCategory] = useState<string>(it.category ?? '')
  const [unit, setUnit] = useState<string>(it.unit ?? '')
  const [defaultRate, setDefaultRate] = useState<string>(
    preserveItemDecimal(it.default_rate),
  )
  const [defaultCost, setDefaultCost] = useState<string>(
    preserveItemDecimal(it.default_cost),
  )
  const [incomeAccountId, setIncomeAccountId] = useState<string>(it.income_account_id ?? '')
  const [expenseAccountId, setExpenseAccountId] = useState<string>(it.expense_account_id ?? '')
  const [payrollCostingAccountId, setPayrollCostingAccountId] = useState<string>(
    it.payroll_expense_account_id ?? '',
  )
  const [costRecoveryAccountId, setCostRecoveryAccountId] = useState<string>(it.cost_recovery_account_id ?? '')
  const [taxCodeId, setTaxCodeId] = useState<string>(it.tax_code_id ?? '')
  const [showOnTimesheet, setShowOnTimesheet] = useState<boolean>(it.show_on_timesheet === true)
  const [recognitionRuleId, setRecognitionRuleId] = useState<string>(it.recognition_rule_id ?? '')
  const [deferredAccountId, setDeferredAccountId] = useState<string>(it.deferred_account_id ?? '')
  const [createPlansOn, setCreatePlansOn] = useState<string>(it.create_plans_on ?? 'billing')
  const [revenueAllocation, setRevenueAllocation] = useState<string>(it.revenue_allocation ?? 'normal')
  const [standaloneSellingPrice, setStandaloneSellingPrice] = useState<string>(
    preserveItemDecimal(it.standalone_selling_price),
  )
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(it.custom ?? {})
  const [isActive, setIsActive] = useState<boolean>(createMode ? true : it.is_active === true)

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // Persisted records open read-only. A true create drawer is an in-memory
  // form and therefore starts editable; closing it cannot leave a draft row.
  const [mode, setMode] = useState<'view' | 'edit'>(createMode ? 'edit' : 'view')
  const [createStep, setCreateStep] = useState<'kind' | 'form'>(createMode ? 'kind' : 'form')
  const [tab, setTab] = useState<string>('overview')
  const [pricingView, setPricingView] = useState<PricingView>(initialPricingView)
  const [actionsOpen, setActionsOpen] = useState(false)
  const editable = mode === 'edit' && canManage
  // Choosing how an item is priced is a change to the item, so the chooser is
  // inert outside edit mode. A mode that already holds data stays reachable
  // read-only — the sub-editors take `canManage={editable}` and refuse writes.
  const pricingModeUnavailable = (view: PricingView) =>
    createMode || (!editable && !configuredPricingViews.includes(view))

  const nameValid = name.trim().length > 0

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
    [accounts],
  )
  // Where worked hours may land: expense, COGS, or capitalised-labour asset
  // accounts only. The server re-validates the type, so a stale or
  // cross-org option here can never persist.
  const payrollCostingOptions = useMemo(
    () =>
      accounts
        .filter((a) => a.type == null || PAYROLL_COSTING_ACCOUNT_TYPES.has(a.type))
        .map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
    [accounts],
  )
  const ruleOptions = useMemo(
    () => recognitionRules.map((r) => ({ value: r.id, label: `${r.code ? `${r.code} · ` : ''}${r.name ?? ''}`.trim() })),
    [recognitionRules],
  )

  // -- explicit save (no autosave) -------------------------------------------
  const savePayload = useMemo(
    () => ({
      ...(createMode
        ? { kind }
        : inventoryCosting || !INVENTORY_KINDS.has(kind)
          ? (equipmentEnabled || kind !== 'equipment_charge' ? { kind } : {})
        : {}),
      name: name.trim(),
      description,
      code,
      category,
      unit,
      defaultRate: defaultRate || null,
      defaultCost: defaultCost || null,
      incomeAccountId: incomeAccountId || null,
      expenseAccountId: expenseAccountId || null,
      payrollExpenseAccountId: payrollCostingAccountId || null,
      costRecoveryAccountId: costRecoveryAccountId || null,
      taxCodeId: taxCodeId || null,
      ...(timeTracking ? { showOnTimesheet } : {}),
      ...(fairValuePrices
        ? {
            recognitionRuleId: recognitionRuleId || null,
            deferredAccountId: deferredAccountId || null,
            createPlansOn,
            revenueAllocation,
            standaloneSellingPrice: standaloneSellingPrice || null,
          }
        : {}),
      custom: customValues,
      ...(createMode ? { isActive } : {}),
    }),
    [kind, name, description, code, category, unit, defaultRate, defaultCost, incomeAccountId, expenseAccountId, payrollCostingAccountId, costRecoveryAccountId, taxCodeId, showOnTimesheet, timeTracking, inventoryCosting, equipmentEnabled, fairValuePrices, recognitionRuleId, deferredAccountId, createPlansOn, revenueAllocation, standaloneSellingPrice, customValues, isActive, createMode],
  )
  // Track unsaved edits (no autosave — Save is an explicit button). Adjusted
  // during render (same committed value, no extra render).
  const [dirty, setDirty] = useState(false)
  const [prevSavePayload, setPrevSavePayload] = useState(savePayload)
  if (prevSavePayload !== savePayload) {
    setPrevSavePayload(savePayload)
    if (editable) setDirty(true)
  }

  /** Reset every field back to the loaded item (used by Cancel). */
  function resetForm() {
    setKind(it.kind ?? 'service')
    setName(it.name ?? '')
    setDescription(it.description ?? '')
    setCode(it.code ?? '')
    setCategory(it.category ?? '')
    setUnit(it.unit ?? '')
    setDefaultRate(preserveItemDecimal(it.default_rate))
    setDefaultCost(preserveItemDecimal(it.default_cost))
    setIncomeAccountId(it.income_account_id ?? '')
    setExpenseAccountId(it.expense_account_id ?? '')
    setPayrollCostingAccountId(it.payroll_expense_account_id ?? '')
    setCostRecoveryAccountId(it.cost_recovery_account_id ?? '')
    setTaxCodeId(it.tax_code_id ?? '')
    setShowOnTimesheet(it.show_on_timesheet === true)
    setRecognitionRuleId(it.recognition_rule_id ?? '')
    setDeferredAccountId(it.deferred_account_id ?? '')
    setCreatePlansOn(it.create_plans_on ?? 'billing')
    setRevenueAllocation(it.revenue_allocation ?? 'normal')
    setStandaloneSellingPrice(preserveItemDecimal(it.standalone_selling_price))
    setCustomValues(it.custom ?? {})
  }

  async function save() {
    if (!nameValid) return
    setBusy(true)
    setSaveState('saving')
    if (createMode && !requestIdRef.current) requestIdRef.current = crypto.randomUUID()
    const res = await fetch(createMode ? '/api/items' : `/api/items/${it.id}`, {
      method: createMode ? 'POST' : 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(createMode ? { 'Idempotency-Key': requestIdRef.current! } : {}),
      },
      body: JSON.stringify(savePayload),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null
      setSaveState('error')
      toast.error(data?.error ?? tCommon('feedback.saveFailed'))
      setBusy(false)
      return
    }
    const data = await res.json().catch(() => null) as ItemPayload | null
    const savedId = data?.item?.id
    setSaveState('saved')
    setDirty(false)
    if (createMode) {
      if (!savedId) {
        setSaveState('error')
        toast.error(tCommon('feedback.saveFailed'))
        setBusy(false)
        return
      }
      const separator = basePath.includes('?') ? '&' : '?'
      router.replace(`${basePath}${separator}item=${savedId}` as never)
    } else {
      setMode('view')
    }
    setBusy(false)
    router.refresh()
  }

  function cancel() {
    if (createMode) {
      router.push(basePath)
      return
    }
    resetForm()
    setDirty(false)
    setSaveState('saved')
    setMode('view')
  }

  async function setActiveState(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/items/${it.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => null) as { error?: string } | null
      toast.error(data?.error ?? t('drawer.updateFailed'))
    } else {
      setIsActive(next)
      toast.success(next ? t('drawer.activated') : t('drawer.deactivated'))
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !editable

  const effectiveLayout = layout ?? defaultFormLayout('item')
  const customFieldByPlacement = useMemo(
    () => new Map(fieldDefs.map((definition) => [`cf_${definition.key}`, definition])),
    [fieldDefs],
  )
  const claimedGroups = useMemo(
    () => new Set(
      (effectiveLayout.tabs ?? [])
        .filter((placement) => isCustomTabKey(placement.key))
        .flatMap((placement) => placement.groupIds ?? []),
    ),
    [effectiveLayout],
  )
  const standardLayout = useMemo<FormLayoutConfig>(() => ({
    ...effectiveLayout,
    header: {
      groups: effectiveLayout.header.groups.filter((group) => !claimedGroups.has(group.id)),
    },
  }), [effectiveLayout, claimedGroups])

  const layoutForKeys = (keys: ReadonlySet<string>, includeCustom = false): FormLayoutConfig => ({
    ...standardLayout,
    header: {
      groups: standardLayout.header.groups.map((group) => ({
        ...group,
        fields: group.fields.filter((placement) =>
          keys.has(placement.key) || (includeCustom && placement.key.startsWith('cf_')),
        ),
      })),
    },
  })

  const overviewLayout = layoutForKeys(new Set([
    'name', 'code', 'kind', 'category', 'unit', 'description', 'show_on_timesheet',
  ]), true)
  // Kind determines which pricing/costing controls and feature gates apply.
  // In create mode keep the tenant-resolved placement/label/width, but promote
  // this locked required field to the first (top-left) cell so the operator
  // chooses the record's accounting shape before filling dependent fields.
  const createOverviewLayout = useMemo<FormLayoutConfig>(() => {
    if (!createMode) return overviewLayout
    const groups = overviewLayout.header.groups.map((group) => ({
      ...group,
      fields: group.fields.filter((field) => field.key !== 'kind'),
    }))
    const placedKind = overviewLayout.header.groups
      .flatMap((group) => group.fields)
      .find((field) => field.key === 'kind') ?? { key: 'kind', visible: true }
    const target = groups.find((group) => group.fields.length > 0) ?? groups[0]
    if (target) target.fields = [{ ...placedKind, visible: true }, ...target.fields]
    return { ...overviewLayout, header: { groups } }
  }, [createMode, overviewLayout])
  const pricingLayout = layoutForKeys(new Set(['default_rate', 'default_cost']))
  const accountingLayout = layoutForKeys(new Set([
    'income_account_id', 'expense_account_id', 'payroll_expense_account_id',
    'cost_recovery_account_id', 'tax_code_id',
  ]))
  const revenueLayout = layoutForKeys(new Set([
    'recognition_rule_id', 'deferred_account_id', 'standalone_selling_price',
    'create_plans_on', 'revenue_allocation',
  ]))

  const tabs = useMemo(
    () => resolveFormTabs(effectiveLayout)
      .filter((placement) => placement.visible)
      .filter((placement) => placement.key !== 'costing' || (inventoryCosting && INVENTORY_KINDS.has(kind)))
      .filter((placement) => placement.key !== 'revenue' || fairValuePrices)
      .map((placement) => ({
        key: placement.key,
        groupIds: placement.groupIds ?? [],
        label: placement.labelOverride?.trim() || (
          isCustomTabKey(placement.key)
            ? placement.key.replace(/^tab_/, '').replace(/_/g, ' ')
            : t(`drawer.tabs.${placement.key}`)
        ),
      })),
    [effectiveLayout, inventoryCosting, fairValuePrices, kind, t],
  )
  const activeTab = tabs.find((candidate) => candidate.key === tab) ?? tabs[0] ?? null
  const activeTabKey = activeTab?.key ?? tab
  const choosingKind = createMode && createStep === 'kind'

  function renderItemField(placement: HeaderFieldPlacement): React.ReactNode {
    const label = placement.labelOverride?.trim() || undefined
    switch (placement.key) {
      case 'name':
        return <><Label>{label || tCommon('labels.name')}{editable ? <span className="text-red-500"> *</span> : null}</Label>{editable ? <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('drawer.namePlaceholder')} /> : <ReadOnlyValue value={name.trim() || t('drawer.newItem')} />}</>
      case 'code':
        return <><Label>{label || t('labels.code')}</Label>{editable ? <Input value={code} onChange={(event) => setCode(event.target.value)} className="font-mono" placeholder={t('drawer.codePlaceholder')} /> : <ReadOnlyValue value={code} className="font-mono" />}</>
      case 'kind':
        return <><Label>{label || t('labels.kind')}</Label>{editable && !kindLocked ? <Select value={kind} onChange={(event) => setKind(event.target.value)}>{kindOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select> : <ReadOnlyValue value={kindOptions.find((option) => option.value === kind)?.label ?? kind} />}</>
      case 'category':
        return <><Label>{label || t('labels.category')}</Label>{editable ? <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder={t('drawer.categoryPlaceholder')} /> : <ReadOnlyValue value={category} />}</>
      case 'unit':
        return <><Label>{label || t('labels.unit')}</Label>{editable ? <Input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder={t('drawer.unitPlaceholder')} /> : <ReadOnlyValue value={unit} />}</>
      case 'description':
        return <><Label>{label || tCommon('labels.description')}</Label>{editable ? <Input value={description} onChange={(event) => setDescription(event.target.value)} /> : <ReadOnlyValue value={description} />}</>
      case 'default_rate':
        return <><Label>{label || t('labels.defaultRate')}</Label>{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={defaultRate} onChange={(event) => setDefaultRate(event.target.value)} /> : <ReadOnlyValue value={defaultRate} className="text-right tabular-nums" />}</>
      case 'default_cost':
        return <><Label>{label || t('labels.defaultCost')}</Label>{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={defaultCost} onChange={(event) => setDefaultCost(event.target.value)} /> : <ReadOnlyValue value={defaultCost} className="text-right tabular-nums" />}</>
      case 'income_account_id':
        return <><Label>{label || t('labels.incomeAccount')}</Label>{editable ? <SearchSelect value={incomeAccountId} onChange={setIncomeAccountId} options={accountOptions} clearable emptyLabel={t('drawer.noIncomeAccount')} placeholder={t('drawer.selectAccount')} sheetTitle={t('labels.incomeAccount')} ariaLabel={t('labels.incomeAccount')} /> : <ReadOnlyValue value={accountOptions.find((option) => option.value === incomeAccountId)?.label ?? payload.incomeAccountName} />}</>
      case 'expense_account_id':
        return <><Label>{label || t('labels.expenseAccount')}</Label>{editable ? <SearchSelect value={expenseAccountId} onChange={setExpenseAccountId} options={accountOptions} clearable emptyLabel={t('drawer.noExpenseAccount')} placeholder={t('drawer.selectAccount')} sheetTitle={t('labels.expenseAccount')} ariaLabel={t('labels.expenseAccount')} /> : <ReadOnlyValue value={accountOptions.find((option) => option.value === expenseAccountId)?.label ?? payload.expenseAccountName} />}</>
      case 'payroll_expense_account_id':
        return <><Label>{label || t('labels.payrollCostingAccount')}</Label>{editable ? <SearchSelect value={payrollCostingAccountId} onChange={setPayrollCostingAccountId} options={payrollCostingOptions} clearable emptyLabel={t('drawer.noPayrollCostingAccount')} placeholder={t('drawer.selectAccount')} sheetTitle={t('labels.payrollCostingAccount')} ariaLabel={t('labels.payrollCostingAccount')} /> : <ReadOnlyValue value={payrollCostingOptions.find((option) => option.value === payrollCostingAccountId)?.label ?? payload.payrollCostingAccountName} />}</>
      case 'cost_recovery_account_id':
        return <><Label>{label || t('labels.recoveryAccount')}</Label>{editable ? <SearchSelect value={costRecoveryAccountId} onChange={setCostRecoveryAccountId} options={accountOptions} clearable emptyLabel={t('drawer.noRecoveryAccount')} placeholder={t('drawer.selectAccount')} sheetTitle={t('labels.recoveryAccount')} ariaLabel={t('labels.recoveryAccount')} /> : <ReadOnlyValue value={accountOptions.find((option) => option.value === costRecoveryAccountId)?.label} />}</>
      case 'tax_code_id':
        return <><Label>{label || t('labels.taxCode')}</Label>{editable ? <Select value={taxCodeId} onChange={(event) => setTaxCodeId(event.target.value)}><option value="">—</option>{taxCodes.map((taxCode) => <option key={taxCode.id} value={taxCode.id}>{taxCode.name}</option>)}</Select> : <ReadOnlyValue value={taxCodes.find((taxCode) => taxCode.id === taxCodeId)?.name ?? payload.taxCodeName} />}</>
      case 'show_on_timesheet':
        if (!timeTracking) return null
        return <><Label>{label || t('drawer.showOnTimesheet')}</Label>{editable ? <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" checked={showOnTimesheet} onChange={(event) => setShowOnTimesheet(event.target.checked)} className={checkboxClass} />{showOnTimesheet ? tCommon('labels.yes') : tCommon('labels.no')}</label> : <ReadOnlyValue value={showOnTimesheet ? tCommon('labels.yes') : tCommon('labels.no')} />}</>
      case 'recognition_rule_id':
        if (!fairValuePrices) return null
        return <><Label>{label || t('revrec.rule')}</Label>{editable ? <SearchSelect value={recognitionRuleId} onChange={setRecognitionRuleId} options={ruleOptions} clearable emptyLabel={t('revrec.noRule')} placeholder={t('revrec.selectRule')} sheetTitle={t('revrec.rule')} ariaLabel={t('revrec.rule')} /> : <ReadOnlyValue value={ruleOptions.find((option) => option.value === recognitionRuleId)?.label ?? t('revrec.noRule')} />}</>
      case 'deferred_account_id':
        if (!fairValuePrices) return null
        return <><Label>{label || t('revrec.deferredAccount')}</Label>{editable ? <SearchSelect value={deferredAccountId} onChange={setDeferredAccountId} options={accountOptions} clearable emptyLabel={t('revrec.ruleDefault')} placeholder={t('drawer.selectAccount')} sheetTitle={t('revrec.deferredAccount')} ariaLabel={t('revrec.deferredAccount')} /> : <ReadOnlyValue value={accountOptions.find((option) => option.value === deferredAccountId)?.label ?? t('revrec.ruleDefault')} />}</>
      case 'standalone_selling_price':
        if (!fairValuePrices) return null
        return <><Label>{label || t('revrec.standaloneSellingPrice')}</Label>{editable ? <Input inputMode="decimal" className="text-right tabular-nums" value={standaloneSellingPrice} onChange={(event) => setStandaloneSellingPrice(event.target.value)} /> : <ReadOnlyValue value={standaloneSellingPrice} className="text-right tabular-nums" />}</>
      case 'create_plans_on':
        if (!fairValuePrices) return null
        return <><Label>{label || t('revrec.createPlansOn')}</Label>{editable ? <Select value={createPlansOn} onChange={(event) => setCreatePlansOn(event.target.value)}>{CREATE_PLANS_ON.map((option) => <option key={option} value={option}>{t(`revrec.createPlansOnOptions.${option}`)}</option>)}</Select> : <ReadOnlyValue value={t(`revrec.createPlansOnOptions.${createPlansOn}`)} />}</>
      case 'revenue_allocation':
        if (!fairValuePrices) return null
        return <><Label>{label || t('revrec.allocation')}</Label>{editable ? <Select value={revenueAllocation} onChange={(event) => setRevenueAllocation(event.target.value)}>{REVENUE_ALLOCATION.map((option) => <option key={option} value={option}>{t(`revrec.allocationOptions.${option}`)}</option>)}</Select> : <ReadOnlyValue value={t(`revrec.allocationOptions.${revenueAllocation}`)} />}</>
      default: {
        const definition = customFieldByPlacement.get(placement.key)
        if (!definition) return null
        const overridden = {
          ...definition,
          ...(label ? { label } : {}),
          ...(placement.required === true ? { isRequired: true } : {}),
        }
        return <CustomFieldInput def={overridden} value={customValues[definition.key]} onChange={(value) => setCustomValues({ ...customValues, [definition.key]: value })} readOnly={ro} />
      }
    }
  }

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      syncUrlOnClose
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{choosingKind ? t('drawer.chooseKindTitle') : name.trim() || t('drawer.newItem')}</span>
          {!choosingKind ? (
            <Badge variant={isActive ? 'success' : 'outline'}>
              {isActive ? tCommon('status.active') : tCommon('status.inactive')}
            </Badge>
          ) : null}
        </span>
      }
      description={choosingKind ? t('drawer.chooseKindDescription') : mode === 'edit' ? tCommon('feedback.editingHint') : undefined}
      subtabs={
        choosingKind ? undefined : <nav className="-mb-px flex flex-wrap gap-1" aria-label={tCommon('auditTrail.ariaLabel')}>
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={activeTabKey === item.key}
              onClick={() => setTab(item.key)}
              className={cn(
                'border-b-2 px-3 py-3 text-sm font-medium transition-colors',
                activeTabKey === item.key
                  ? 'border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200',
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      }
      headerActions={
        <>
          {choosingKind ? (
            <Button variant="outline" disabled={busy} onClick={cancel}>
              {tCommon('actions.cancel')}
            </Button>
          ) : mode === 'edit' ? (
            <>
              {createMode ? (
                <Button variant="outline" disabled={busy} onClick={() => setCreateStep('kind')}>
                  {tCommon('actions.back')}
                </Button>
              ) : null}
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tCommon('actions.cancel')}
              </Button>
              <Button disabled={busy || !nameValid} onClick={save}>
                {busy ? tCommon('actions.saving') : createMode ? tCommon('actions.create') : tCommon('actions.save')}
              </Button>
            </>
          ) : canManage ? (
            <div className="flex items-center gap-1.5">
              <Button variant="outline" onClick={() => { setTab('overview'); setMode('edit') }}>
                {tCommon('actions.edit')}
              </Button>
              <Popover open={actionsOpen} onOpenChange={setActionsOpen} align="end" className="w-52 p-1.5" trigger={<Button variant="outline" onClick={() => setActionsOpen((open) => !open)}>{tCommon('labels.actions')}<ChevronDown className="ml-1 h-3.5 w-3.5" /></Button>}>
                <div className="space-y-0.5 [&_button]:w-full [&_button]:justify-start">
                  {isActive ? <Button variant="ghost" disabled={busy} onClick={() => { setActionsOpen(false); void setActiveState(false) }}>{t('drawer.deactivate')}</Button> : <Button variant="ghost" disabled={busy || !nameValid} onClick={() => { setActionsOpen(false); void setActiveState(true) }}>{t('drawer.activate')}</Button>}
                  {!isActive && !nameValid ? <p className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400">{t('drawer.nameToActivate')}</p> : null}
                </div>
              </Popover>
            </div>
          ) : null}
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
                : saveState === 'error'
                  ? t('drawer.saveFailedRetry')
                  : dirty
                    ? t('drawer.unsavedChanges')
                    : null
              : null}
          </span>
        </div>
      }
    >
      <div className="space-y-7 p-1">
        {choosingKind ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {kindOptions.map((option) => {
              const Icon = KIND_ICONS[option.value as (typeof KIND_VALUES)[number]]
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => { setKind(option.value); setTab('overview'); setCreateStep('form') }}
                  className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600"
                >
                  <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-teal-50 text-teal-700 transition-colors group-hover:bg-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:group-hover:bg-teal-900/70">
                    <Icon size={22} />
                  </span>
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{option.label}</span>
                  <span className="mt-1.5 block text-sm leading-5 text-slate-500 dark:text-slate-400">
                    {t(`kindDescriptions.${option.value}`)}
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}

        {!choosingKind && activeTabKey === 'overview' ? <HeaderFields layout={createOverviewLayout} editable={editable} renderField={renderItemField} /> : null}

        {!choosingKind && activeTabKey === 'pricing' && pricingView === 'landing' ? (
          <section className="space-y-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('pricingModes.title')}</h3>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('pricingModes.description')}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              <button
                type="button"
                disabled={pricingModeUnavailable('simple')}
                onClick={() => setPricingView('simple')}
                className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600"
              >
                <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-teal-50 text-teal-700 transition-colors group-hover:bg-teal-100 dark:bg-teal-950/60 dark:text-teal-300 dark:group-hover:bg-teal-900/70">
                  <CircleDollarSign size={22} />
                </span>
                <span className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('pricingModes.simpleTitle')}</span>
                  <Badge variant="secondary">{t('pricingModes.recommended')}</Badge>
                </span>
                <span className="mt-2 block text-sm leading-5 text-slate-500 dark:text-slate-400">{t('pricingModes.simpleDescription')}</span>
                <span className="mt-4 block border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">{t('pricingModes.simpleDetail')}</span>
              </button>
              <button
                type="button"
                disabled={pricingModeUnavailable('matrix')}
                onClick={() => setPricingView('matrix')}
                className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:border-slate-200 disabled:hover:shadow-sm dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600 dark:disabled:hover:border-slate-800"
              >
                <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-violet-50 text-violet-700 transition-colors group-hover:bg-violet-100 dark:bg-violet-950/60 dark:text-violet-300 dark:group-hover:bg-violet-900/70">
                  <ChartNoAxesCombined size={22} />
                </span>
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t('pricingModes.matrixTitle')}</span>
                <span className="mt-2 block text-sm leading-5 text-slate-500 dark:text-slate-400">{t('pricingModes.matrixDescription')}</span>
                <span className="mt-4 block border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  {createMode ? t('pricingModes.saveFirst') : t('pricingModes.matrixDetail')}
                </span>
              </button>
              {[
                { key: 'customer' as const, icon: UsersRound, title: 'customerTitle', description: 'customerDescription', detail: 'customerDetail' },
                { key: 'cost' as const, icon: Calculator, title: 'costTitle', description: 'costDescription', detail: 'costDetail' },
                { key: 'rules' as const, icon: Tags, title: 'rulesTitle', description: 'rulesDescription', detail: 'rulesDetail' },
              ].map((option) => {
                const Icon = option.icon
                return <button key={option.key} type="button" disabled={pricingModeUnavailable(option.key)} onClick={() => setPricingView(option.key)} className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600">
                  <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300"><Icon size={22} /></span>
                  <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`pricingModes.${option.title}`)}</span>
                  <span className="mt-2 block text-sm leading-5 text-slate-500 dark:text-slate-400">{t(`pricingModes.${option.description}`)}</span>
                  <span className="mt-4 block border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">{createMode ? t('pricingModes.saveFirst') : t(`pricingModes.${option.detail}`)}</span>
                </button>
              })}
              <button type="button" disabled={!laborPricing || pricingModeUnavailable('contract')} onClick={() => setPricingView('contract')} className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600">
                <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300"><Tags size={22} /></span>
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t('pricingModes.contractTitle')}</span>
                <span className="mt-2 block text-sm leading-5 text-slate-500 dark:text-slate-400">{t('pricingModes.contractDescription')}</span>
                <span className="mt-4 block border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">{createMode ? t('pricingModes.saveFirst') : laborPricing ? t('pricingModes.contractDetail') : t('pricingModes.featureRequired')}</span>
              </button>
              <button type="button" disabled={!subscriptionPricing || createMode} onClick={() => router.push('/collections')} className="group rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-teal-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-800 dark:bg-slate-950 dark:hover:border-teal-600">
                <span className="mb-4 grid h-11 w-11 place-items-center rounded-xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"><Repeat2 size={22} /></span>
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t('pricingModes.subscriptionTitle')}</span>
                <span className="mt-2 block text-sm leading-5 text-slate-500 dark:text-slate-400">{t('pricingModes.subscriptionDescription')}</span>
                <span className="mt-4 block border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">{createMode ? t('pricingModes.saveFirst') : subscriptionPricing ? t('pricingModes.subscriptionDetail') : t('pricingModes.subscriptionRequired')}</span>
              </button>
            </div>
          </section>
        ) : null}

        {!choosingKind && activeTabKey === 'pricing' && pricingView !== 'landing' ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setPricingView('landing')}>
            {t('pricingModes.back')}
          </Button>
        ) : null}

        {!choosingKind && activeTabKey === 'pricing' && pricingView === 'simple' ? <HeaderFields layout={pricingLayout} editable={editable} renderField={renderItemField} /> : null}

        {!choosingKind && activeTabKey === 'pricing' && ['matrix', 'customer', 'cost', 'rules'].includes(pricingView) && !createMode ? (
          <ItemPriceMatrixEditor itemId={String(it.id)} canManage={editable} />
        ) : null}

        {!choosingKind && activeTabKey === 'pricing' && pricingView === 'contract' && laborPricing && !createMode ? (
          <ItemRatesEditor
            itemId={String(it.id)}
            itemPrice={defaultRate}
            itemCost={defaultCost}
            itemKind={kind}
            itemUnit={unit}
            canManage={editable}
          />
        ) : null}

        {!choosingKind && activeTabKey === 'costing' && inventoryCosting && !createMode ? (
          <ItemCostingEditor key={String(it.id)} itemId={String(it.id)} kind={kind} accounts={accounts} canManage={editable} />
        ) : null}

        {!choosingKind && activeTabKey === 'accounting' ? <HeaderFields layout={accountingLayout} editable={editable} renderField={renderItemField} /> : null}
        {!choosingKind && activeTabKey === 'revenue' && fairValuePrices ? <HeaderFields layout={revenueLayout} editable={editable} renderField={renderItemField} /> : null}
        {!choosingKind && activeTabKey === 'revenue' && fairValuePrices && !createMode ? (
          <FairValuePricesEditor itemId={String(it.id)} canManage={editable} />
        ) : null}

        {!choosingKind && activeTab && isCustomTabKey(activeTab.key) ? (
          <HeaderFields
            layout={{
              ...effectiveLayout,
              header: {
                groups: effectiveLayout.header.groups.filter((group) => activeTab.groupIds.includes(group.id)),
              },
            }}
            editable={editable}
            renderField={renderItemField}
          />
        ) : null}
      </div>
    </UrlDrawer>
  )
}
