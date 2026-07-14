'use client'

import { Input, Label, Select, Textarea } from '@openbooks/ui'
import type { LineGridColumn, LineGridOption } from './line-grid'

/** Client-safe shape of a custom field definition (see lib/custom-fields). */
export interface CustomFieldDefClient {
  key: string
  label: string
  fieldType: 'text' | 'long_text' | 'number' | 'currency' | 'date' | 'boolean' | 'select' | 'multi_select'
  config: {
    options?: string[]
    helpText?: string
    placeholder?: string
    defaultValue?: unknown
    min?: number
    max?: number
    showInList?: boolean
  }
  isRequired: boolean
}

/** Header-level custom fields: a responsive grid of typed inputs. */
export function CustomFieldInputs({
  defs,
  values,
  onChange,
  readOnly = false,
}: {
  defs: CustomFieldDefClient[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  readOnly?: boolean
}) {
  if (defs.length === 0) return null
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v })

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {defs.map((def) => {
        const v = values[def.key]
        if (readOnly) {
          return (
            <div key={def.key} className="space-y-1.5">
              <Label>{def.label}</Label>
              <p className="text-sm">
                {def.fieldType === 'boolean'
                  ? v
                    ? 'Yes'
                    : 'No'
                  : Array.isArray(v)
                    ? v.join(', ')
                    : ((v as string) ?? '—')}
              </p>
            </div>
          )
        }
        return (
          <div key={def.key} className="space-y-1.5">
            <Label>
              {def.label}
              {def.isRequired ? <span className="text-red-500"> *</span> : null}
            </Label>
            {def.fieldType === 'long_text' ? (
              <Textarea value={(v as string) ?? ''} placeholder={def.config.placeholder} onChange={(e) => set(def.key, e.target.value)} rows={2} />
            ) : def.fieldType === 'boolean' ? (
              <Select value={v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : ''} onChange={(e) => set(def.key, e.target.value === 'true')}>
                <option value="">—</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : def.fieldType === 'select' ? (
              <Select value={(v as string) ?? ''} onChange={(e) => set(def.key, e.target.value)}>
                <option value="">—</option>
                {(def.config.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={def.fieldType === 'date' ? 'date' : 'text'}
                inputMode={def.fieldType === 'number' || def.fieldType === 'currency' ? 'decimal' : undefined}
                className={def.fieldType === 'number' || def.fieldType === 'currency' ? 'text-right tabular-nums' : undefined}
                placeholder={def.config.placeholder}
                value={(v as string) ?? ''}
                onChange={(e) => set(def.key, e.target.value)}
              />
            )}
            {def.config.helpText ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{def.config.helpText}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Line-level custom fields become LineGrid columns. */
export function customFieldColumns<Row extends Record<string, unknown>>(
  defs: CustomFieldDefClient[],
): LineGridColumn<Row>[] {
  return defs.map((def) => {
    const base = { key: `cf_${def.key}`, label: def.label, required: def.isRequired }
    switch (def.fieldType) {
      case 'select':
        return {
          ...base,
          width: '130px',
          type: 'select' as const,
          options: [{ value: '', label: '—' }, ...(def.config.options ?? []).map((o): LineGridOption => ({ value: o, label: o }))],
        }
      case 'number':
      case 'currency':
        return { ...base, width: '110px', type: 'amount' as const, align: 'right' as const }
      case 'date':
        return { ...base, width: '130px', type: 'text' as const, placeholder: 'YYYY-MM-DD' }
      default:
        return { ...base, width: 'minmax(120px,1fr)', type: 'text' as const }
    }
  })
}
