import { canonicalDecimal } from './exact-decimal.ts'

/**
 * Exact decimal presentation for transaction-line quantities and commercial
 * rates. PostgreSQL returns numeric(28,8) values at their declared scale; the
 * trailing zeroes are storage detail, not useful UI precision.
 */
export function displayLineDecimal(value: unknown, maxScale = 8): string {
  if (value == null || value === '') return ''
  const raw = String(value).trim()
  return canonicalDecimal(raw, maxScale) ?? raw
}

/** Normalize a line-grid decimal without crossing the floating-point boundary. */
export function normalizeLineDecimal(value: unknown, maxScale = 8): string | null {
  if (value == null || String(value).trim() === '') return ''
  return canonicalDecimal(value, maxScale)
}

export function invalidLineDecimal(value: unknown, maxScale = 8): boolean {
  return value != null
    && String(value).trim() !== ''
    && canonicalDecimal(value, maxScale) == null
}
