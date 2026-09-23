import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { parseItemRateDecimal } from './item-rate-numerics'
import { isUuid } from './list-params'

export interface TimeTypeRateMap {
  /** Row label used in refusals, e.g. "Row 3" or "Rate unit 2". */
  label: string
  raw: unknown
}

/**
 * ONE shared validator for per-time-type premium maps, used by both rate
 * writers (PRC5). Every key must be an ACTIVE time type of THIS org — a
 * single org-scoped lookup, so a mistyped or foreign-org id can never save
 * as apparent success while no applicable rate exists — and every value a
 * valid non-negative money amount within numeric(19,4) (PRC5 addendum).
 * Anything else refuses by row and key with no write; nothing is ever
 * filtered silently.
 */
export async function validateTimeTypeBillRates(
  orgId: string,
  maps: TimeTypeRateMap[],
): Promise<{ rates: Record<string, string>[] } | { error: string }> {
  const keys = new Set<string>()
  for (const map of maps) {
    if (map.raw == null) continue
    if (typeof map.raw !== 'object' || Array.isArray(map.raw)) {
      return { error: `${map.label}: labor premiums must map time types to rates.` }
    }
    for (const key of Object.keys(map.raw)) {
      if (!isUuid(key)) return { error: `${map.label}: labor premium "${key}" is not a valid time type.` }
      keys.add(key)
    }
  }
  const known = new Set<string>()
  if (keys.size > 0) {
    const rows = (await db.execute<{ id: string }>(sql`
      select id from time_types
       where org_id = ${orgId} and is_active and id = any(${`{${[...keys].join(',')}}`}::uuid[])`)).rows
    for (const row of rows) known.add(row.id)
  }
  const rates: Record<string, string>[] = []
  for (const map of maps) {
    const out: Record<string, string> = {}
    if (map.raw != null) {
      for (const [key, supplied] of Object.entries(map.raw as Record<string, unknown>)) {
        if (!known.has(key)) {
          return { error: `${map.label}: labor premium "${key}" is not an active time type in this organization.` }
        }
        const parsed = parseItemRateDecimal(supplied)
        if ('error' in parsed) {
          return { error: `${map.label}: labor premium for time type "${key}" must be a non-negative amount with at most 4 decimal places within numeric(19,4).` }
        }
        if (cmp(parsed.value, '0') < 0) {
          return { error: `${map.label}: labor premium for time type "${key}" must be a non-negative amount with at most 4 decimal places within numeric(19,4).` }
        }
        out[key] = normalizeMoney(parsed.value)
      }
    }
    rates.push(out)
  }
  return { rates }
}
