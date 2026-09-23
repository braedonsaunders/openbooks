/**
 * Source-system query builders for the GL reconciliation harness
 * (`gl-reconcile.ts`).
 *
 * Both sides of the comparison filter on the actual transaction date: the
 * source queries below use `t.trandate`, matching the OpenBooks side's
 * `posting_date` / `document_date` predicates. Filtering the source on
 * `accountingperiod.startdate` instead would compare whole source periods
 * against a partial OpenBooks date range whenever --since falls mid-period,
 * manufacturing parity differences out of nothing.
 */
export const DEFAULT_SINCE = "2024-06-01";

const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parse --since, refusing anything that is not a calendar date by name. */
export function parseSince(raw: string | undefined): string {
  const since = (raw ?? DEFAULT_SINCE).trim();
  if (
    !SINCE_PATTERN.test(since) ||
    Number.isNaN(Date.parse(`${since}T00:00:00Z`))
  ) {
    throw new Error(
      `--since must be YYYY-MM-DD (received ${JSON.stringify(raw ?? "")}); ` +
        "the same date filters the source transaction date and the OpenBooks posting/document dates",
    );
  }
  return since;
}

function checkedSince(since: string): string {
  if (!SINCE_PATTERN.test(since)) {
    throw new Error(
      `refusing to build a source query with an unchecked since value: ${JSON.stringify(since)}`,
    );
  }
  return since;
}

/**
 * Source P&L over the same transaction population the OpenBooks P&L covers:
 * every posting line whose transaction date is on/after since, excluding
 * year-end periods. Never filter on the accounting period's start date —
 * that silently drops the partial period a mid-period --since belongs to.
 */
export function sourcePlQuery(since: string): string {
  const checked = checkedSince(since);
  return `
    select sum(case when acct.accttype in ('Income','OthIncome') then -tal.amount else 0 end) revenue,
           sum(case when acct.accttype in ('COGS','Expense','OthExpense') then tal.amount else 0 end) cost
      from transactionaccountingline tal
      join transaction t on t.id = tal.transaction
      join account acct on acct.id = tal.account
      join accountingperiod ap on ap.id = t.postingperiod
     where tal.posting = 'T' and ap.isyear = 'F' and t.trandate >= to_date('${checked}','YYYY-MM-DD')`;
}

/**
 * Source customer-invoice population over the same transaction population
 * the OpenBooks invoice probe covers: invoices with a transaction date
 * on/after since. Same period-boundary reasoning as sourcePlQuery.
 */
export function sourceInvoiceQuery(since: string): string {
  const checked = checkedSince(since);
  return `
    select count(*) n, sum(t.foreigntotal) total from transaction t
      join accountingperiod ap on ap.id = t.postingperiod
     where t.type = 'CustInvc' and t.trandate >= to_date('${checked}','YYYY-MM-DD')`;
}
