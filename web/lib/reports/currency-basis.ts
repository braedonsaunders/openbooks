import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'

export class ReportCurrencyBasisError extends Error {
  constructor() {
    super('This report contains multiple functional currencies. Choose a single-currency subsidiary view or use a consolidated financial statement.')
    this.name = 'ReportCurrencyBasisError'
  }
}

/** Attach basis evidence to each result in the SAME SQL snapshot. `where`
 * uses the native reader aliases l/e/a/p/d and includes its book/date/scope.
 * Probe subsidiaries with EXISTS rather than scan every historical line just
 * to rediscover its currency. An unused subsidiary cannot block a report.
 */
export function functionalReportReader(orgId: string, where: SQL) {
  const census = sql`(
    select count(*) from (
      select distinct sub.base_currency
        from subsidiaries sub
       where sub.org_id = ${orgId}
         and exists (
           select 1 from journal_lines l
           join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           join accounts a on a.id = l.account_id and a.org_id = l.org_id
           left join parties p on p.id = l.party_id and p.org_id = l.org_id
           left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
           where l.org_id = ${orgId} and l.subsidiary_id = sub.id
             and e.status in ('posted', 'reversed') and (${where})
         )
       limit 2
    ) currencies
  )`
  return {
    censusColumn: sql`${census} as __functional_currency_count`,
    async execute<Row extends Record<string, unknown> = Record<string, unknown>>(query: SQL) {
      const result = await db.execute<Row & { __functional_currency_count: string }>(query)
      for (const row of result.rows) {
        const count = Number(row.__functional_currency_count)
        if (row.__functional_currency_count == null || !Number.isSafeInteger(count) || count < 0) {
          throw new Error('Report returned invalid functional-currency evidence')
        }
        if (count > 1) throw new ReportCurrencyBasisError()
        delete (row as Record<string, unknown>).__functional_currency_count
      }
      return { ...result, rows: result.rows as Row[] }
    },
  }
}
