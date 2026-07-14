'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { GripVertical, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from '@openbooks/ui'

// The record types a custom field can extend, and the per-kind narrowing each
// one supports. Header = the document itself; lines = each transaction line.
const TARGETS: { table: string; label: string; description: string; kinds: { value: string; label: string }[] }[] = [
  {
    table: 'documents',
    label: 'Transaction header',
    description: 'One value per transaction (bill, invoice, payment, expense report, journal).',
    kinds: [
      { value: 'vendor_bill', label: 'Vendor bills' },
      { value: 'customer_invoice', label: 'Customer invoices' },
      { value: 'vendor_payment', label: 'Vendor payments' },
      { value: 'customer_payment', label: 'Customer receipts' },
      { value: 'expense_report', label: 'Expense reports' },
      { value: 'journal', label: 'Journal entries' },
    ],
  },
  {
    table: 'document_lines',
    label: 'Transaction lines',
    description: 'A column on every line of the chosen transaction type.',
    kinds: [
      { value: 'vendor_bill', label: 'Vendor bill lines' },
      { value: 'customer_invoice', label: 'Customer invoice lines' },
      { value: 'expense_report', label: 'Expense report lines' },
      { value: 'journal', label: 'Journal entry lines' },
    ],
  },
  { table: 'parties', label: 'Parties', description: 'Vendors, customers, and employees.', kinds: [] },
  { table: 'projects', label: 'Projects', description: 'Jobs / projects.', kinds: [] },
  { table: 'accounts', label: 'Accounts', description: 'Chart of accounts.', kinds: [] },
]

const TYPES: { value: string; label: string; help: string }[] = [
  { value: 'text', label: 'Text', help: 'Single line of text.' },
  { value: 'long_text', label: 'Text area', help: 'Multiple lines of text.' },
  { value: 'number', label: 'Number', help: 'A numeric value.' },
  { value: 'currency', label: 'Currency', help: 'A money amount (2 decimals).' },
  { value: 'date', label: 'Date', help: 'A calendar date.' },
  { value: 'boolean', label: 'Checkbox', help: 'Yes / no.' },
  { value: 'select', label: 'Dropdown (single)', help: 'Choose one from a list.' },
  { value: 'multi_select', label: 'Dropdown (multiple)', help: 'Choose any number from a list.' },
]

function targetLabel(table: string, kind: string | null): string {
  const t = TARGETS.find((x) => x.table === table)
  const k = t?.kinds.find((x) => x.value === kind)
  return `${t?.label ?? table}${k ? ` · ${k.label}` : t?.kinds.length ? ' · all kinds' : ''}`
}

export function NewFieldButton() {
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/custom-fields?field=new')}>
      <Plus size={15} /> New field
    </Button>
  )
}

