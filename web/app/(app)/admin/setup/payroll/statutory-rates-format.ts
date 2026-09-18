/**
 * Display formatting for employer-entered statutory rate values.
 *
 * Pure (no imports) so the payroll setup surface and its tests share it:
 * decimal-rate fields are entered as decimals (0.006) but read as percents
 * (0.60%), while percent and amount fields render as entered.
 */
export function formatRateFieldValue(
  field: { kind: string; decimals: number },
  value: string,
): string {
  if (field.kind === 'percent') return `${value}%`
  if (field.kind === 'flag') return value === 'true' ? 'Yes' : value === 'false' ? 'No' : value
  if (field.kind !== 'rate') return value
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  // The stored scale stays decimal-precise; the display keeps at least two
  // fractional digits (0.0060 reads 0.60%, never 0.6%) and trims the rest.
  const places = Math.max(0, field.decimals - 2)
  let text = (numeric * 100).toFixed(places)
  while (text.includes('.') && text.endsWith('0') && text.split('.')[1]!.length > 2) {
    text = text.slice(0, -1)
  }
  return `${text}%`
}
