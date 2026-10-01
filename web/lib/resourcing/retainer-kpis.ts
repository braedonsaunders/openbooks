import 'server-only'

import { sql } from 'drizzle-orm'
import { sum } from '@openbooks/engine/src/money/money.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { balanceOf } from '@openbooks/engine/src/resourcing/retainers.ts'
import { addCalendarDays } from '@openbooks/engine/src/platform/business-date.ts'
import { subsidiaryVisibleFilter } from '../subsidiaries.ts'

/** One visible retainer with its posted drawdown total, in ledger strings. */
type RetainerKpiRow = {
  id: string
  currency: string
  totalAmount: string
  drawn: string
  state: string
  endsOn: string
}

export type RetainerCurrencyKpi = { currency: string; balance: string; drawn: string }
export type RetainerKpis = { perCurrency: RetainerCurrencyKpi[]; expiringCount: number }

/**
 * KPI inputs for the retainers list. Balances are per currency (retainers
 * carry a NOT NULL currency; drawdowns inherit it) through the landed
 * `balanceOf` engine policy — draft drawdowns are excluded. Retainers on
 * projects outside the caller's subsidiaries are excluded from every figure.
 * No division: the figures are sums of stored and derived decimal strings.
 */
export async function loadRetainerKpis(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  today: string,
): Promise<RetainerKpis> {
  const cutoff = addCalendarDays(today, 30)
  const byCurrency = new Map<string, { balance: string; drawn: string }>()
  let expiringCount = 0, after: string | null = null
  for (;;) {
  const rows: RetainerKpiRow[] = (await db.execute<RetainerKpiRow>(sql`
    select r.id,r.currency,
           r.total_amount::text as "totalAmount",
           coalesce(sum(d.amount) filter (where d.state = 'posted'), 0)::text as drawn,
           r.state, r.ends_on::text as "endsOn"
      from res_retainers r
      join projects p on p.org_id = r.org_id and p.id = r.project_id
      left join res_retainer_drawdowns d on d.org_id = r.org_id and d.retainer_id = r.id
     where r.org_id = ${orgId}
     ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     ${after ? sql`and r.id > ${after}::uuid` : sql``}
     group by r.id order by r.id limit 500
  `)).rows
  for (const row of rows) {
    // The balance is the landed engine policy, never a local formula: total
    // minus posted drawdowns for this retainer, aggregated by currency.
    const { amount } = balanceOf(
      { totalAmount: row.totalAmount, currency: row.currency },
      [{ amount: row.drawn }],
    )
    const slot = byCurrency.get(row.currency) ?? { balance: '0', drawn: '0' }
    slot.balance = sum([slot.balance, amount])
    slot.drawn = sum([slot.drawn, row.drawn])
    byCurrency.set(row.currency, slot)
    if (row.state === 'active' && row.endsOn >= today && row.endsOn <= cutoff) expiringCount += 1
  }
  if (rows.length < 500) break
  after = rows[rows.length - 1]!.id
  }
  const perCurrency = [...byCurrency]
    .map(([currency, slot]) => ({
      currency,
      balance: slot.balance,
      drawn: slot.drawn,
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency))
  return { perCurrency, expiringCount }
}
