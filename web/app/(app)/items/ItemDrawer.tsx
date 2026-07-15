'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, UrlDrawer } from '@openbooks/ui'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'

interface AccountOpt {
  id: string
  number?: string | null
  name?: string | null
}
interface TaxOpt {
  id: string
  name?: string | null
}
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
  canManage,
  basePath = '/items',
}: {
  payload: ItemPayload
  accounts: AccountOpt[]
  taxCodes: TaxOpt[]
  fieldDefs: CustomFieldDefClient[]
  canManage: boolean
  basePath?: string
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
  const [code, setCode] = useState<string>(it.code ?? '')
  const [category, setCategory] = useState<string>(it.category ?? '')
  const [unit, setUnit] = useState<string>(it.unit ?? '')
  const [defaultRate, setDefaultRate] = useState<string>(
    it.default_rate != null ? Number(it.default_rate).toFixed(2) : '',
  )
  const [incomeAccountId, setIncomeAccountId] = useState<string>(it.income_account_id ?? '')
  const [expenseAccountId, setExpenseAccountId] = useState<string>(it.expense_account_id ?? '')
  const [taxCodeId, setTaxCodeId] = useState<string>(it.tax_code_id ?? '')
  const [showOnTimesheet, setShowOnTimesheet] = useState<boolean>(it.show_on_timesheet === true)
  const [customValues, setCustomValues] = useState<Record<string, unknown>>(it.custom ?? {})
  const [isActive, setIsActive] = useState<boolean>(it.is_active === true)

  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const [busy, setBusy] = useState(false)

  // NetSuite-style record model: the flyout ALWAYS opens READ-ONLY (view mode)
  // — even for drafts — with an Edit button in the header. Save is EXPLICIT —
  // one Save button, no per-field autosave.
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const editable = mode === 'edit' && canManage

  const nameValid = name.trim().length > 0 && name.trim() !== 'New item'

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
    [accounts],
  )

  // -- explicit save (no autosave) -------------------------------------------
  const savePayload = useMemo(
    () => ({
      kind,
      name: name.trim() || (isActive ? name : 'New item'),
      code,
      category,
      unit,
      defaultRate: defaultRate || null,
      incomeAccountId: incomeAccountId || null,
      expenseAccountId: expenseAccountId || null,
      taxCodeId: taxCodeId || null,
      showOnTimesheet,
      custom: customValues,
    }),
    [kind, name, code, category, unit, defaultRate, incomeAccountId, expenseAccountId, taxCodeId, showOnTimesheet, customValues, isActive],
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
    setCode(it.code ?? '')
    setCategory(it.category ?? '')
    setUnit(it.unit ?? '')
    setDefaultRate(it.default_rate != null ? Number(it.default_rate).toFixed(2) : '')
    setIncomeAccountId(it.income_account_id ?? '')
    setExpenseAccountId(it.expense_account_id ?? '')
    setTaxCodeId(it.tax_code_id ?? '')
    setShowOnTimesheet(it.show_on_timesheet === true)
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
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.saving') : tCommon('actions.save')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={cancel}>
                {tCommon('actions.cancel')}
              </Button>
            </>
          ) : canManage ? (
            <>
              <Button variant="outline" onClick={() => setMode('edit')}>
                {tCommon('actions.edit')}
              </Button>
              {isActive ? (
                <Button variant="outline" disabled={busy} onClick={() => setActiveState(false)}>
                  {t('drawer.deactivate')}
                </Button>
              ) : (
                <>
                  {!nameValid ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.nameToActivate')}</span>
                  ) : null}
                  <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>
                    {t('drawer.activate')}
                  </Button>
                </>
              )}
            </>
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
        </section>

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

        <CustomFieldInputs defs={fieldDefs} values={customValues} onChange={setCustomValues} readOnly={ro} />

        {/* -- flags --------------------------------------------------- */}
        <section className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showOnTimesheet}
              onChange={(e) => setShowOnTimesheet(e.target.checked)}
              disabled={ro}
              className={checkboxClass}
            />
            <span className="text-sm">{t('drawer.showOnTimesheet')}</span>
          </label>
        </section>
      </div>
    </UrlDrawer>
  )
}
