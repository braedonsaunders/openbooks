"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Input } from "@openbooks/ui";
import { canonicalDecimal } from "@openbooks/engine/money/decimal";
import {
  decimalNullCause,
  decimalNullRefusal,
  readLocaleDecimal,
} from "@openbooks/engine/money/decimal-refusal";
import { decimalSeparators, formatDecimal } from "../lib/money-format";

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
  const text = raw.trim();
  if (text === "") {
    return options.required ? `${field} is empty — enter ${noun}` : null;
  }
  if (canonicalDecimal(text, maxScale) !== null) return null;
  return decimalNullRefusal(field, noun, raw, maxScale);
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
  const canonical = canonicalDecimal(raw, maxScale);
  if (canonical !== null) return { value: canonical, error: null };
  const cause = decimalNullCause(raw);
  if (cause.cause === "decimal-comma") {
    const localized = canonicalDecimal(cause.dotted, maxScale);
    if (localized !== null) return { value: localized, error: null };
    return {
      value: null,
      error: decimalNullRefusal(field, "a money amount", cause.dotted, maxScale),
    };
  }
  return { value: null, error: decimalNullRefusal(field, "a money amount", raw, maxScale) };
}

/**
 * A grouped field's value as the viewer reads and types it: the exact
 * decimal for text written in the viewer's locale (its own grouping, or the
 * plain dotted form), or why it reads as no single amount.
 */
export function readGroupedAmount(locale: string, raw: string, maxScale = 4) {
  return readLocaleDecimal(raw, decimalSeparators(locale), maxScale);
}

/**
 * The editable text of a grouped amount on focus: the viewer's decimal
 * separator with no grouping and no ledger zeros, so a selection replaced by
 * typing, or a caret placed in the digits, edits the number itself.
 */
export function editableAmount(locale: string, value: string, maxScale = 4): string {
  const canonical = canonicalDecimal(value.trim(), maxScale);
  if (canonical === null) return value;
  return formatDecimal(locale, canonical, {
    useGrouping: false,
    minimumFractionDigits: 0,
    maximumFractionDigits: maxScale,
  });
}

type GroupedRefusal = { message: string; remedy: string };

/**
 * The refusal for a grouped amount in the viewer's language, naming its
 * cause and the form it accepts, written with the separators the field
 * itself displays. Null when the text reads as one amount.
 */
