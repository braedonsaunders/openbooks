/**
 * Exact journal-line amount arithmetic for the client-side journal drawer.
 * Ledger amounts are numeric(19,4); these helpers mirror the semantics of
 * engine/src/money.ts (toUnits/fromUnits) in plain string/bigint math so UI
 * parsing and balancing never cross the binary floating-point boundary —
 * including sub-cent (3–4 decimal) lines.
 */

const SCALE = 10_000n

/**
 * Parse an amount into exact numeric(19,4) units. '' / null / undefined → 0n;
 * null when the text is not a plain decimal or carries precision beyond four
 * places — the same contract as the server's toUnits, so the API is never
 * surprised by anything the drawer accepted.
 */
export function journalAmountUnits(value: unknown): bigint | null {
  if (value == null || value === '') return 0n
  const raw = String(value).trim()
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return null
  const negative = raw.startsWith('-')
  const [whole = '', fraction = ''] = raw.replace(/^[-+]/, '').split('.')
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) return null
  const units = BigInt(whole || '0') * SCALE + BigInt((fraction + '0000').slice(0, 4))
  return negative ? -units : units
}

/** Signed line total (+debit / −credit) in units; null when either side is invalid. */
export function journalLineUnits(debit: unknown, credit: unknown): bigint | null {
  const d = journalAmountUnits(debit)
  if (d === null) return null
  const c = journalAmountUnits(credit)
  if (c === null) return null
  return d - c
}

/** Format exact units back to the ledger's fixed four-decimal string. */
export function formatJournalAmount(units: bigint): string {
  const negative = units < 0n
  const absolute = negative ? -units : units
  return `${negative ? '-' : ''}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(4, '0')}`
}
