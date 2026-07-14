'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
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

const KIND_OPTIONS = [
  { value: 'service', label: 'Service' },
  { value: 'non_inventory', label: 'Non-inventory' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'assembly', label: 'Assembly' },
  { value: 'kit', label: 'Kit' },
  { value: 'other_charge', label: 'Other charge' },
  { value: 'labor', label: 'Labor' },
  { value: 'absence', label: 'Absence' },
  { value: 'discount', label: 'Discount' },
]

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
  const router = useRouter()
  const it = payload.item
  const isPlaceholderName = it.name === 'New item'

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

  const nameValid = name.trim().length > 0 && name.trim() !== 'New item'

  const accountOptions = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: `${a.number ?? ''} ${a.name ?? ''}`.trim() })),
    [accounts],
  )

  // -- autosave (debounced PATCH) ------------------------------------------
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
  const first = useRef(true)
  useEffect(() => {
    if (!canManage) return
    if (first.current) {
      first.current = false
      return
    }
    setSaveState('dirty')
    const t = setTimeout(async () => {
      setSaveState('saving')
      const res = await fetch(`/api/items/${it.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(savePayload),
      })
      if (res.ok) {
        setSaveState('saved')
        router.refresh()
      } else {
        setSaveState('error')
        toast.error((await res.json()).error ?? 'Autosave failed')
      }
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePayload, canManage])

  async function setActiveState(next: boolean) {
    setBusy(true)
    const res = await fetch(`/api/items/${it.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: next }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? 'Update failed')
    else {
      setIsActive(next)
      toast.success(next ? 'Item activated' : 'Item deactivated')
    }
    setBusy(false)
    router.refresh()
  }

  const ro = !canManage

  return (
    <UrlDrawer
      open
      closeHref={basePath}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{name.trim() || 'New item'}</span>
          <Badge variant={isActive ? 'success' : 'outline'}>{isActive ? 'Active' : 'Inactive'}</Badge>
        </span>
      }
      description={canManage ? 'Changes save automatically.' : undefined}
      headerActions={
        <>
          {canManage ? (
            isActive ? (
              <Button variant="outline" disabled={busy} onClick={() => setActiveState(false)}>
                Deactivate
              </Button>
            ) : (
              <>
                {!nameValid ? (
                  <span className="text-xs text-slate-500 dark:text-slate-400">Name the item to activate it</span>
                ) : null}
                <Button disabled={busy || !nameValid} onClick={() => setActiveState(true)}>
                  Activate
                </Button>
              </>
            )
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
            {canManage
              ? saveState === 'saved'
                ? 'All changes saved'
                : saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'error'
                    ? 'Save failed — fix and retry'
                    : 'Unsaved changes…'
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
              Name<span className="text-red-500"> *</span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Item or service name…" disabled={ro} />
          </div>
          <div className={field}>
            <Label>Code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono"
              placeholder="SVC-01"
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Kind</Label>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={ro}>
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div className={field}>
            <Label>Category</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Services" disabled={ro} />
          </div>
          <div className={field}>
            <Label>Unit</Label>
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="hr" disabled={ro} />
          </div>
          <div className={field}>
            <Label>Default rate</Label>
            <Input
              inputMode="decimal"
              className="text-right tabular-nums"
              value={defaultRate}
              onChange={(e) => setDefaultRate(e.target.value)}
              disabled={ro}
            />
          </div>
        </section>

        {/* -- accounting ---------------------------------------------- */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className={field}>
            <Label>Income account</Label>
            <SearchSelect
              value={incomeAccountId}
              onChange={setIncomeAccountId}
              options={accountOptions}
              clearable
              emptyLabel="No income account"
              placeholder="Select account…"
              sheetTitle="Income account"
              ariaLabel="Income account"
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Expense account</Label>
            <SearchSelect
              value={expenseAccountId}
              onChange={setExpenseAccountId}
              options={accountOptions}
              clearable
              emptyLabel="No expense account"
              placeholder="Select account…"
              sheetTitle="Expense account"
              ariaLabel="Expense account"
              disabled={ro}
            />
          </div>
          <div className={field}>
            <Label>Tax code</Label>
            <Select value={taxCodeId} onChange={(e) => setTaxCodeId(e.target.value)} disabled={ro}>
              <option value="">—</option>
              {taxCodes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
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
            <span className="text-sm">Show on timesheet</span>
          </label>
        </section>
      </div>
    </UrlDrawer>
  )
}
