'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Popover, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import { ItemRatesEditor } from './ItemRatesEditor'
import { ItemCostingEditor } from './ItemCostingEditor'
import { FairValuePricesEditor } from './FairValuePricesEditor'
import { ReadOnlyValue } from '../../../components/read-only-value'

interface AccountOpt {
  id: string
  number?: string | null
  name?: string | null
}
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
interface ItemPayload {
  item: Record<string, any>
  incomeAccountName: string | null
  expenseAccountName: string | null
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

const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500'
const field = 'space-y-1.5'

export function ItemDrawer({
  payload,
  accounts,
  taxCodes,
  fieldDefs,
  recognitionRules = [],
  canManage,
  basePath = '/items',
  laborPricing = false,
  inventoryCosting = false,
  fairValuePrices = false,
  timeTracking = false,
}: {
  payload: ItemPayload
  accounts: AccountOpt[]
  taxCodes: TaxOpt[]
  fieldDefs: CustomFieldDefClient[]
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
}) {
  const t = useTranslations('items')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const it = payload.item
  // 'New item' is the server-side draft sentinel stored in the DB — compared
  // and saved verbatim; only its *display* goes through the catalog.
  const isPlaceholderName = it.name === 'New item'

  const kindOptions = useMemo(
    () => KIND_VALUES.map((k) => ({ value: k, label: t(`kinds.${k}`) })),
    [t],
  )

  const [kind, setKind] = useState<string>(it.kind ?? 'service')
  const [name, setName] = useState<string>(isPlaceholderName ? '' : (it.name ?? ''))
  const [description, setDescription] = useState<string>(it.description ?? '')
  const [code, setCode] = useState<string>(it.code ?? '')
  const [category, setCategory] = useState<string>(it.category ?? '')
  const [unit, setUnit] = useState<string>(it.unit ?? '')
  const [defaultRate, setDefaultRate] = useState<string>(
    it.default_rate != null ? Number(it.default_rate).toFixed(2) : '',
  )
  const [defaultCost, setDefaultCost] = useState<string>(
    it.default_cost != null ? Number(it.default_cost).toFixed(2) : '',
  )
  const [incomeAccountId, setIncomeAccountId] = useState<string>(it.income_account_id ?? '')
  const [expenseAccountId, setExpenseAccountId] = useState<string>(it.expense_account_id ?? '')
  const [costRecoveryAccountId, setCostRecoveryAccountId] = useState<string>(it.cost_recovery_account_id ?? '')
  const [taxCodeId, setTaxCodeId] = useState<string>(it.tax_code_id ?? '')
  const [showOnTimesheet, setShowOnTimesheet] = useState<boolean>(it.show_on_timesheet === true)
  const [recognitionRuleId, setRecognitionRuleId] = useState<string>(it.recognition_rule_id ?? '')
  const [deferredAccountId, setDeferredAccountId] = useState<string>(it.deferred_account_id ?? '')
  const [createPlansOn, setCreatePlansOn] = useState<string>(it.create_plans_on ?? 'billing')
  const [revenueAllocation, setRevenueAllocation] = useState<string>(it.revenue_allocation ?? 'normal')
  const [standaloneSellingPrice, setStandaloneSellingPrice] = useState<string>(
    it.standalone_selling_price != null ? Number(it.standalone_selling_price).toFixed(2) : '',
  )
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(it.custom ?? {})
  const [isActive, setIsActive] = useState<boolean>(it.is_active === true)

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // source platform-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Save is EXPLICIT —
  // one Save button, no per-field autosave.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [actionsOpen, setActionsOpen] = useState(false)
  const editable = mode === 'edit' && canManage

  const nameValid = name.trim().length > 0 && name.trim() !== 'New item'

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
    [accounts],
  )
  const ruleOptions = useMemo(
    () => recognitionRules.map((r) => ({ value: r.id, label: `${r.code ? `${r.code} · ` : ''}${r.name ?? ''}`.trim() })),
    [recognitionRules],
  )

