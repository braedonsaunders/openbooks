'use client'

import { useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, SearchSelect, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { CustomFieldInputs, type CustomFieldDefClient } from '../../../components/custom-field-inputs'
import type { AccountPayload } from '../../api/accounts/_lib'
import { ReadOnlyValue } from '../../../components/read-only-value'

type Option = { value: string; label: string; type?: string }

const TYPE_VALUES = [
  'asset_bank',
  'asset_receivable',
  'asset_current_other',
  'asset_fixed',
  'asset_other',
  'liability_payable',
  'liability_card',
  'liability_current_other',
  'liability_long_term',
  'equity',
  'income',
  'income_other',
  'cogs',
  'expense',
  'expense_other',
  'expense_deferred',
] as const

const TYPE_KEYS: Record<string, string> = {
  asset_bank: 'assetBank', asset_receivable: 'assetReceivable', asset_current_other: 'assetCurrentOther',
  asset_fixed: 'assetFixed', asset_other: 'assetOther', liability_payable: 'liabilityPayable',
  liability_card: 'liabilityCard', liability_current_other: 'liabilityCurrentOther',
  liability_long_term: 'liabilityLongTerm', equity: 'equity', income: 'income', income_other: 'incomeOther',
  cogs: 'cogs', expense: 'expense', expense_other: 'expenseOther', expense_deferred: 'expenseDeferred',
}

const checkboxClass = 'h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-950'
const fieldClass = 'space-y-1.5'

export function AccountDrawer({
  payload,
  parents,
  currencies,
  subsidiaries,
  fieldDefs,
  segments,
  canManage,
  closeHref,
  createMode = false,
  multiCurrency = false,
}: {
  payload: AccountPayload
  parents: Option[]
  currencies: Option[]
  subsidiaries: Option[]
  fieldDefs: CustomFieldDefClient[]
  segments: { key: string; name: string }[]
  canManage: boolean
  closeHref: string
  createMode?: boolean
  multiCurrency?: boolean
}) {
  const t = useTranslations('accounts')
  const tc = useTranslations('common')
  const router = useRouter()
  const account = payload.account as Record<string, any>
  const requestIdRef = useRef<string | null>(null)

  const initial = useMemo(() => ({
    number: account.number ?? '',
    name: account.name ?? '',
    type: account.type ?? 'expense',
    description: account.description ?? '',
    parentId: account.parent_id ?? '',
    isSummary: account.is_summary === true,
    isActive: createMode ? true : account.is_active === true,
    currencyRestriction: account.currency_restriction ?? '',
    eliminate: account.eliminate === true,
    subsidiaryId: account.subsidiary_id ?? '',
    subsidiaryIncludeChildren: account.subsidiary_include_children !== false,
    reconcilable: account.reconcilable === true,
    monetary: typeof account.monetary === 'boolean' ? String(account.monetary) : '',
    requiredDimensions: Array.isArray(account.required_dimensions) ? account.required_dimensions as string[] : [],
    custom: (account.custom ?? {}) as Record<string, unknown>,
  }), [account, createMode])
  const [form, setForm] = useState(initial)
  const [mode, setMode] = useState<'view' | 'edit'>(createMode ? 'edit' : 'view')
  const [busy, setBusy] = useState(false)
  const editable = canManage && mode === 'edit'
  const compatibleParents = parents.filter((option) => option.type === form.type)
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((current) => ({ ...current, [key]: value }))

  function errorMessage(code: unknown) {
    const key = typeof code === 'string' ? code : 'save_failed'
    const known = new Set([
      'name_required', 'invalid_type', 'type_has_transactions', 'invalid_parent', 'parent_must_be_summary',
      'parent_type_mismatch', 'parent_cycle', 'summary_reconcilable_conflict', 'summary_has_transactions', 'summary_has_children',
      'inactive_has_children', 'invalid_currency', 'invalid_subsidiary', 'invalid_dimensions',
      'invalid_custom_fields', 'number_in_use', 'account_changed', 'invalid_idempotency_key', 'save_failed',
    ])
    return t(`drawer.errors.${known.has(key) ? key : 'save_failed'}`)
  }

  async function save() {
    if (!form.name.trim()) {
      toast.error(t('drawer.errors.name_required'))
      return
    }
    setBusy(true)
    if (createMode && !requestIdRef.current) requestIdRef.current = crypto.randomUUID()
    const { currencyRestriction, ...formRest } = form
    const response = await fetch(createMode ? '/api/accounts' : `/api/accounts/${account.id}`, {
      method: createMode ? 'POST' : 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(createMode ? { 'Idempotency-Key': requestIdRef.current! } : {}),
      },
      body: JSON.stringify({
        ...formRest,
        number: form.number || null,
        description: form.description || null,
        parentId: form.parentId || null,
        subsidiaryId: form.subsidiaryId || null,
        monetary: form.monetary === '' ? null : form.monetary === 'true',
        ...(multiCurrency ? { currencyRestriction: currencyRestriction || null } : {}),
      }),
    })
    const data = await response.json().catch(() => ({}))
    setBusy(false)
    if (!response.ok) {
      toast.error(errorMessage(data.error))
      return
    }
    toast.success(t(createMode ? 'drawer.created' : 'drawer.saved'))
    if (createMode) {
      const createdId = data?.account?.id
      const separator = closeHref.includes('?') ? '&' : '?'
      router.replace((createdId ? `${closeHref}${separator}account=${createdId}` : closeHref) as never)
      router.refresh()
      return
    }
    setMode('view')
    router.refresh()
  }

  function cancel() {
    if (createMode) {
      router.push(closeHref as never)
      return
    }
    setForm(initial)
    setMode('view')
  }

  function toggleDimension(dimension: string, checked: boolean) {
    set('requiredDimensions', checked
      ? [...new Set([...form.requiredDimensions, dimension])]
      : form.requiredDimensions.filter((value) => value !== dimension))
  }

  const value = (content: React.ReactNode) => (
    <p className="min-h-5 text-sm">{content === null || content === undefined || content === '' ? tc('labels.notSet') : content}</p>
  )
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={
        <span className="flex items-center gap-2.5">
          <span>{createMode ? t('drawer.newTitle') : `${form.number} ${form.name}`.trim()}</span>
          {!createMode ? (
            <Badge variant={form.isActive ? 'success' : 'outline'}>
              {form.isActive ? tc('status.active') : tc('status.inactive')}
            </Badge>
          ) : null}
        </span>
      }
      description={createMode ? t('drawer.newDescription') : mode === 'edit' ? tc('feedback.editingHint') : undefined}
      headerActions={
        mode === 'edit' ? (
          <>
            <Button variant="outline" disabled={busy} onClick={cancel}>{tc('actions.cancel')}</Button>
            <Button disabled={busy || !form.name.trim()} onClick={save}>
              {busy ? tc('actions.saving') : createMode ? t('drawer.create') : tc('actions.save')}
            </Button>
          </>
        ) : canManage ? (
          <Button variant="outline" onClick={() => setMode('edit')}>{tc('actions.edit')}</Button>
        ) : undefined
      }
    >
      <div className="space-y-7 p-1">
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className={`${fieldClass} lg:col-span-2`}>
            <Label>{tc('labels.name')}{editable ? <span className="text-red-500"> *</span> : null}</Label>
            {editable ? <Input value={form.name} onChange={(e) => set('name', e.target.value)} /> : value(form.name)}
          </div>
          <div className={fieldClass}>
            <Label>{tc('labels.number')}</Label>
            {editable ? <Input className="font-mono" value={form.number} onChange={(e) => set('number', e.target.value)} /> : value(<span className="font-mono">{form.number}</span>)}
          </div>
          <div className={fieldClass}>
            <Label>{tc('labels.type')}</Label>
            {editable ? (
              <Select
                value={form.type}
                disabled={payload.hasTransactions}
                onChange={(e) => setForm((current) => ({ ...current, type: e.target.value, parentId: '' }))}
              >
                {TYPE_VALUES.map((type) => <option key={type} value={type}>{t(`types.${TYPE_KEYS[type]}`)}</option>)}
              </Select>
            ) : value(t(`types.${TYPE_KEYS[form.type]}`))}
            {editable && payload.hasTransactions ? <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.typeLocked')}</p> : null}
          </div>
          <div className={`${fieldClass} sm:col-span-2 lg:col-span-4`}>
            <Label>{tc('labels.description')}</Label>
            {editable ? <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} /> : value(form.description)}
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className={fieldClass}>
            <Label>{t('drawer.parent')}</Label>
            {editable ? (
              <SearchSelect value={form.parentId} onChange={(v) => set('parentId', v)} options={compatibleParents} clearable emptyLabel={tc('labels.none')} ariaLabel={t('drawer.parent')} />
            ) : value(parents.find((option) => option.value === form.parentId)?.label ?? payload.parentName)}
          </div>
          {multiCurrency ? (
          <div className={fieldClass}>
            <Label>{t('drawer.currencyRestriction')}</Label>
            {editable ? (
              <SearchSelect value={form.currencyRestriction} onChange={(v) => set('currencyRestriction', v)} options={currencies} clearable emptyLabel={t('drawer.anyCurrency')} ariaLabel={t('drawer.currencyRestriction')} />
            ) : value(form.currencyRestriction || t('drawer.anyCurrency'))}
          </div>
          ) : null}
          <div className={fieldClass}>
            <Label>{t('drawer.monetary')}</Label>
            {editable ? (
              <SearchSelect
                value={form.monetary}
                onChange={(v) => set('monetary', v)}
                options={[
                  { value: 'true', label: t('drawer.monetaryAlways') },
                  { value: 'false', label: t('drawer.monetaryNever') },
                ]}
                clearable
                emptyLabel={t('drawer.monetaryDefault')}
                ariaLabel={t('drawer.monetary')}
              />
            ) : value(form.monetary === 'true' ? t('drawer.monetaryAlways') : form.monetary === 'false' ? t('drawer.monetaryNever') : t('drawer.monetaryDefault'))}
          </div>
          {subsidiaries.length > 0 ? <div className={fieldClass}>
            <Label>{tc('labels.subsidiary')}</Label>
            {editable ? (
              <SearchSelect value={form.subsidiaryId} onChange={(v) => set('subsidiaryId', v)} options={subsidiaries} clearable emptyLabel={t('drawer.allSubsidiaries')} ariaLabel={tc('labels.subsidiary')} />
            ) : value(subsidiaries.find((option) => option.value === form.subsidiaryId)?.label ?? payload.subsidiaryName ?? t('drawer.allSubsidiaries'))}
          </div> : null}
        </section>

        {editable ? <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} className={checkboxClass} />
            <span className="text-sm">{tc('labels.active')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.isSummary}
              onChange={(e) => setForm((current) => ({
                ...current,
                isSummary: e.target.checked,
                reconcilable: e.target.checked ? false : current.reconcilable,
              }))}
              className={checkboxClass}
            />
            <span className="text-sm">{t('drawer.summary')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.reconcilable} disabled={form.isSummary} onChange={(e) => set('reconcilable', e.target.checked)} className={checkboxClass} />
            <span className="text-sm">{t('drawer.reconcilable')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.eliminate} onChange={(e) => set('eliminate', e.target.checked)} className={checkboxClass} />
            <span className="text-sm">{t('drawer.eliminate')}</span>
          </label>
          {subsidiaries.length > 0 ? <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.subsidiaryIncludeChildren} disabled={!form.subsidiaryId} onChange={(e) => set('subsidiaryIncludeChildren', e.target.checked)} className={checkboxClass} />
            <span className="text-sm">{t('drawer.includeSubsidiaries')}</span>
          </label> : null}
        </section> : (
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className={fieldClass}><Label>{tc('labels.active')}</Label><ReadOnlyValue value={form.isActive ? tc('labels.yes') : tc('labels.no')} /></div>
            <div className={fieldClass}><Label>{t('drawer.summary')}</Label><ReadOnlyValue value={form.isSummary ? tc('labels.yes') : tc('labels.no')} /></div>
            <div className={fieldClass}><Label>{t('drawer.reconcilable')}</Label><ReadOnlyValue value={form.reconcilable ? tc('labels.yes') : tc('labels.no')} /></div>
            <div className={fieldClass}><Label>{t('drawer.eliminate')}</Label><ReadOnlyValue value={form.eliminate ? tc('labels.yes') : tc('labels.no')} /></div>
            {subsidiaries.length > 0 ? <div className={fieldClass}><Label>{t('drawer.includeSubsidiaries')}</Label><ReadOnlyValue value={form.subsidiaryIncludeChildren ? tc('labels.yes') : tc('labels.no')} /></div> : null}
          </section>
        )}

        <section className={fieldClass}>
          <Label>{t('drawer.requiredDimensions')}</Label>
          {editable ? <div className="flex flex-wrap gap-x-6 gap-y-3">
            {[...segments, { key: 'party', name: t('drawer.dimensions.party') }].map((dimension) => (
              <label key={dimension.key} className="flex items-center gap-2">
                <input type="checkbox" checked={form.requiredDimensions.includes(dimension.key)} onChange={(e) => toggleDimension(dimension.key, e.target.checked)} className={checkboxClass} />
                <span className="text-sm">{dimension.name}</span>
              </label>
            ))}
          </div> : <ReadOnlyValue value={[...segments, { key: 'party', name: t('drawer.dimensions.party') }].filter((dimension) => form.requiredDimensions.includes(dimension.key)).map((dimension) => dimension.name).join(', ')} />}
        </section>

        <CustomFieldInputs defs={fieldDefs} values={form.custom} onChange={(v) => set('custom', v)} readOnly={!editable} />
      </div>
    </UrlDrawer>
  )
}
