/**
 * Field-ticket labor total helpers (F-t03-005).
 *
 * Crew hours with no bill rate after the rate preview (no labor item, or no
 * rate-book match) price at $0. The $0 must read as *unpriced*, never as
 * free work: the ticket surfaces the unpriced hours next to the labor total
 * and the footer renders the note only when the total is positive.
 * Client-safe (pure decimal math) for drawer and unit tests; the loader in
 * web/lib/field-tickets.ts applies it to the entry rows it selects.
 */
import { sum } from '@openbooks/engine/src/money.ts'

export interface PricedLaborEntry {
  bill_rate: string | number | null | undefined
  hours: string | number | null | undefined
}

/** Hours priced at $0 for want of a bill rate, as a canonical decimal. */
export function unpricedLaborHours(entries: PricedLaborEntry[]): string {
  return sum(entries.filter((entry) => entry.bill_rate == null).map((entry) => String(entry.hours ?? 0)))
}

/** Whether the footer must name the unpriced hours next to the labor total. */
export function showsUnpricedHoursNotice(total: string | number | null | undefined): boolean {
  return Number(total ?? 0) > 0
}
