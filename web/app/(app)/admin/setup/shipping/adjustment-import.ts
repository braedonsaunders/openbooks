/**
 * Parse a pasted carrier billing export into adjustment import rows. Every
 * unusable paste refuses by name with the fix, so an operator in the middle of
 * reconciliation never loses the paste to a raw syntax error.
 */

export const ADJUSTMENT_KINDS = [
  'weight_correction',
  'dimension_correction',
  'address_correction',
  'fuel',
  'duplicate',
  'other',
] as const

export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]

export type AdjustmentImportItem = {
  providerAdjustmentId: string
  providerShipmentId: string
  kind: AdjustmentKind
  amount: string
  currency: string
  reason?: string | null
  occurredAt?: string | null
}

export type AdjustmentParseResult =
  | { ok: true; items: AdjustmentImportItem[] }
  | { ok: false; message: string }

const REQUIRED_TEXT = ['providerAdjustmentId', 'providerShipmentId', 'amount', 'currency'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAdjustmentItems(text: string): AdjustmentParseResult {
  if (text.trim() === '') {
    return { ok: false, message: 'Paste the billing export from the carrier account (a JSON array of adjustments) before importing.' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `The pasted text is not valid JSON (${detail}). Paste the export exactly as the carrier account produced it.` }
  }
  const rows = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : null
  if (rows === null) {
    return { ok: false, message: 'The paste must be one adjustment object or an array of adjustment objects; nothing was imported.' }
  }
  if (rows.length === 0) {
    return { ok: false, message: 'The paste holds no adjustments. Paste the billing export rows to import.' }
  }
  const items: AdjustmentImportItem[] = []
  for (const [index, row] of rows.entries()) {
    const label = `row ${index + 1}`
    if (!isRecord(row)) {
      return { ok: false, message: `The adjustment at ${label} is not an object. Each row needs providerAdjustmentId, providerShipmentId, kind, amount and currency.` }
    }
    for (const field of REQUIRED_TEXT) {
      const value = row[field]
      if (typeof value !== 'string' || value.trim() === '') {
        return { ok: false, message: `The adjustment at ${label} has no ${field}. Add it from the carrier export and paste again.` }
      }
    }
    const kind = row.kind
    if (typeof kind !== 'string' || !(ADJUSTMENT_KINDS as readonly string[]).includes(kind)) {
      return { ok: false, message: `The adjustment at ${label} has kind "${String(kind)}". Use one of: ${ADJUSTMENT_KINDS.join(', ')}.` }
    }
    items.push({
      providerAdjustmentId: String(row.providerAdjustmentId).trim(),
      providerShipmentId: String(row.providerShipmentId).trim(),
      kind: kind as AdjustmentKind,
      amount: String(row.amount).trim(),
      currency: String(row.currency).trim().toUpperCase(),
      reason: typeof row.reason === 'string' ? row.reason : null,
      occurredAt: typeof row.occurredAt === 'string' ? row.occurredAt : null,
    })
  }
  return { ok: true, items }
}
