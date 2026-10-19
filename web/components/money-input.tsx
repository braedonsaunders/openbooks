'use client'

import { useState } from 'react'
import { useLocale } from 'next-intl'
import { Input } from '@openbooks/ui'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import { decimalNullCause, decimalNullRefusal } from '@openbooks/engine/money/decimal-refusal'
import { formatDecimal } from '../lib/money-format'

/**
 * One operator-typed money (or hours) answer, refused with a named cause
 * and remedy BEFORE it is submitted — through the single shared decimal
 * classifier, never a second one.
 *
 * `canonicalDecimal` returns null for seven different reasons (too many
 * decimals, thousands separator, decimal comma, ambiguous comma, currency
 * symbol, scientific notation, genuinely non-numeric) and they need seven
 * different remedies: seven installed payroll packs are decimal-comma
 * locales, so `12,34` is twelve-thirty-four written correctly and telling
 * that operator to "remove the thousands separator" manufactures a 100x
 * payroll error. The classifier this calls already encodes the
 * last-separator-wins rule and names both readings of a genuinely ambiguous
 * comma instead of guessing. Call sites pass the field through untouched —
 * the server stays strict and re-validates every value it receives.
 */
export function moneyFieldError(
  field: string,
  noun: string,
  raw: string,
  maxScale = 4,
  options: { required?: boolean } = {},
): string | null {
  const text = raw.trim()
  if (text === '') {
    return options.required ? `${field} is empty — enter ${noun}` : null
  }
  if (canonicalDecimal(text, maxScale) !== null) return null
  return decimalNullRefusal(field, noun, raw, maxScale)
}

/**
 * Parse a single localized money token exactly. The shared decimal-refusal
 * classifier resolves decimal-comma forms by its last-separator rule and
 * refuses genuinely ambiguous commas; this adds no second numeric grammar.
 */
export function parseLocalizedMoneyValue(
  field: string,
  raw: string,
  maxScale = 4,
): { value: string; error: null } | { value: null; error: string } {
  const canonical = canonicalDecimal(raw, maxScale)
  if (canonical !== null) return { value: canonical, error: null }
  const cause = decimalNullCause(raw)
  if (cause.cause === 'decimal-comma') {
    const localized = canonicalDecimal(cause.dotted, maxScale)
    if (localized !== null) return { value: localized, error: null }
    return { value: null, error: decimalNullRefusal(field, 'a money amount', cause.dotted, maxScale) }
  }
  return { value: null, error: decimalNullRefusal(field, 'a money amount', raw, maxScale) }
}

export function MoneyInput({
  id,
  ariaLabel,
  value,
  onChange,
  field,
  noun = 'a money amount',
  maxScale = 4,
  required = false,
  placeholder = '0.00',
  disabled = false,
  className,
  autoFocus = false,
  grouped = false,
  invalid = false,
  showError = true,
  onFocusChange,
}: {
  id?: string
  ariaLabel?: string
  value: string
  onChange: (value: string) => void
  /** Field name carried into the refusal, e.g. "Allowance". */
  field: string
  /** What the value is, e.g. "a money amount" or "a number of hours". */
  noun?: string
  /** Must match the server's scale for the field (money is 4 here). */
  maxScale?: number
  /** When false (grids, profile facts), blank means "nothing entered". */
  required?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
  autoFocus?: boolean
  /**
   * Show a valid amount in the viewer's locale (grouped, at least two
   * places) while the field is not being edited; editing shows the value as
   * typed, so the operator never edits separators the parser would refuse.
   */
  grouped?: boolean
  /** The caller's own refusal of the value (beside the shared classifier's). */
  invalid?: boolean
  /** False where the caller states the refusal itself (a toolbar field whose body names it). */
  showError?: boolean
  onFocusChange?: (focused: boolean) => void
}) {
  const locale = useLocale()
  const [touched, setTouched] = useState(false)
  const [focused, setFocused] = useState(false)
  const error = moneyFieldError(field, noun, value, maxScale, { required })
  // A pristine required field disables its submit without scolding the
  // operator first — the refusal appears once they have typed or left it.
  const shown = error !== null && (touched || value.trim() !== '')
  const errorId = id !== undefined ? `${id}-error` : undefined
  const canonical = grouped && !focused ? canonicalDecimal(value.trim(), maxScale) : null
  const display = canonical !== null
    ? formatDecimal(locale, canonical, { minimumFractionDigits: Math.min(2, maxScale), maximumFractionDigits: maxScale })
    : value
  return (
    <div>
      <Input
        id={id}
        aria-label={ariaLabel}
        inputMode="decimal"
        value={display}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={shown || invalid}
        aria-describedby={shown && showError ? errorId : undefined}
        className={className}
        onChange={(event) => {
          setTouched(true)
          onChange(event.target.value)
        }}
        onFocus={() => {
          setFocused(true)
          onFocusChange?.(true)
        }}
        onBlur={() => {
          setTouched(true)
          setFocused(false)
          onFocusChange?.(false)
        }}
      />
      {shown && showError && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