export function useGroupedAmountRefusal(): (
  field: string,
  raw: string,
  options?: { maxScale?: number; required?: boolean },
) => GroupedRefusal | null {
  const t = useTranslations("common.moneyInput");
  const locale = useLocale();
  return (field, raw, { maxScale = 4, required = false } = {}) => {
    const example = formatDecimal(locale, "1234567.89", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const { decimal } = decimalSeparators(locale);
    if (raw.trim() === "")
      return required
        ? { message: t("empty", { field }), remedy: t("emptyRemedy", { example }) }
        : null;
    const reading = readGroupedAmount(locale, raw, maxScale);
    const value = raw.trim();
    switch (reading.kind) {
      case "value":
        return null;
      case "ambiguous": {
        const shown = (amount: string) =>
          formatDecimal(locale, amount, { maximumFractionDigits: maxScale });
        return {
          message: t("ambiguous", {
            field,
            value,
            grouped: shown(reading.grouped),
            dotted: shown(reading.dotted),
          }),
          remedy: t("ambiguousRemedy", { decimal, example }),
        };
      }
      case "scale":
        return {
          message: t("scale", { field, places: maxScale }),
          remedy: t("scaleRemedy", { value, places: maxScale }),
        };
      case "unreadable":
        return {
          message: t("unreadable", { field, value }),
          remedy: t("unreadableRemedy", { decimal, example }),
        };
    }
  };
}

export function MoneyInput({
  id,
  ariaLabel,
  value,
  onChange,
  field,
  noun = "a money amount",
  maxScale = 4,
  required = false,
  placeholder = "0.00",
  disabled = false,
  className,
  autoFocus = false,
  grouped = false,
  invalid = false,
  showError = true,
  onFocusChange,
}: {
  id?: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  /** Field name carried into the refusal, e.g. "Allowance". */
  field: string;
  /** What the value is, e.g. "a money amount" or "a number of hours". */
  noun?: string;
  /** Must match the server's scale for the field (money is 4 here). */
  maxScale?: number;
  /** When false (grids, profile facts), blank means "nothing entered". */
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  /**
   * Show a valid amount in the viewer's locale (grouped, at least two
   * places) while the field is not being edited. Focus shows the editable
   * digits in the viewer's notation, selected so typing replaces them; text
   * typed or pasted in the viewer's own grouping reads as the amount it
   * shows, and `onChange` receives the exact decimal.
   */
  grouped?: boolean;
  /** The caller's own refusal of the value (beside the shared classifier's). */
  invalid?: boolean;
  /** False where the caller states the refusal itself (a toolbar field whose body names it). */
  showError?: boolean;
  onFocusChange?: (focused: boolean) => void;
}) {
  const locale = useLocale();
  const groupedRefusal = useGroupedAmountRefusal();
  const inputRef = useRef<HTMLInputElement>(null);
  const [touched, setTouched] = useState(false);
  const [focused, setFocused] = useState(false);
  // While a grouped field is edited it shows the text as typed; the caller
  // holds the exact decimal that text reads as (or the text itself when it
  // reads as none, so its own validation refuses it).
  const [draft, setDraft] = useState<{ text: string; emitted: string } | null>(null);
  // Focus replaces the grouped display with the editable digits; the whole
  // value is then selected so typing replaces it, by Tab or by click.
  const selectOnFocus = useRef(false);
  const keepSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focused || !selectOnFocus.current) return;
    selectOnFocus.current = false;
    inputRef.current?.select();
  }, [focused]);
  const text = grouped && focused && draft !== null && draft.emitted === value ? draft.text : value;
  const refusal = grouped ? groupedRefusal(field, text, { maxScale, required }) : null;
  const error = grouped
    ? refusal
      ? `${refusal.message} ${refusal.remedy}`
      : null
    : moneyFieldError(field, noun, value, maxScale, { required });
  // A pristine required field disables its submit without scolding the
  // operator first — the refusal appears once they have typed or left it.
  const shown = error !== null && (touched || value.trim() !== "");
  const errorId = id !== undefined ? `${id}-error` : undefined;
  const reading = grouped && !focused ? readGroupedAmount(locale, value, maxScale) : null;
  const display = !grouped
    ? value
    : focused
      ? text
      : reading?.kind === "value"
        ? formatDecimal(locale, reading.value, {
            minimumFractionDigits: Math.min(2, maxScale),
            maximumFractionDigits: maxScale,
          })
        : value;
  return (
    <div>
      <Input
        ref={inputRef}
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
          setTouched(true);
          if (!grouped) {
            onChange(event.target.value);
            return;
          }
          const typed = event.target.value;
          const read = readGroupedAmount(locale, typed, maxScale);
          const emitted = read.kind === "value" ? read.value : typed;
          setDraft({ text: typed, emitted });
          onChange(emitted);
        }}
        onFocus={() => {
          if (grouped) {
            const editable = editableAmount(locale, value, maxScale);
            setDraft({ text: editable, emitted: value });
            selectOnFocus.current = true;
            keepSelection.current = true;
          }
          setFocused(true);
          onFocusChange?.(true);
        }}
        onMouseUp={(event) => {
          // The click that focused the field would collapse the selection
          // the focus made; later clicks place the caret as usual.
          if (keepSelection.current) event.preventDefault();
          keepSelection.current = false;
        }}
        onKeyDown={() => {
          keepSelection.current = false;
        }}
        onBlur={() => {
          setTouched(true);
          setFocused(false);
          setDraft(null);
          keepSelection.current = false;
          onFocusChange?.(false);
        }}
      />
      {shown && showError && (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
