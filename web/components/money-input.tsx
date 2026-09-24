'use client'

import { useState } from 'react'
import { Input } from '@openbooks/ui'
import { canonicalDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { decimalNullRefusal } from '@openbooks/engine/src/money/decimal-refusal.ts'

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
}) {
  const [touched, setTouched] = useState(false)
  const error = moneyFieldError(field, noun, value, maxScale, { required })
  // A pristine required field disables its submit without scolding the
  // operator first — the refusal appears once they have typed or left it.
  const shown = error !== null && (touched || value.trim() !== '')
  const errorId = id !== undefined ? `${id}-error` : undefined
  return (
    <div>
      <Input
        id={id}
        aria-label={ariaLabel}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-invalid={shown}
        aria-describedby={shown ? errorId : undefined}
        className={className}
        onChange={(event) => {
          setTouched(true)
          onChange(event.target.value)
        }}
        onBlur={() => setTouched(true)}
      />
      {shown && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  )
}