  // -- explicit save (no autosave) -------------------------------------------
  const savePayload = useMemo(
    () => ({
      kind,
      name: name.trim() || (isActive ? name : 'New item'),
      description,
      code,
      category,
      unit,
      defaultRate: defaultRate || null,
      defaultCost: defaultCost || null,
      incomeAccountId: incomeAccountId || null,
      expenseAccountId: expenseAccountId || null,
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
    }),
    [kind, name, description, code, category, unit, defaultRate, defaultCost, incomeAccountId, expenseAccountId, costRecoveryAccountId, taxCodeId, showOnTimesheet, timeTracking, fairValuePrices, recognitionRuleId, deferredAccountId, createPlansOn, revenueAllocation, standaloneSellingPrice, customValues, isActive],
  )
  // Track unsaved edits (no autosave — Save is an explicit button).
  const [dirty, setDirty] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (editable) setDirty(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload])

  /** Reset every field back to the loaded item (used by Cancel). */
  function resetForm() {
    setKind(it.kind ?? 'service')
    setName(isPlaceholderName ? '' : (it.name ?? ''))
    setDescription(it.description ?? '')
    setCode(it.code ?? '')
    setCategory(it.category ?? '')
    setUnit(it.unit ?? '')
    setDefaultRate(it.default_rate != null ? Number(it.default_rate).toFixed(2) : '')
    setDefaultCost(it.default_cost != null ? Number(it.default_cost).toFixed(2) : '')
    setIncomeAccountId(it.income_account_id ?? '')
    setExpenseAccountId(it.expense_account_id ?? '')
    setCostRecoveryAccountId(it.cost_recovery_account_id ?? '')
    setTaxCodeId(it.tax_code_id ?? '')
    setShowOnTimesheet(it.show_on_timesheet === true)
    setRecognitionRuleId(it.recognition_rule_id ?? '')
    setDeferredAccountId(it.deferred_account_id ?? '')
    setCreatePlansOn(it.create_plans_on ?? 'billing')
    setRevenueAllocation(it.revenue_allocation ?? 'normal')
    setStandaloneSellingPrice(it.standalone_selling_price != null ? Number(it.standalone_selling_price).toFixed(2) : '')
    setCustomValues(it.custom ?? {})
  }

  async function save() {
    setBusy(true)
    setSaveState('saving')
    const res = await fetch(`/api/items/${it.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(savePayload),
    })
    if (res.ok) {
      setSaveState('saved')
      setDirty(false)
      setMode('view')
      router.refresh()
    } else {
      setSaveState('error')
      toast.error((await res.json()).error ?? t('drawer.autosaveFailed'))
    }
    setBusy(false)
  }

  function cancel() {
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
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('drawer.updateFailed'))
    else {
      setIsActive(next)
      toast.success(next ? t('drawer.activated') : t('drawer.deactivated'))
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !editable

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{name.trim() || t('drawer.newItem')}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>
            {isActive ? tCommon('status.active') : tCommon('status.inactive')}
          </Badge>
        </span>
      }
      description={mode === 'edit' ? tCommon('feedback.editingHint') : undefined}
      headerActions={
        <>
          {mode === 'edit' ? (
            <>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tCommon('actions.cancel')}
              </Button>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
            </>
          ) : canManage ? (
            <div className="flex items-center gap-1.5">
              <Button variant="outline" onClick={() => setMode('edit')}>
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
        {/* -- identity ------------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${field} lg:col-span-2`}>
            <Label>
              {tCommon('labels.name')}{editable ? <span className="text-red-500"> *</span> : null}
            </Label>
            {editable ? (
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('drawer.namePlaceholder')} />
            ) : (
              <p className="text-sm">{name.trim() || t('drawer.newItem')}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.code')}</Label>
            {editable ? (
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="font-mono"
                placeholder={t('drawer.codePlaceholder')}
              />
            ) : (
              <p className="font-mono text-sm">{code || '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.kind')}</Label>
            {editable ? (
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {kindOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm">{kindOptions.find((o) => o.value === kind)?.label ?? kind}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.category')}</Label>
            {editable ? (
              <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('drawer.categoryPlaceholder')} />
            ) : (
              <p className="text-sm">{category || '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.unit')}</Label>
            {editable ? (
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={t('drawer.unitPlaceholder')} />
            ) : (
              <p className="text-sm">{unit || '—'}</p>
            )}
          </div>
          <div className={`${field} sm:col-span-2 lg:col-span-4`}>
            <Label>{tCommon('labels.description')}</Label>
            {editable ? (
              <Input value={description} onChange={(e) => setDescription(e.target.value)} />
            ) : (
              <p className="text-sm">{description || '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.defaultRate')}</Label>
            {editable ? (
              <Input
                inputMode="decimal"
                className="text-right tabular-nums"
                value={defaultRate}
                onChange={(e) => setDefaultRate(e.target.value)}
              />
            ) : (
              <p className="text-right text-sm tabular-nums">{defaultRate || '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.defaultCost')}</Label>
            {editable ? (
              <Input inputMode="decimal" className="text-right tabular-nums" value={defaultCost} onChange={(e) => setDefaultCost(e.target.value)} />
            ) : (
              <p className="text-right text-sm tabular-nums">{defaultCost || '—'}</p>
            )}
          </div>
        </section>

        {laborPricing ? (
          <ItemRatesEditor
            itemId={String(it.id)}
            itemPrice={defaultRate}
            itemCost={defaultCost}
            canManage={editable}
          />
        ) : null}

        {inventoryCosting ? (
          <ItemCostingEditor itemId={String(it.id)} kind={kind} accounts={accounts} canManage={editable} />
        ) : null}

        {/* -- accounting ---------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className={field}>
            <Label>{t('labels.incomeAccount')}</Label>
            {editable ? (
              <SearchSelect
                value={incomeAccountId}
                onChange={setIncomeAccountId}
                options={accountOptions}
                clearable
                emptyLabel={t('drawer.noIncomeAccount')}
                placeholder={t('drawer.selectAccount')}
                sheetTitle={t('labels.incomeAccount')}
                ariaLabel={t('labels.incomeAccount')}
              />
            ) : (
              <p className="text-sm">{payload.incomeAccountName ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.expenseAccount')}</Label>
            {editable ? (
              <SearchSelect
                value={expenseAccountId}
                onChange={setExpenseAccountId}
                options={accountOptions}
                clearable
                emptyLabel={t('drawer.noExpenseAccount')}
                placeholder={t('drawer.selectAccount')}
                sheetTitle={t('labels.expenseAccount')}
                ariaLabel={t('labels.expenseAccount')}
              />
            ) : (
              <p className="text-sm">{payload.expenseAccountName ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.recoveryAccount')}</Label>
            {editable ? (
              <SearchSelect value={costRecoveryAccountId} onChange={setCostRecoveryAccountId} options={accountOptions} clearable
                emptyLabel={t('drawer.noRecoveryAccount')} placeholder={t('drawer.selectAccount')}
                sheetTitle={t('labels.recoveryAccount')} ariaLabel={t('labels.recoveryAccount')} />
            ) : (
              <p className="text-sm">{accounts.find((x) => x.id === costRecoveryAccountId)?.name ?? '—'}</p>
            )}
          </div>
          <div className={field}>
            <Label>{t('labels.taxCode')}</Label>
            {editable ? (
              <Select value={taxCodeId} onChange={(e) => setTaxCodeId(e.target.value)}>
                <option value="">—</option>
                {taxCodes.map((tc) => (
                  <option key={tc.id} value={tc.id}>
                    {tc.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm">{payload.taxCodeName ?? '—'}</p>
            )}
          </div>
        </section>

        {/* -- revenue recognition (ASC 606) --------------------------- */}
        {fairValuePrices ? <section className="space-y-4">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{t('revrec.title')}</h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">{t('revrec.hint')}</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={field}>
              <Label>{t('revrec.rule')}</Label>
              {editable ? (
                <SearchSelect
                  value={recognitionRuleId}
                  onChange={setRecognitionRuleId}
                  options={ruleOptions}
                  clearable
                  emptyLabel={t('revrec.noRule')}
                  placeholder={t('revrec.selectRule')}
                  sheetTitle={t('revrec.rule')}
                  ariaLabel={t('revrec.rule')}
                />
              ) : (
                <p className="text-sm">{ruleOptions.find((r) => r.value === recognitionRuleId)?.label ?? t('revrec.noRule')}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('revrec.deferredAccount')}</Label>
              {editable ? (
                <SearchSelect
                  value={deferredAccountId}
                  onChange={setDeferredAccountId}
                  options={accountOptions}
                  clearable
                  emptyLabel={t('revrec.ruleDefault')}
                  placeholder={t('drawer.selectAccount')}
                  sheetTitle={t('revrec.deferredAccount')}
                  ariaLabel={t('revrec.deferredAccount')}
                />
              ) : (
                <p className="text-sm">
                  {accountOptions.find((a) => a.value === deferredAccountId)?.label ?? t('revrec.ruleDefault')}
                </p>
              )}
            </div>
            <div className={field}>
              <Label>{t('revrec.standaloneSellingPrice')}</Label>
              {editable ? (
                <Input
                  inputMode="decimal"
                  className="text-right tabular-nums"
                  value={standaloneSellingPrice}
                  onChange={(e) => setStandaloneSellingPrice(e.target.value)}
                />
              ) : (
                <p className="text-right text-sm tabular-nums">{standaloneSellingPrice || '—'}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('revrec.createPlansOn')}</Label>
              {editable ? (
                <Select value={createPlansOn} onChange={(e) => setCreatePlansOn(e.target.value)}>
                  {CREATE_PLANS_ON.map((o) => (
                    <option key={o} value={o}>
                      {t(`revrec.createPlansOnOptions.${o}`)}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm">{t(`revrec.createPlansOnOptions.${createPlansOn}`)}</p>
              )}
            </div>
            <div className={field}>
              <Label>{t('revrec.allocation')}</Label>
              {editable ? (
                <Select value={revenueAllocation} onChange={(e) => setRevenueAllocation(e.target.value)}>
                  {REVENUE_ALLOCATION.map((o) => (
                    <option key={o} value={o}>
                      {t(`revrec.allocationOptions.${o}`)}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm">{t(`revrec.allocationOptions.${revenueAllocation}`)}</p>
              )}
            </div>
          </div>
        </section> : null}

        {fairValuePrices ? (
          <FairValuePricesEditor itemId={String(it.id)} canManage={editable} />
        ) : null}

        <CustomFieldInputs defs={fieldDefs} values={customValues} onChange={setCustomValues} readOnly={ro} />

        {timeTracking ? (
        <section className={editable ? 'flex flex-wrap items-center gap-6' : 'grid gap-4 sm:grid-cols-2'}>
          {editable ? <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showOnTimesheet}
              onChange={(e) => setShowOnTimesheet(e.target.checked)}
              className={checkboxClass}
            />
            <span className="text-sm">{t('drawer.showOnTimesheet')}</span>
          </label> : <div className={field}><Label>{t('drawer.showOnTimesheet')}</Label><ReadOnlyValue value={showOnTimesheet ? tCommon('labels.yes') : tCommon('labels.no')} /></div>}
        </section>
        ) : null}
      </div>
    </UrlDrawer>
  )
}
