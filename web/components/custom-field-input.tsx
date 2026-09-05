'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FieldLabel, Input, Select, Textarea } from '@openbooks/ui'
import { SearchSelect } from '@openbooks/ui'
import type { CustomFieldDefClient } from './custom-field-inputs'

const REFERENCE_TABLES = ['parties', 'projects', 'accounts', 'items'] as const

/**
 * One custom field's control (edit) or display (view). Extracted from
 * CustomFieldInputs so the layout-driven header renderer can place custom
 * fields individually (with their own col-span) instead of in a fixed grid.
 * The plural <CustomFieldInputs> maps over this.
 */
export function CustomFieldInput({
  def,
  value,
  onChange,
  readOnly = false,
  hideLabel = false,
}: {
  def: CustomFieldDefClient
  value: unknown
  onChange: (value: unknown) => void
  readOnly?: boolean
  /** Suppress the field's own label — for grid cells, where the column header
   * already names the field and repeating it per row would be noise. */
  hideLabel?: boolean
}) {
  const tLabels = useTranslations('common.labels')
  const inputId = useId()

  const displayMode = def.config.displayMode ?? 'normal'
  const isHidden = displayMode === 'hidden'
  const isDisabled = displayMode === 'disabled' || readOnly

  // Apply default value on first render if the field has no value yet.
  const appliedDefault = useRef(false)
  useEffect(() => {
    if (isHidden || isDisabled) { appliedDefault.current = false; return }
    if (appliedDefault.current) return
    if (value === undefined || value === null || value === '') {
      const dv = def.config.defaultValue
      if (dv !== undefined && dv !== null && dv !== '') {
        if (def.fieldType === 'boolean') {
          onChange(dv === true || dv === 'true')
        } else if (def.fieldType === 'multi_select') {
          onChange(Array.isArray(dv) ? dv : [String(dv)])
        } else if (def.fieldType === 'number' || def.fieldType === 'currency') {
          onChange(String(dv))
        } else {
          onChange(dv)
        }
      }
    }
    appliedDefault.current = true
  }, [def, value, onChange, isHidden, isDisabled])

  if (isHidden) return null

  if (isDisabled) {
    return (
      <div className={hideLabel ? undefined : 'space-y-1.5'}>
        {hideLabel ? null : <FieldLabel htmlFor={inputId} help={def.config.helpText}>{def.label}</FieldLabel>}
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {def.fieldType === 'boolean'
            ? value
              ? tLabels('yes')
              : tLabels('no')
            : Array.isArray(value)
              ? value.join(', ')
              : ((value as string) ?? '—')}
        </p>
      </div>
    )
  }

  return (
    <div className={hideLabel ? undefined : 'space-y-1.5'}>
      {hideLabel ? null : (
        <FieldLabel htmlFor={inputId} help={def.config.helpText}>
          {def.label}
          {def.isRequired ? <span className="text-red-500"> *</span> : null}
        </FieldLabel>
      )}
      {def.fieldType === 'long_text' ? (
        <Textarea
          id={inputId}
          aria-label={hideLabel ? def.label : undefined}
          value={(value as string) ?? ''}
          placeholder={def.config.placeholder}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
        />
      ) : def.fieldType === 'boolean' ? (
        <Select
          id={inputId}
          aria-label={hideLabel ? def.label : undefined}
          value={value === true || value === 'true' ? 'true' : value === false || value === 'false' ? 'false' : ''}
          onChange={(e) => onChange(e.target.value === 'true')}
        >
          <option value="">—</option>
          <option value="true">{tLabels('yes')}</option>
          <option value="false">{tLabels('no')}</option>
        </Select>
      ) : def.fieldType === 'select' ? (
        <Select id={inputId} aria-label={hideLabel ? def.label : undefined} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(def.config.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : def.fieldType === 'multi_select' ? (
        <MultiSelectInput
          label={def.label}
          options={def.config.options ?? []}
          value={Array.isArray(value) ? value.map(String) : []}
          onChange={(arr) => onChange(arr)}
        />
      ) : def.fieldType === 'reference' ? (
        <ReferenceInput
          id={inputId}
          def={def}
          value={(value as string) ?? ''}
          onChange={onChange}
        />
      ) : (
        <Input
          id={inputId}
          aria-label={hideLabel ? def.label : undefined}
          type={def.fieldType === 'date' ? 'date' : 'text'}
          inputMode={def.fieldType === 'number' || def.fieldType === 'currency' ? 'decimal' : undefined}
          className={def.fieldType === 'number' || def.fieldType === 'currency' ? 'text-right tabular-nums' : undefined}
          placeholder={def.config.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

/** Multi-select with checkboxes — replaces the text-input fallback. */
function MultiSelectInput({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: string[]
  value: string[]
  onChange: (arr: string[]) => void
}) {
  const toggle = (opt: string) => {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt))
    else onChange([...value, opt])
  }
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2 rounded-md border border-slate-200 p-2 dark:border-slate-800">
      {options.length === 0 ? (
        <span className="text-xs text-slate-400">No options defined</span>
      ) : (
        options.map((opt) => (
          <label
            key={opt}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60"
          >
            <input
              type="checkbox"
              checked={value.includes(opt)}
              onChange={() => toggle(opt)}
              className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
            />
            {opt}
          </label>
        ))
      )}
    </div>
  )
}

/** Reference field — a SearchSelect that fetches options from /api/forms/options. */
function ReferenceInput({
  id,
  def,
  value,
  onChange,
}: {
  id: string
  def: CustomFieldDefClient
  value: string
  onChange: (v: unknown) => void
}) {
  const table = def.config.referenceTable
  const [options, setOptions] = useState<{ value: string; label: string; hint?: string }[]>([])

  useEffect(() => {
    if (!table) return
    const searchParams = new URLSearchParams()
    searchParams.set('source', 'reference')
    searchParams.set('table', table)
    if (def.config.referenceFilter) {
      for (const [k, v] of Object.entries(def.config.referenceFilter)) {
        searchParams.set(`filter_${k}`, v)
      }
    }
    fetch(`/api/forms/options?${searchParams.toString()}`)
      .then((r) => r.json())
      .then((data) => setOptions(data.options ?? []))
      .catch(() => setOptions([]))
  }, [table, def.config.referenceFilter])

  return (
    <SearchSelect
      id={id}
      ariaLabel={def.label}
      value={value}
      onChange={(v) => onChange(v)}
      options={options}
      placeholder="Select a record…"
    />
  )
}
