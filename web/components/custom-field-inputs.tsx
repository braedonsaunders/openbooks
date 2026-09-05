'use client'

import type { LineGridColumn, LineGridOption } from './line-grid'
import { CustomFieldInput } from './custom-field-input'

/** Client-safe shape of a custom field definition (see lib/custom-fields). */
export interface CustomFieldDefClient {
  key: string
  label: string
  fieldType: 'text' | 'long_text' | 'number' | 'currency' | 'date' | 'boolean' | 'select' | 'multi_select' | 'reference'
  config: {
    options?: string[]
    helpText?: string
    placeholder?: string
    defaultValue?: unknown
    min?: number | string
    max?: number | string
    showInList?: boolean
    referenceTable?: string
    referenceFilter?: Record<string, string>
    displayMode?: 'normal' | 'always' | 'hidden' | 'disabled' | 'readonly'
    allowedRoles?: string[]
  }
  isRequired: boolean
}

/** Header-level custom fields: a responsive grid of typed inputs. */
export function CustomFieldInputs({
  defs,
  values,
  onChange,
  readOnly = false,
  userRole,
}: {
  defs: CustomFieldDefClient[]
  values: Record<string, unknown>
  onChange: (values: Record<string, unknown>) => void
  readOnly?: boolean
  /** Current user's role key, used to filter by allowedRoles. */
  userRole?: string
}) {
  const visibleDefs = userRole
    ? defs.filter((d) => !d.config.allowedRoles || d.config.allowedRoles.length === 0 || d.config.allowedRoles.includes(userRole) || userRole === 'admin')
    : defs
  if (visibleDefs.length === 0) return null
  const set = (key: string, v: unknown) => onChange({ ...values, [key]: v })

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visibleDefs.map((def) => (
        <CustomFieldInput
          key={def.key}
          def={def}
          value={values[def.key]}
          onChange={(v) => set(def.key, v)}
          readOnly={readOnly}
        />
      ))}
    </div>
  )
}

/** Line-level custom fields become LineGrid columns. */
export function customFieldColumns<Row extends Record<string, unknown>>(
  defs: CustomFieldDefClient[],
): LineGridColumn<Row>[] {
  return defs
    .filter((d) => d.config.displayMode !== 'hidden')
    .map((def) => {
      const base = { key: `cf_${def.key}`, label: def.label, help: def.config.helpText, required: def.isRequired }
      if (def.config.displayMode === 'disabled' || def.config.displayMode === 'readonly') {
        return { ...base, width: 'minmax(120px,1fr)', type: 'readonly' as const, render: (row: Row) => {
          const value = row[base.key]
          return Array.isArray(value) ? value.join(', ') : String(value ?? '')
        } }
      }
      switch (def.fieldType) {
        case 'select':
          return {
            ...base,
            width: '130px',
            type: 'select' as const,
            options: [{ value: '', label: '—' }, ...(def.config.options ?? []).map((o): LineGridOption => ({ value: o, label: o }))],
          }
        case 'multi_select':
          return {
            ...base,
            width: '160px',
            type: 'text' as const,
            placeholder: def.label,
          }
        case 'number':
          return { ...base, width: '110px', type: 'decimal' as const, decimalScale: 8, align: 'right' as const }
        case 'currency':
          return { ...base, width: '110px', type: 'amount' as const, align: 'right' as const }
        case 'date':
          return { ...base, width: '130px', type: 'text' as const, placeholder: 'YYYY-MM-DD' }
        case 'boolean':
          return { ...base, width: '70px', type: 'text' as const }
        case 'reference':
          return { ...base, width: '160px', type: 'text' as const }
        default:
          return { ...base, width: 'minmax(120px,1fr)', type: 'text' as const }
      }
    })
}
