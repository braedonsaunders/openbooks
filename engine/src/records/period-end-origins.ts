import { sql, type SQL } from "drizzle-orm";

/**
 * Journal origins of period-end journals: the year-end closing entries
 * (income-statement, income-summary and balance-sheet closing, origin
 * `closing`) and the next year's opening entries (origin `opening`).
 *
 * Financial statements compute retained earnings from the ledger, so they
 * present the same figures whether or not a year has been closed by
 * journal. Every statement, analytical P&L and balance reader excludes these
 * origins; the journal list, the general ledger detail and account registers
 * keep them, because they are the statutory record of the close. This one
 * list is the definition every reader uses.
 */
export const PERIOD_END_JOURNAL_ORIGINS = ["closing", "opening"] as const;

/** The origins as a SQL literal list, for statements composed as text. */
export const PERIOD_END_JOURNAL_ORIGIN_LITERALS = PERIOD_END_JOURNAL_ORIGINS.map(
  (origin) => `'${origin}'`,
).join(", ");

export type PeriodEndJournalOrigin = (typeof PERIOD_END_JOURNAL_ORIGINS)[number];

export function isPeriodEndJournalOrigin(origin: string): origin is PeriodEndJournalOrigin {
  return (PERIOD_END_JOURNAL_ORIGINS as readonly string[]).includes(origin);
}

/**
 * The statement-basis predicate over a journal-entry origin expression:
 * true for every entry except period-end journals. Pass the origin column of
 * the entry alias the query uses, e.g. `excludePeriodEndJournals(sql\`e.origin\`)`.
 */
export function excludePeriodEndJournals(origin: SQL): SQL {
  return sql`${origin} not in (${sql.raw(PERIOD_END_JOURNAL_ORIGIN_LITERALS)})`;
}

/**
 * The gl_month_activity relation on the statement basis: the maintained
 * monthly summary less the period-end journals it includes, in the summary's
 * own shape (org_id, account_id, book_id, month, subsidiary_id, debit_total,
 * credit_total, line_count). Readers that answer statements, analytical P&L
 * or balances from the summary select from this relation instead of the raw
 * table. Period-end journals are few, so the correcting leg is an indexed
 * read of the origin index.
 */
export function statementMonthActivity(orgId: SQL | string): SQL {
  return sql`(
    select g.org_id, g.account_id, g.book_id, g.month, g.subsidiary_id,
           g.debit_total, g.credit_total, g.line_count
      from gl_month_activity g
     where g.org_id = ${orgId}
    union all
    select l.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date)::date as month, l.subsidiary_id,
           -sum(greatest(l.amount, 0)) as debit_total, -sum(greatest(-l.amount, 0)) as credit_total,
           -count(*) as line_count
      from journal_entries e
      join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
     where e.org_id = ${orgId} and e.status in ('posted', 'reversed')
       and e.origin in (${sql.raw(PERIOD_END_JOURNAL_ORIGIN_LITERALS)})
     group by l.org_id, l.account_id, e.book_id, date_trunc('month', e.posting_date), l.subsidiary_id
  )`;
}
