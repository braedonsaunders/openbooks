'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { GripVertical, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'
import { BUILT_IN_ROLE_KEYS, BUILT_IN_ROLES } from '@/lib/permissions'

const DISPLAY_MODES = [
  { value: 'always', labelKey: 'drawer.displayNormal' },
  { value: 'readonly', labelKey: 'drawer.displayDisabled' },
  { value: 'hidden', labelKey: 'drawer.displayHidden' },
]

const ROLE_OPTIONS = BUILT_IN_ROLE_KEYS.map((k) => ({
  value: k,
  label: BUILT_IN_ROLES[k]?.name ?? k,
}))

// The record types a custom field can extend, and the per-kind narrowing each
// one supports. Header = the document itself; lines = each transaction line.
// Labels are message keys under admin.customFields, translated at render time.
const TARGETS: {
  table: string
  labelKey: string
  descriptionKey: string
  kinds: { value: string; labelKey: string }[]
}[] = [
  {
    table: 'documents',
    labelKey: 'targets.documents.label',
    descriptionKey: 'targets.documents.description',
    kinds: [
      { value: 'vendor_bill', labelKey: 'kinds.header.vendorBill' },
      { value: 'vendor_credit', labelKey: 'kinds.header.vendorCredit' },
      { value: 'customer_invoice', labelKey: 'kinds.header.customerInvoice' },
      { value: 'customer_credit', labelKey: 'kinds.header.customerCredit' },
      { value: 'card_charge', labelKey: 'kinds.header.cardCharge' },
      { value: 'card_refund', labelKey: 'kinds.header.cardRefund' },
      { value: 'check', labelKey: 'kinds.header.check' },
      { value: 'vendor_payment', labelKey: 'kinds.header.vendorPayment' },
      { value: 'customer_payment', labelKey: 'kinds.header.customerPayment' },
      { value: 'expense_report', labelKey: 'kinds.header.expenseReport' },
      { value: 'journal', labelKey: 'kinds.header.journal' },
    ],
  },
  {
    table: 'document_lines',
    labelKey: 'targets.documentLines.label',
    descriptionKey: 'targets.documentLines.description',
    kinds: [
      { value: 'vendor_bill', labelKey: 'kinds.lines.vendorBill' },
      { value: 'vendor_credit', labelKey: 'kinds.lines.vendorCredit' },
      { value: 'customer_invoice', labelKey: 'kinds.lines.customerInvoice' },
      { value: 'customer_credit', labelKey: 'kinds.lines.customerCredit' },
      { value: 'card_charge', labelKey: 'kinds.lines.cardCharge' },
      { value: 'card_refund', labelKey: 'kinds.lines.cardRefund' },
      { value: 'check', labelKey: 'kinds.lines.check' },
      { value: 'expense_report', labelKey: 'kinds.lines.expenseReport' },
      { value: 'journal', labelKey: 'kinds.lines.journal' },
    ],
  },
  { table: 'parties', labelKey: 'targets.parties.label', descriptionKey: 'targets.parties.description', kinds: [] },
  { table: 'projects', labelKey: 'targets.projects.label', descriptionKey: 'targets.projects.description', kinds: [] },
  { table: 'managed_properties', labelKey: 'targets.managedProperties.label', descriptionKey: 'targets.managedProperties.description', kinds: [] },
  { table: 'accounts', labelKey: 'targets.accounts.label', descriptionKey: 'targets.accounts.description', kinds: [] },
  { table: 'items', labelKey: 'targets.items.label', descriptionKey: 'targets.items.description', kinds: [] },
  { table: 'crm_account_profiles', labelKey: 'targets.crmAccounts.label', descriptionKey: 'targets.crmAccounts.description', kinds: [] },
  { table: 'crm_activities', labelKey: 'targets.crmActivities.label', descriptionKey: 'targets.crmActivities.description', kinds: [] },
  { table: 'crm_opportunities', labelKey: 'targets.crmOpportunities.label', descriptionKey: 'targets.crmOpportunities.description', kinds: [] },
]