export function FieldDrawer({ def }: { def: Record<string, any> | null }) {
  const creating = !def
  const router = useRouter()
  const config = (def?.config ?? {}) as Record<string, any>

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
  const [isActive, setIsActive] = useState<boolean>(def?.is_active ?? true)
  const [busy, setBusy] = useState(false)

  const target = TARGETS.find((t) => t.table === targetTable)
  const needsOptions = fieldType === 'select' || fieldType === 'multi_select'
  const isNumeric = fieldType === 'number' || fieldType === 'currency'
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)

  function buildConfig() {
    const c: Record<string, unknown> = {}
    if (needsOptions) c.options = options
    if (helpText) c.helpText = helpText
    if (placeholder && !needsOptions && fieldType !== 'boolean') c.placeholder = placeholder
    if (defaultValue) c.defaultValue = defaultValue
    if (isNumeric && minValue !== '') c.min = Number(minValue)
    if (isNumeric && maxValue !== '') c.max = Number(maxValue)
    if (showInList) c.showInList = true
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
      toast.error(data.error ?? 'Could not save the field')
      setBusy(false)
      return
    }
    toast.success(creating ? 'Field created' : 'Field updated')
    router.push('/admin/custom-fields')
    router.refresh()
  }

  const section = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/admin/custom-fields"
      size="lg"
      title={creating ? 'New custom field' : `Edit “${def!.label}”`}
      description={creating ? 'Extend a record type with your own field.' : undefined}
      headerActions={
        <>
          <Button disabled={busy || !label || (needsOptions && options.length === 0)} onClick={save}>
            {busy ? 'Saving…' : creating ? 'Create field' : 'Save changes'}
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
              Active
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
            Applies to
          </div>
          {creating ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className={section}>
                <Label>Record type</Label>
                <Select
                  value={targetTable}
                  onChange={(e) => {
                    setTargetTable(e.target.value)
                    setTargetKind('')
                  }}
                >
                  {TARGETS.map((t) => (
                    <option key={t.table} value={t.table}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-slate-500 dark:text-slate-400">{target?.description}</p>
              </div>
              {target && target.kinds.length > 0 ? (
                <div className={section}>
                  <Label>Which transactions</Label>
                  <Select value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
                    <option value="">All types</option>
                    {target.kinds.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Leave as “All types” to apply the field to every kind.
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{targetLabel(def!.target_table, def!.target_kind)}</Badge>
              <span className="font-mono text-xs text-slate-400">{def!.key}</span>
              <span className="text-xs text-slate-400">· locked after creation (values already reference it)</span>
            </div>
          )}
        </div>

        {/* Identity */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={section}>
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="PO Number" />
          </div>
          {creating ? (
            <div className={section}>
              <Label>
                Field key <span className="font-normal text-slate-400">(permanent)</span>
              </Label>
              <Input
                value={key}
                onChange={(e) => setKey(slug(e.target.value))}
                placeholder={label ? slug(label) : 'po_number'}
                className="font-mono"
              />
              <p className="text-xs text-slate-500 dark:text-slate-400">Auto-filled from the label; snake_case.</p>
            </div>
          ) : null}
        </div>

        {/* Type */}
        <div className={section}>
          <Label>Type</Label>
          <Select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {TYPES.find((t) => t.value === fieldType)?.help}
          </p>
        </div>

        {/* Options editor */}
        {needsOptions ? (
          <div className={section}>
            <Label>Options</Label>
            {options.length > 0 ? (
              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {options.map((o, i) => (
                  <li key={o} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                    <GripVertical size={13} className="text-slate-300" />
                    <span className="flex-1">{o}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${o}`}
                      className="text-slate-400 hover:text-red-600"
                      onClick={() => setOptions(options.filter((x) => x !== o))}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-400">No options yet — add at least one.</p>
            )}
            <div className="flex gap-2">
              <Input
                value={optionDraft}
                onChange={(e) => setOptionDraft(e.target.value)}
                placeholder="Add an option…"
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
                Add
              </Button>
            </div>
          </div>
        ) : null}

        {/* Behaviour */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={section}>
            <Label>Help text <span className="font-normal text-slate-400">(optional)</span></Label>
            <Input value={helpText} onChange={(e) => setHelpText(e.target.value)} placeholder="Shown under the field" />
          </div>
          {!needsOptions && fieldType !== 'boolean' ? (
            <div className={section}>
              <Label>Placeholder <span className="font-normal text-slate-400">(optional)</span></Label>
              <Input value={placeholder} onChange={(e) => setPlaceholder(e.target.value)} />
            </div>
          ) : null}
          <div className={section}>
            <Label>Default value <span className="font-normal text-slate-400">(optional)</span></Label>
            {needsOptions ? (
              <Select value={defaultValue} onChange={(e) => setDefaultValue(e.target.value)}>
                <option value="">None</option>
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
                <Label>Min</Label>
                <Input inputMode="decimal" value={minValue} onChange={(e) => setMinValue(e.target.value)} />
              </div>
              <div className={section}>
                <Label>Max</Label>
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
            Required
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showInList}
              onChange={(e) => setShowInList(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            Show as a column in list views
          </label>
        </div>
      </div>
    </UrlDrawer>
  )
}
