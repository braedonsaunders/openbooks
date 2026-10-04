import { add, isZero } from '@openbooks/engine/src/money/money.ts'

/**
 * The statement-of-earnings sections a printed pay stub groups its lines
 * into, with a year-to-date figure on every row:
 *
 *   - earnings: cash earnings;
 *   - taxableCompanyItems: non-cash earnings that are taxable income (taxable
 *     group-life premiums, personal use of a company vehicle, an employer
 *     retirement contribution delivered as a taxable benefit);
 *   - withholdings: the income-tax deductions, identified by the pack-declared
 *     withholding system keys rather than any jurisdiction's literal codes;
 *   - netAdjustments: every other employee deduction.
 *
 * Non-cash earnings that are not taxable income and employer-only lines are
 * the employer's cost, not part of the employee's statement, so they are
 * left out. Pure and synchronous so the grouping can be tested on its own.
 */

export type StatementLine = {
  componentId: string | null
  kind: string
  paymentKind: string | null
  description: string
  systemKey: string | null
  taxable: boolean | null
  amount: string
  hours: string | null
  rate: string | null
}

export type StatementRow = {
  key: string
  description: string
  hours: string
  rate: string | null
  current: string
  ytd: string
  ytdHours: string
}

export type PayStubStatement = {
  earnings: StatementRow[]
  taxableCompanyItems: StatementRow[]
  withholdings: StatementRow[]
  netAdjustments: StatementRow[]
}

type Section = keyof PayStubStatement

function sectionOf(line: StatementLine, withholdingKeys: ReadonlySet<string>): Section | null {
  if (line.kind === 'earning') {
    if (line.paymentKind !== 'non_cash') return 'earnings'
    return line.taxable ? 'taxableCompanyItems' : null
  }
  if (line.kind === 'deduction') {
    return line.systemKey && withholdingKeys.has(line.systemKey) ? 'withholdings' : 'netAdjustments'
  }
  return null
}

function rowKey(line: StatementLine): string {
  return line.componentId ?? `description:${line.description}`
}

export function toStatementLine(row: Record<string, unknown>): StatementLine {
  return {
    componentId: row.component_id == null ? null : String(row.component_id),
    kind: String(row.kind ?? ''),
    paymentKind: row.payment_kind == null ? null : String(row.payment_kind),
    description: String(row.description ?? ''),
    systemKey: row.system_key == null ? null : String(row.system_key),
    taxable: row.taxable == null ? null : Boolean(row.taxable),
    amount: String(row.amount ?? '0'),
    hours: row.hours == null ? null : String(row.hours),
    rate: row.rate == null ? null : String(row.rate),
  }
}

/**
 * Group this stub's lines and the employee's earlier year-to-date lines into
 * the printed sections. `prior` holds one aggregated line per component for
 * the committed stubs that precede this one in the tax year; components that
 * appear only there still print, with a zero current amount.
 */
export function buildPayStubStatement(
  current: readonly StatementLine[],
  prior: readonly StatementLine[],
  withholdingKeys: ReadonlySet<string>,
): PayStubStatement {
  const sections: Record<Section, Map<string, StatementRow>> = {
    earnings: new Map(),
    taxableCompanyItems: new Map(),
    withholdings: new Map(),
    netAdjustments: new Map(),
  }
  const rates = new Map<string, Set<string>>()

  for (const line of current) {
    const section = sectionOf(line, withholdingKeys)
    if (!section) continue
    const key = rowKey(line)
    const existing = sections[section].get(key)
    const hours = line.hours ?? '0'
    if (existing) {
      existing.current = add(existing.current, line.amount)
      existing.ytd = add(existing.ytd, line.amount)
      existing.hours = add(existing.hours, hours)
      existing.ytdHours = add(existing.ytdHours, hours)
    } else {
      sections[section].set(key, {
        key,
        description: line.description,
        hours,
        rate: null,
        current: line.amount,
        ytd: line.amount,
        ytdHours: hours,
      })
    }
    if (line.rate != null) {
      const seen = rates.get(key) ?? new Set<string>()
      seen.add(line.rate)
      rates.set(key, seen)
    }
  }

  const priorOnly: Array<[Section, StatementRow]> = []
  for (const line of prior) {
    const section = sectionOf(line, withholdingKeys)
    if (!section) continue
    const key = rowKey(line)
    const existing = sections[section].get(key)
    const hours = line.hours ?? '0'
    if (existing) {
      existing.ytd = add(existing.ytd, line.amount)
      existing.ytdHours = add(existing.ytdHours, hours)
    } else if (!isZero(line.amount) || !isZero(hours)) {
      priorOnly.push([section, {
        key,
        description: line.description,
        hours: '0',
        rate: null,
        current: '0',
        ytd: line.amount,
        ytdHours: hours,
      }])
    }
  }
  priorOnly
    .sort(([, a], [, b]) => a.description.localeCompare(b.description))
    .forEach(([section, row]) => sections[section].set(row.key, row))

  // A rate prints only when every current line for the component was paid at
  // the same rate; a split across rates (or a lump sum) prints none.
  for (const map of Object.values(sections)) {
    for (const row of map.values()) {
      const seen = rates.get(row.key)
      row.rate = seen && seen.size === 1 ? ([...seen][0] ?? null) : null
    }
  }

  return {
    earnings: [...sections.earnings.values()],
    taxableCompanyItems: [...sections.taxableCompanyItems.values()],
    withholdings: [...sections.withholdings.values()],
    netAdjustments: [...sections.netAdjustments.values()],
  }
}
