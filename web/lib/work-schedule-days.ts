import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal, compareDecimal } from './exact-decimal'

export interface CycleDay {
  dayIndex: number
  hours: string
}

/**
 * Parse a work-schedule cycle's day rows. Pure so the rule is unit-testable;
 * the work-schedules route is its only caller.
 *
 * Every supplied row must be placeable: a row the server cannot place refuses
 * the whole save rather than vanishing into an ok:true response with fewer
 * days than the author entered — a schedule decides holiday pay, and a
 * pattern missing days nobody removed would go on paying somebody. Zero
 * stays omitted (the same as no row), and a repeated position refuses
 * instead of tripping the storage position index with a raw error.
 */
export function parseCycleDays(supplied: unknown, cycleDays: number): { days: CycleDay[] } {
  const rows = Array.isArray(supplied) ? supplied : []
  const days: CycleDay[] = []
  const seen = new Set<number>()
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') {
      throw new Error('each day must name its day index and hours')
    }
    const raw = entry as Record<string, unknown>
    // Number(null) and Number('') both coerce to 0 — a missing index must
    // refuse, never land on day zero.
    if (
      raw.dayIndex === null ||
      raw.dayIndex === undefined ||
      (typeof raw.dayIndex === "string" && raw.dayIndex.trim() === "")
    ) {
      throw new Error("each day must name its day index and hours")
    }
    const dayIndex = Number(raw.dayIndex)
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex >= cycleDays) {
      throw new Error(`day ${String(raw.dayIndex)} is outside this ${cycleDays}-day cycle`)
    }
    if (seen.has(dayIndex)) {
      throw new Error(`day ${dayIndex} appears more than once`)
    }
    const exact = canonicalDecimal(raw.hours, 4)
    if (exact === null) throw new Error(`"${String(raw.hours)}" is not a number of hours`)
    let hours: string
    try {
      hours = normalizeMoney(exact)
    } catch {
      throw new Error(`"${String(raw.hours)}" is not a number of hours`)
    }
    if (compareDecimal(hours, '0') < 0 || compareDecimal(hours, '24') > 0) {
      throw new Error('a day holds between 0 and 24 hours')
    }
    // Zero is the same as no row; storing only the working days keeps the
    // table honest about what "scheduled" means.
    if (compareDecimal(hours, '0') === 0) continue
    seen.add(dayIndex)
    days.push({ dayIndex, hours })
  }
  return { days }
}
