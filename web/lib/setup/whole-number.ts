/**
 * Whole-number boundary fold shared by the HRM shape validators (leave
 * policies, benefit plans).
 *
 * A strict whole-number string or number crosses as an integer ('-1'
 * crosses too — negativity is refused after the fold), a blank rides as
 * undefined (the caller maps it to null when the field is optional, or
 * refuses it when required), and anything else ('1.5', 'abc') rides through
 * untouched so the shape refusal fires on the original value with the
 * field's own words — this fold never invents a refusal of its own.
 *
 * PURE with zero imports: coerce.ts cannot host it, because coerce pulls
 * the entity registry at module-eval time while the registry pulls every
 * validator — a value import from any validator back into coerce closes a
 * runtime cycle that explodes depending on which module loads first.
 */
export function foldWholeNumber(value: unknown): unknown {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(n) ? n : value
}
