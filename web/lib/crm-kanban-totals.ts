import { cmp, sum } from '@openbooks/engine/src/money/money.ts'

export interface KanbanMoneyRow {
  currency: string
  projectedAmount: string
  weightedAmount: string
}

export interface KanbanCurrencyTotal {
  currency: string
  projected: string
  weighted: string
}

/**
 * Exact per-currency column totals for the opportunity board. Amounts are
 * summed as exact decimal strings (never parseFloat: a CAD 100 + USD 100
 * stage must not read CAD 200, and totals above 2^53 must stay exact), one
 * line per currency in sorted code order so row order cannot move the
 * figures. A missing currency throws instead of inventing USD: the loader
 * guarantees one, so a blank is corruption that must be loud.
 */
export function sumKanbanColumnByCurrency(rows: KanbanMoneyRow[]): KanbanCurrencyTotal[] {
  const groups = new Map<string, { projected: string[]; weighted: string[] }>()
  for (const row of rows) {
    const currency = row.currency?.trim().toUpperCase()
    if (!currency) {
      throw new Error('kanban totals require an opportunity currency — refusing to invent one')
    }
    let group = groups.get(currency)
    if (!group) {
      group = { projected: [], weighted: [] }
      groups.set(currency, group)
    }
    group.projected.push(row.projectedAmount)
    group.weighted.push(row.weightedAmount)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, group]) => ({
      currency,
      projected: sum(group.projected),
      weighted: sum(group.weighted),
    }))
}

/** Exact positivity gate for decimal amount strings (no float comparison). */
export function isPositiveKanbanAmount(amount: string): boolean {
  return cmp(amount, '0') > 0
}
