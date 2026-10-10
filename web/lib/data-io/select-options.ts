/**
 * Case-insensitive enum matching for data-io imports.
 *
 * Operators fill import files with what the product shows them — the drawer's
 * displayed labels ("Company") rather than the stored codes ("company") — and
 * with whatever capitalization their spreadsheet applies. Exact-match
 * validation rejects those files with a bare `invalid value` that names
 * neither the accepted vocabulary nor the remedy, so every resource that
 * validates a select column itself matches through this helper instead.
 *
 * PURE: no db/server imports, so unit tests exercise the real implementation.
 */

export interface SelectMatchOption {
  value: string
  label: string
}

/** Collapse case and separators so "One time", "one_time" and "ONE-TIME" meet. */
function matchKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Resolve an import cell to its canonical stored value. Matches, in order:
 * the exact stored value, the stored value case-insensitively, the displayed
 * label case-insensitively, then a separator-insensitive match that must be
 * unique across values and labels (an ambiguous cell refuses rather than
 * guessing). Extra aliases — for example the same label in another shipped
 * locale — ride as additional options sharing the value. Returns null when
 * nothing matches.
 */
export function matchSelectOption(
  options: readonly SelectMatchOption[],
  raw: unknown,
): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const exact = options.find((o) => o.value === text)
  if (exact) return exact.value
  const folded = text.toLowerCase()
  const byValue = options.find((o) => o.value.toLowerCase() === folded)
  if (byValue) return byValue.value
  const byLabel = options.find((o) => o.label.toLowerCase() === folded)
  if (byLabel) return byLabel.value
  const key = matchKey(text)
  if (!key) return null
  const tolerant = options.filter(
    (o) => matchKey(o.value) === key || matchKey(o.label) === key,
  )
  return tolerant.length === 1 ? tolerant[0]!.value : null
}

/** Canonical stored values, in option order, for refusal and template text. */
export function selectAllowedValues(options: readonly SelectMatchOption[]): string[] {
  return options.map((o) => o.value)
}

/**
 * Fail-closed refusal for an unmatchable enum cell. Names the field, quotes
 * the rejected input, and lists the accepted values so the operator can fix
 * the file without guessing.
 */
export function selectRefusal(
  fieldKey: string,
  raw: unknown,
  options: readonly SelectMatchOption[],
): string {
  return `${fieldKey}: invalid value "${String(raw)}" — use one of: ${selectAllowedValues(options).join(', ')}`
}
