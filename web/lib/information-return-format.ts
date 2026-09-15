/**
 * Box amount formatting for information-return worksheets and facsimiles.
 *
 * Deliberately free of engine imports: the filing worksheet client component
 * formats amounts in the browser, and pulling information-return-form.ts (which
 * loads the engine's information-returns module and, through it, pg) into the
 * client bundle breaks `next build` with "Module not found: Can't resolve
 * 'dns'/'fs'/'net'/'tls'".
 */
const DECIMAL_TEXT = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/

/** Whether a decimal string is mathematically zero, without a float round-trip. */
export function isZeroDecimalText(value: string | undefined): boolean {
  if (value === undefined) return true
  const raw = value.trim()
  if (raw === '') return true
  if (!DECIMAL_TEXT.test(raw)) return false
  const mantissa = raw.split(/[eE]/, 1)[0]!.replace(/^[-+]/, '')
  return !/[1-9]/.test(mantissa)
}

/** Money as the form prints it: two decimals, thousands separated, blank at zero. */
export function formatBoxAmount(amount: string | undefined): string {
  if (amount === undefined) return ''
  const raw = amount.trim()
  if (!DECIMAL_TEXT.test(raw) || isZeroDecimalText(raw)) return ''
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(raw as never)
  // Keep the old non-finite-input behavior for values such as "1e309".
  return formatted.includes('∞') ? '' : formatted
}
