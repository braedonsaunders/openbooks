'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'

const TARGETS: { table: string; label: string; kinds: string[] }[] = [
  { table: 'documents', label: 'Document header', kinds: ['vendor_bill', 'customer_invoice', 'vendor_payment', 'customer_payment', 'expense_report', 'journal'] },
  { table: 'document_lines', label: 'Document lines', kinds: ['vendor_bill', 'customer_invoice', 'expense_report', 'journal'] },
  { table: 'parties', label: 'Parties', kinds: [] },
  { table: 'projects', label: 'Projects', kinds: [] },
  { table: 'accounts', label: 'Accounts', kinds: [] },
]
const TYPES = ['text', 'long_text', 'number', 'currency', 'date', 'boolean', 'select', 'multi_select']

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
  const [targetTable, setTargetTable] = useState<string>(def?.target_table ?? 'documents')
  const [targetKind, setTargetKind] = useState<string>(def?.target_kind ?? '')
  const [key, setKey] = useState<string>(def?.key ?? '')
  const [label, setLabel] = useState<string>(def?.label ?? '')
  const [fieldType, setFieldType] = useState<string>(def?.field_type ?? 'text')
  const [options, setOptions] = useState<string[]>(def?.config?.options ?? [])
  const [optionDraft, setOptionDraft] = useState('')
  const [isRequired, setIsRequired] = useState<boolean>(def?.is_required ?? false)
  const [isActive, setIsActive] = useState<boolean>(def?.is_active ?? true)
  const [busy, setBusy] = useState(false)

  const kinds = TARGETS.find((t) => t.table === targetTable)?.kinds ?? []
  const needsOptions = fieldType === 'select' || fieldType === 'multi_select'

  async function save() {
    setBusy(true)
    const body = creating
      ? { targetTable, targetKind: targetKind || null, key, label, fieldType, config: needsOptions ? { options } : {}, isRequired }
      : { id: def!.id, label, fieldType, config: needsOptions ? { options } : {}, isRequired, isActive }
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

  const field = 'space-y-1.5'

  return (
    <UrlDrawer
      open
      closeHref="/admin/custom-fields"
      size="md"
      title={creating ? 'New custom field' : `Edit “${def!.label}”`}
      description={creating ? undefined : `${def!.target_table}${def!.target_kind ? `:${def!.target_kind}` : ''} · ${def!.key}`}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {!creating ? (
            <Button variant="outline" disabled={busy} onClick={() => { setIsActive(!isActive) }}>
              {isActive ? 'Archive on save' : 'Restore on save'}
            </Button>
          ) : null}
          <Button disabled={busy || !label || (creating && !key)} onClick={save}>
            {busy ? 'Saving…' : creating ? 'Create field' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-1">
        {creating ? (
          <>
            <div className={field}>
              <Label>Applies to</Label>
              <Select value={targetTable} onChange={(e) => { setTargetTable(e.target.value); setTargetKind('') }}>
                {TARGETS.map((t) => (
                  <option key={t.table} value={t.table}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </div>
            {kinds.length > 0 ? (
              <div className={field}>
                <Label>Narrow to kind (optional)</Label>
                <Select value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
                  <option value="">All kinds</option>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {k.replace('_', ' ')}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className={field}>
              <Label>Key <span className="font-normal text-slate-400">(snake_case, permanent)</span></Label>
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="po_number" className="font-mono" />
            </div>
          </>
        ) : null}

        <div className={field}>
          <Label>Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="PO Number" />
        </div>
        <div className={field}>
          <Label>Type</Label>
          <Select value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </div>

        {needsOptions ? (
          <div className={field}>
            <Label>Options</Label>
            <div className="flex flex-wrap gap-1.5">
              {options.map((o) => (
                <Badge key={o} variant="secondary">
                  {o}
                  <button
                    type="button"
                    aria-label={`Remove ${o}`}
                    className="ml-1 opacity-60 hover:opacity-100"
                    onClick={() => setOptions(options.filter((x) => x !== o))}
                  >
                    <X size={11} />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                value={optionDraft}
                onChange={(e) => setOptionDraft(e.target.value)}
                placeholder="Add option…"
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
                  if (optionDraft.trim() && !options.includes(optionDraft.trim())) {
                    setOptions([...options, optionDraft.trim()])
                    setOptionDraft('')
                  }
                }}
              >
                Add
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 pt-1">
          <input
            id="cf-required"
            type="checkbox"
            checked={isRequired}
            onChange={(e) => setIsRequired(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          <Label htmlFor="cf-required">Required</Label>
        </div>
      </div>
    </UrlDrawer>
  )
}
