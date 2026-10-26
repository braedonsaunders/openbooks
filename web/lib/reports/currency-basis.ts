import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";

export class ReportCurrencyBasisError extends Error {
  constructor() {
    super(
      "This report contains multiple functional currencies. Choose a single-currency subsidiary view or use a consolidated financial statement.",
    );
    this.name = "ReportCurrencyBasisError";
  }
}

/** Attach basis evidence to each result in the SAME SQL snapshot. `where`
 * uses the native reader aliases l/e/a/p/d and includes its book/date/scope.
 * Probe subsidiaries with EXISTS rather than scan every historical line just
 * to rediscover its currency. An unused subsidiary cannot block a report.
 */
export function functionalReportReader(orgId: string, where: SQL, translated = false) {
  // Each subsidiary counts in the currency the read's book carries it in:
  // its functional currency, or a secondary book's own currency for it.
  // When every subsidiary in every book of the organization carries the same
  // currency, no read can span two, and the lines need not be probed: the
  // organization-wide count answers (one currency, or none at all).
  const possible = sql`(
    select count(distinct public.accounting_book_currency(sub.org_id, book.id, sub.id))
      from subsidiaries sub
      join accounting_books book on book.org_id = sub.org_id
     where sub.org_id = ${orgId}
  )`;
  const census = sql`(case when ${possible} <= 1 then ${possible} else (
    select count(*) from (
      select distinct public.accounting_book_currency(sub.org_id, hit.book_id, sub.id)
        from subsidiaries sub
        cross join lateral (
           select e.book_id from journal_lines l
           join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           join accounts a on a.id = l.account_id and a.org_id = l.org_id
           left join parties p on p.id = l.party_id and p.org_id = l.org_id
           left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
           where l.org_id = ${orgId} and l.subsidiary_id = sub.id
             and e.status in ('posted', 'reversed') and (${where})
           limit 1
        ) hit
       where sub.org_id = ${orgId}
       limit 2
    ) currencies
  ) end)`;
  return {
    censusColumn: translated
      ? sql`1 as __functional_currency_count`
      : sql`${census} as __functional_currency_count`,
    async execute<Row extends Record<string, unknown> = Record<string, unknown>>(query: SQL) {
      const rows = await db.execute<Row & { __functional_currency_count: string }>(
        query,
        "objects",
      );
      for (const row of rows) {
        const count = Number(row.__functional_currency_count);
        if (row.__functional_currency_count == null || !Number.isSafeInteger(count) || count < 0) {
          throw new Error("Report returned invalid functional-currency evidence");
        }
        if (count > 1) throw new ReportCurrencyBasisError();
        delete (row as Record<string, unknown>).__functional_currency_count;
      }
      return { rows: rows as Row[] };
    },
  };
}
