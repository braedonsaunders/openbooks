'use client'

// Shared renderer for a custom record type's FormField[] — the single editor
// used by the record flyout (and reusable anywhere a flat forms-core field
// list needs editing). Renders every record field type with @openbooks/ui
// inputs, evaluates forms-core conditional visibility (showIf) and formula
// fields live, and feeds the gl_account/party pickers from
// /api/forms/options (module-level cached per source).

import { useEffect, useMemo, useRef, useState } from 'react'
import { Star } from 'lucide-react'
import { useTranslations } from 'next-intl'
import {
  evaluateLogicRule,
  type FieldValueMap,
  type FormField,
  type PartyPickerKind,
} from '@openbooks/forms-core'
import { cn, Input, Label, SearchSelect, Textarea, type SelectOption } from '@openbooks/ui'
import { formatFieldValue, withComputedFormulas } from '../lib/record-schema'

// --- /api/forms/options cache ------------------------------------------------

const optionsCache = new Map<string, Promise<SelectOption[]>>()

function fetchOptions(source: 'gl_accounts' | 'parties', partyKind?: PartyPickerKind) {
  const key = source === 'parties' ? `parties:${partyKind ?? 'any'}` : source
  let cached = optionsCache.get(key)
  if (!cached) {
    const qs = new URLSearchParams({ source })
    if (source === 'parties' && partyKind && partyKind !== 'any') qs.set('partyKind', partyKind)
    cached = fetch(`/api/forms/options?${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('options request failed')
        const data = (await res.json()) as { options: SelectOption[] }
        return data.options
      })
      .catch((err) => {
        optionsCache.delete(key) // allow a retry on the next mount
        throw err
      })
    optionsCache.set(key, cached)
  }
  return cached
}

function useEntityOptions(source: 'gl_accounts' | 'parties', partyKind?: PartyPickerKind) {
  const [options, setOptions] = useState<SelectOption[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setFailed(false)
    fetchOptions(source, partyKind).then(
      (opts) => alive && setOptions(opts),
      () => alive && setFailed(true),
    )
    return () => {
      alive = false
    }
  }, [source, partyKind])
  return { options, failed }
}

// --- Field sub-inputs ----------------------------------------------------------

/**
 * Numeric input with a local text buffer so partial entries ("12.", "-")
 * don't get destroyed by the parent's number round-trip. Commits `number`
 * upward when parseable, `undefined` when cleared.
 */
function NumberInput({
  value,
  onCommit,
  disabled,
  invalid,
  align,
  placeholder,
}: {
  value: unknown
  onCommit: (v: number | undefined) => void
  disabled: boolean
  invalid: boolean
  align: 'left' | 'right'
  placeholder?: string
}) {
  const [text, setText] = useState(typeof value === 'number' ? String(value) : '')
  const focused = useRef(false)
  useEffect(() => {
    if (focused.current) return
    const incoming = typeof value === 'number' ? String(value) : ''
    setText((prev) => (Number(prev) === Number(incoming) && prev !== '' && incoming !== '' ? prev : incoming))
  }, [value])
  return (
    <Input
      inputMode="decimal"
      placeholder={placeholder ?? '0'}
      value={text}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      className={cn(align === 'right' && 'text-right tabular-nums', invalid && 'border-red-400 dark:border-red-700')}
      onFocus={() => {
        focused.current = true
      }}
      onBlur={() => {
        focused.current = false
      }}
      onChange={(e) => {
        const next = e.target.value
        setText(next)
        if (next.trim() === '') onCommit(undefined)
        else {
          const n = Number(next)
          if (Number.isFinite(n)) onCommit(n)
        }
      }}
    />
  )
}

function RatingInput({
  value,
  max,
  onCommit,
  disabled,
}: {
  value: unknown
  max: number
  onCommit: (v: number | undefined) => void
  disabled: boolean
}) {
  const t = useTranslations('ui.recordFields')
  const current = typeof value === 'number' ? value : 0
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label={t('ratingAria', { max })}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={current === n}
          aria-label={t('ratingValueAria', { value: n, max })}
          disabled={disabled}
          onClick={() => onCommit(current === n ? undefined : n)}
          className={cn(
            'rounded p-0.5 transition-colors',
            disabled ? 'cursor-default' : 'hover:text-amber-500',
            n <= current ? 'text-amber-500' : 'text-slate-300 dark:text-slate-600',
          )}
        >
          <Star size={18} fill={n <= current ? 'currentColor' : 'none'} />
        </button>
      ))}
      {current > 0 ? (
        <span className="ml-1 text-xs text-slate-500 tabular-nums dark:text-slate-400">
          {current}/{max}
        </span>
      ) : null}
    </div>
  )
}

function EntityPicker({
  field,
  value,
  onCommit,
  disabled,
  invalid,
}: {
  field: FormField
  value: unknown
  onCommit: (v: string | undefined) => void
  disabled: boolean
  invalid: boolean
}) {
  const t = useTranslations('ui.recordFields')
  const tCommon = useTranslations('common')
  const source = field.type === 'gl_account' ? 'gl_accounts' : 'parties'
  const partyKind =
    field.type === 'party' && typeof field.config?.partyKind === 'string'
      ? (field.config.partyKind as PartyPickerKind)
      : undefined
  const { options, failed } = useEntityOptions(source, partyKind)
  const current = typeof value === 'string' ? value : ''
  const withSelected = useMemo(() => {
    if (!options) return []
    if (current && !options.some((o) => o.value === current)) {
      // Stored ref to a row the feed no longer returns (deactivated since) —
      // keep it selectable so opening the drawer doesn't silently blank it.
      return [{ value: current, label: t('inactiveSelected') }, ...options]
    }
    return options
  }, [options, current, t])
  if (failed) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        {field.type === 'gl_account' ? t('loadAccountsFailed') : t('loadPartiesFailed')}
      </p>
    )
  }
  return (
    <SearchSelect
      options={withSelected}
      value={current}
      onChange={(v) => onCommit(v || undefined)}
      placeholder={
        options
          ? field.type === 'gl_account'
            ? t('selectAccount')
            : t('selectParty')
          : tCommon('feedback.loading')
      }
      disabled={disabled || !options}
      clearable={!field.required && !field.validation?.required}
      emptyLabel={tCommon('labels.none')}
      loading={!options}
      invalid={invalid}
      ariaLabel={field.label}
    />
  )
}

// --- Main renderer -------------------------------------------------------------

export function RecordFields({
  fields,
  values,
  onChange,
  disabled = false,
  errors = {},
}: {
  fields: FormField[]
  values: FieldValueMap
  /** Called with the field id and the new value (undefined clears). */
  onChange: (fieldId: string, value: unknown) => void
  /** Read-only rendering (inactive records). */
  disabled?: boolean
  /** fieldId → message, e.g. the PATCH route's validation errors. */
  errors?: Record<string, string>
}) {
  const t = useTranslations('ui.recordFields')
  // Formula values recompute live so dependent fields update as you type;
  // showIf visibility evaluates against the same computed context.
  const computed = useMemo(() => withComputedFormulas(fields, values), [fields, values])
  const ctx = useMemo(() => ({ values: computed, rows: {} }), [computed])

  const visibleFields = fields.filter((f) => !f.showIf || evaluateLogicRule(f.showIf, ctx))
  if (visibleFields.length === 0) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{t('noFields')}</p>
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visibleFields.map((field) => {
        const wide = field.type === 'long_text' || field.type === 'multi_select'
        const error = errors[field.id]
        const required = Boolean(field.required || field.validation?.required)
        return (
          <div key={field.id} className={cn('space-y-1.5', wide && 'sm:col-span-2')}>
            <Label>
              {field.label}
              {required ? <span className="ml-0.5 text-red-500">*</span> : null}
            </Label>
            <FieldInput
              field={field}
              value={computed[field.id]}
              onCommit={(v) => onChange(field.id, v)}
              disabled={disabled}
              invalid={Boolean(error)}
            />
            {error ? (
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            ) : field.helpText ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">{field.helpText}</p>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function FieldInput({
  field,
  value,
  onCommit,
  disabled,
  invalid,
}: {
  field: FormField
  value: unknown
  onCommit: (v: unknown) => void
  disabled: boolean
  invalid: boolean
}) {
  const tCommon = useTranslations('common.labels')
  const invalidClass = invalid ? 'border-red-400 dark:border-red-700' : undefined
  switch (field.type) {
    case 'text':
      return (
        <Input
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={invalidClass}
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'long_text':
      return (
        <Textarea
          value={typeof value === 'string' ? value : ''}
          rows={3}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={invalidClass}
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'number': {
      const unit = typeof field.config?.unit === 'string' ? field.config.unit : ''
      return (
        <div className="flex items-center gap-2">
          <NumberInput value={value} onCommit={onCommit} disabled={disabled} invalid={invalid} align="left" />
          {unit ? <span className="shrink-0 text-sm text-slate-500 dark:text-slate-400">{unit}</span> : null}
        </div>
      )
    }
    case 'currency':
      return (
        <NumberInput
          value={value}
          onCommit={onCommit}
          disabled={disabled}
          invalid={invalid}
          align="right"
          placeholder="0.00"
        />
      )
    case 'percentage':
      return (
        <div className="flex items-center gap-2">
          <NumberInput value={value} onCommit={onCommit} disabled={disabled} invalid={invalid} align="right" />
          <span className="shrink-0 text-sm text-slate-500 dark:text-slate-400">%</span>
        </div>
      )
    case 'date':
      return (
        <Input
          type="date"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={invalidClass}
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'datetime':
      return (
        <Input
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={invalidClass}
          onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
        />
      )
    case 'select': {
      const options = (field.validation?.options ?? []).map((o) => ({ value: o.value, label: o.label }))
      return (
        <SearchSelect
          options={options}
          value={typeof value === 'string' ? value : ''}
          onChange={(v) => onCommit(v || undefined)}
          disabled={disabled}
          clearable={!field.required && !field.validation?.required}
          emptyLabel={tCommon('none')}
          invalid={invalid}
          ariaLabel={field.label}
        />
      )
    }
    case 'radio': {
      const options = field.validation?.options ?? []
      const current = typeof value === 'string' ? value : ''
      return (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={field.label}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={current === o.value}
              disabled={disabled}
              onClick={() => onCommit(current === o.value ? undefined : o.value)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm transition-colors',
                current === o.value
                  ? 'border-teal-300 bg-teal-50 font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600',
                disabled && 'opacity-60',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      )
    }
    case 'multi_select': {
      const options = field.validation?.options ?? []
      const current = Array.isArray(value) ? (value as string[]) : []
      return (
        <div className="flex flex-wrap gap-1.5">
          {options.map((o) => {
            const on = current.includes(o.value)
            return (
              <button
                key={o.value}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={disabled}
                onClick={() => {
                  const next = on ? current.filter((v) => v !== o.value) : [...current, o.value]
                  onCommit(next.length > 0 ? next : undefined)
                }}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-sm transition-colors',
                  on
                    ? 'border-teal-300 bg-teal-50 font-medium text-teal-800 dark:border-teal-800 dark:bg-teal-950/50 dark:text-teal-300'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600',
                  disabled && 'opacity-60',
                )}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      )
    }
    case 'rating': {
      const max =
        typeof field.config?.max === 'number' && Number.isInteger(field.config.max)
          ? field.config.max
          : 5
      return <RatingInput value={value} max={max} onCommit={onCommit} disabled={disabled} />
    }
    case 'formula': {
      const text = formatFieldValue(field, value)
      const numeric =
        typeof field.config?.format !== 'string' || field.config.format !== 'text'
      return (
        <div
          className={cn(
            'flex h-9 items-center rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-200',
            numeric && 'justify-end tabular-nums',
          )}
        >
          {text || <span className="text-slate-400 dark:text-slate-500">—</span>}
        </div>
      )
    }
    case 'gl_account':
    case 'party':
      return (
        <EntityPicker
          field={field}
          value={value}
          onCommit={onCommit}
          disabled={disabled}
          invalid={invalid}
        />
      )
    default:
      // signature/file never reach records (lintRecordFields rejects them).
      return null
  }
}