const TYPES: { value: string; labelKey: string; helpKey: string }[] = [
  { value: 'text', labelKey: 'types.text.label', helpKey: 'types.text.help' },
  { value: 'long_text', labelKey: 'types.longText.label', helpKey: 'types.longText.help' },
  { value: 'number', labelKey: 'types.number.label', helpKey: 'types.number.help' },
  { value: 'currency', labelKey: 'types.currency.label', helpKey: 'types.currency.help' },
  { value: 'date', labelKey: 'types.date.label', helpKey: 'types.date.help' },
  { value: 'boolean', labelKey: 'types.boolean.label', helpKey: 'types.boolean.help' },
  { value: 'select', labelKey: 'types.select.label', helpKey: 'types.select.help' },
  { value: 'multi_select', labelKey: 'types.multiSelect.label', helpKey: 'types.multiSelect.help' },
]

export function NewFieldButton() {
  const t = useTranslations('admin.customFields')
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/custom-fields?field=new')}>
      <Plus size={15} /> {t('newField')}
    </Button>
  )
}

export function FieldDrawer({
  def,
  hiddenKinds = [],
  hiddenTables = [],
}: {
  def: Record<string, any> | null
  hiddenKinds?: string[]
  hiddenTables?: string[]
}) {
  const targets = TARGETS
    .filter((item) => !hiddenTables.includes(item.table))
    .map((item) => ({
      ...item,
      kinds: item.kinds.filter((kind) => !hiddenKinds.includes(kind.value)),
    }))
  const t = useTranslations('admin.customFields')
  const tCommon = useTranslations('common')
  const creating = !def
  const router = useRouter()
  const config = ((def?.config ?? {}))

  const [targetTable, setTargetTable] = useState<string>(def?.target_table ?? 'documents')
  const [targetKind, setTargetKind] = useState<string>(def?.target_kind ?? '')
  const [key, setKey] = useState<string>(def?.key ?? '')
  const [label, setLabel] = useState<string>(def?.label ?? '')
  const [fieldType, setFieldType] = useState<string>(def?.field_type ?? 'text')
  const [options, setOptions] = useState<string[]>(config.options ?? [])
  const [optionDraft, setOptionDraft] = useState('')
  const [helpText, setHelpText] = useState<string>(config.helpText ?? '')
  const [placeholder, setPlaceholder] = useState<string>(config.placeholder ?? '')
  const [defaultValue, setDefaultValue] = useState<string>(config.defaultValue ?? '')
  const [minValue, setMinValue] = useState<string>(config.min != null ? String(config.min) : '')
  const [maxValue, setMaxValue] = useState<string>(config.max != null ? String(config.max) : '')
  const [isRequired, setIsRequired] = useState<boolean>(def?.is_required ?? false)
  const [showInList, setShowInList] = useState<boolean>(config.showInList ?? false)
  const [displayMode, setDisplayMode] = useState<string>(config.displayMode ?? 'always')
  const [allowedRoles, setAllowedRoles] = useState<string[]>(config.allowedRoles ?? [])
  const [isActive, setIsActive] = useState<boolean>(def?.is_active ?? true)
  const [busy, setBusy] = useState(false)

  const target = targets.find((x) => x.table === targetTable)
  const needsOptions = fieldType === 'select' || fieldType === 'multi_select'
  const isNumeric = fieldType === 'number' || fieldType === 'currency'
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)

  // "Transaction header · Vendor bills" badge text for the locked edit view.
  function targetLabel(table: string, kind: string | null): string {
    const tgt = TARGETS.find((x) => x.table === table)
    const k = tgt?.kinds.find((x) => x.value === kind)
    const base = tgt ? t(tgt.labelKey) : table
    if (k) return `${base} · ${t(k.labelKey)}`
    if (tgt?.kinds.length) return `${base} · ${t('drawer.allKindsSuffix')}`
    return base
  }

  function buildConfig() {
    const c: Record<string, unknown> = {}
    if (needsOptions) c.options = options
    if (helpText) c.helpText = helpText
    if (placeholder && !needsOptions && fieldType !== 'boolean') c.placeholder = placeholder
    if (defaultValue) c.defaultValue = defaultValue
    if (isNumeric && minValue !== '') c.min = Number(minValue)
    if (isNumeric && maxValue !== '') c.max = Number(maxValue)
    if (showInList) c.showInList = true
    if (displayMode !== 'always') c.displayMode = displayMode
    if (allowedRoles.length > 0) c.allowedRoles = allowedRoles
    return c
  }

  async function save() {
    setBusy(true)
    const body = creating
      ? { targetTable, targetKind: targetKind || null, key: key || slug(label), label, fieldType, config: buildConfig(), isRequired }
      : { id: def!.id, label, fieldType, config: buildConfig(), isRequired, isActive }
    const res = await fetch('/api/admin/custom-fields', {
      method: creating ? 'POST' : 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.saveFailed'))
      setBusy(false)
      return
    }
    toast.success(creating ? t('drawer.created') : t('drawer.updated'))
    router.push('/admin/custom-fields')
    router.refresh()
  }

  const section = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/admin/custom-fields"
      size="lg"
      title={creating ? t('drawer.newTitle') : t('drawer.editTitle', { label: def!.label })}
      description={creating ? t('drawer.newDescription') : undefined}
      headerActions={
        <>
          <Button disabled={busy || !label || (needsOptions && options.length === 0)} onClick={save}>
            {busy
              ? tCommon('actions.saving')
              : creating
                ? t('drawer.createField')
                : t('drawer.saveChanges')}
          </Button>
        </>
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {!creating ? (
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              {tCommon('labels.active')}
            </label>
          ) : (
            <span />
          )}
        </div>
      }
    >
      <div className="space-y-5 p-1">
        {/* Applies to — editable on create, shown clearly (locked) on edit */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/50">
          <div className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
            {t('drawer.appliesTo')}
          </div>
          {creating ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className={section}>
                <Label>{t('drawer.recordType')}</Label>
                <Select
                  value={targetTable}
                  onChange={(e) => {
                    setTargetTable(e.target.value)
                    setTargetKind('')
                  }}
                >
                  {targets.map((tgt) => (
                    <option key={tgt.table} value={tgt.table}>
                      {t(tgt.labelKey)}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {target ? t(target.descriptionKey) : null}
                </p>
              </div>
              {target && target.kinds.length > 0 ? (
                <div className={section}>
                  <Label>{t('drawer.whichTransactions')}</Label>
                  <Select value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
                    <option value="">{t('drawer.allTypes')}</option>
                    {target.kinds.map((k) => (
                      <option key={k.value} value={k.value}>
                        {t(k.labelKey)}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('drawer.allTypesHint')}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{targetLabel(def!.target_table, def!.target_kind)}</Badge>
              <span className="font-mono text-xs text-slate-400">{def!.key}</span>
              <span className="text-xs text-slate-400">{t('drawer.lockedAfterCreation')}</span>
            </div>
          )}
        </div>

        {/* Identity */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={section}>
            <Label>{t('drawer.label')}</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('drawer.labelPlaceholder')}
            />
          </div>
          {creating ? (
            <div className={section}>
              <Label>
                {t('drawer.fieldKey')}{' '}
                <span className="font-normal text-slate-400">{t('drawer.permanent')}</span>
              </Label>
              <Input
                value={key}
                onChange={(e) => setKey(slug(e.target.value))}
                placeholder={label ? slug(label) : t('drawer.keyPlaceholder')}
                className="font-mono"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.keyHint')}</p>
            </div>
          ) : null}
        </div>

        {/* Type */}
        <div className={section}>
          <Label>{t('drawer.type')}</Label>
          <Select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
            {TYPES.map((ty) => (
              <option key={ty.value} value={ty.value}>
                {t(ty.labelKey)}
              </option>
            ))}
          </Select>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {(() => {
              const ty = TYPES.find((x) => x.value === fieldType)
              return ty ? t(ty.helpKey) : null
            })()}
          </p>
        </div>

        {/* Options editor */}
        {needsOptions ? (
          <div className={section}>
            <Label>{t('drawer.options')}</Label>
            {options.length > 0 ? (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {options.map((o) => (
                  <li key={o} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                    <GripVertical size={13} className="text-slate-300" />
                    <span className="flex-1">{o}</span>
                    <button
                      type="button"
                      aria-label={t('drawer.removeOption', { option: o })}
                      className="text-slate-400 hover:text-red-600"
                      onClick={() => setOptions(options.filter((x) => x !== o))}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400">{t('drawer.noOptions')}</p>
            )}
            <div className="flex gap-2">
              <Input
                value={optionDraft}
                onChange={(e) => setOptionDraft(e.target.value)}
                placeholder={t('drawer.addOptionPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && optionDraft.trim()) {
                    e.preventDefault()
                    if (!options.includes(optionDraft.trim())) setOptions([...options, optionDraft.trim()])
                    setOptionDraft('')
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  const v = optionDraft.trim()
                  if (v && !options.includes(v)) setOptions([...options, v])
                  setOptionDraft('')
                }}
              >
                {tCommon('actions.add')}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Behaviour */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={section}>
            <Label>
              {t('drawer.helpText')}{' '}
              <span className="font-normal text-slate-400">{t('drawer.optionalSuffix')}</span>
            </Label>
            <Input
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              placeholder={t('drawer.helpTextPlaceholder')}
            />
          </div>
          {!needsOptions && fieldType !== 'boolean' ? (
            <div className={section}>
              <Label>
                {t('drawer.placeholder')}{' '}
                <span className="font-normal text-slate-400">{t('drawer.optionalSuffix')}</span>
              </Label>
              <Input value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} />
            </div>
          ) : null}
          <div className={section}>
            <Label>
              {t('drawer.defaultValue')}{' '}
              <span className="font-normal text-slate-400">{t('drawer.optionalSuffix')}</span>
            </Label>
            {needsOptions ? (
              <Select value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)}>
                <option value="">{tCommon('labels.none')}</option>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={fieldType === 'date' ? 'date' : 'text'}
                inputMode={isNumeric ? 'decimal' : undefined}
                value={defaultValue}
                onChange={(e) => setDefaultValue(e.target.value)}
              />
            )}
          </div>
          {isNumeric ? (
            <div className="grid grid-cols-2 gap-2">
              <div className={section}>
                <Label>{t('drawer.min')}</Label>
                <Input inputMode="decimal" value={minValue} onChange={(e) => setMinValue(e.target.value)} />
              </div>
              <div className={section}>
                <Label>{t('drawer.max')}</Label>
                <Input inputMode="decimal" value={maxValue} onChange={(e) => setMaxValue(e.target.value)} />
              </div>
            </div>
          ) : null}
        </div>

        {/* Flags */}
        <div className="flex flex-wrap gap-5 border-t border-slate-100 pt-4 dark:border-slate-800">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isRequired}
              onChange={(e) => setIsRequired(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            {tCommon('labels.required')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showInList}
              onChange={(e) => setShowInList(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            {t('drawer.showInList')}
          </label>
        </div>

        {/* Display mode & role access */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={section}>
            <Label>{t('drawer.displayMode')}</Label>
            <Select value={displayMode} onChange={(e) => setDisplayMode(e.target.value)}>
              {DISPLAY_MODES.map((dm) => (
                <option key={dm.value} value={dm.value}>
                  {t(dm.labelKey)}
                </option>
              ))}
            </Select>
          </div>
          <div className={section}>
            <Label>
              {t('drawer.allowedRoles')}{' '}
              <span className="font-normal text-slate-400">{t('drawer.optionalSuffix')}</span>
            </Label>
            <div className="flex flex-wrap gap-2">
              {ROLE_OPTIONS.map((r) => (
                <label
                  key={r.value}
                  className="flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={allowedRoles.includes(r.value)}
                    onChange={(e) =>
                      setAllowedRoles(
                        e.target.checked
                          ? [...allowedRoles, r.value]
                          : allowedRoles.filter((x) => x !== r.value),
                      )
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  {r.label}
                </label>
              ))}
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.allowedRolesHint')}</p>
          </div>
        </div>
      </div>
    </UrlDrawer>
  )
}
