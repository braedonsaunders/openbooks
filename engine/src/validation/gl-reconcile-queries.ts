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
import { fromUnits, toUnits } from "../money/money.ts";
import { netSuiteCurrencyIso } from "../sync/netsuite-native.ts";

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
 * year-end periods, grouped by posting subsidiary so the harness can bucket
 * by entity functional currency. Never filter on the accounting period's
 * start date — that silently drops the partial period a mid-period --since
 * belongs to. Never sum across subsidiaries here: one scalar would mix
 * different functional currencies.
 */
export function sourcePlQuery(since: string): string {
  const checked = checkedSince(since);
  return `
    select t.subsidiary as subsidiary,
           sum(case when acct.accttype in ('Income','OthIncome') then -tal.amount else 0 end) revenue,
           sum(case when acct.accttype in ('COGS','Expense','OthExpense') then tal.amount else 0 end) cost
      from transactionaccountingline tal
      join transaction t on t.id = tal.transaction
      join account acct on acct.id = tal.account
      join accountingperiod ap on ap.id = t.postingperiod
     where tal.posting = 'T' and ap.isyear = 'F' and t.trandate >= to_date('${checked}','YYYY-MM-DD')
     group by t.subsidiary`;
}

/**
 * Source customer-invoice population over the same transaction population
 * the OpenBooks invoice probe covers: invoices with a transaction date
 * on/after since, grouped by transaction currency. Same period-boundary
 * reasoning as sourcePlQuery. Never sum foreigntotal across currencies: a
 * USD 100 invoice plus a EUR 100 invoice is not a 200 of anything.
 */
export function sourceInvoiceQuery(since: string): string {
  const checked = checkedSince(since);
  return `
    select t.currency as currency_id, BUILTIN.DF(t.currency) as currency_label,
           count(*) n, sum(t.foreigntotal) total from transaction t
      join accountingperiod ap on ap.id = t.postingperiod
     where t.type = 'CustInvc' and t.trandate >= to_date('${checked}','YYYY-MM-DD')
     group by t.currency, BUILTIN.DF(t.currency)`;
}

/**
 * Source legal entities with their base-currency references, mirroring the
 * connector's subsidiary loader (netsuite-source.ts): the currency table
 * carries ISO symbols, the display label carries the aliases.
 */
export const SOURCE_SUBSIDIARY_QUERY = `SELECT id, currency, BUILTIN.DF(currency) AS currencylabel FROM subsidiary`;

/**
 * Source ISO currency symbols by currency-record id. Single-currency
 * accounts do not expose this record to SuiteQL; callers fall back to the
 * display labels instead of failing.
 */
export const SOURCE_CURRENCY_SYMBOL_QUERY = `SELECT id, symbol FROM currency`;

/**
 * Resolve one source currency reference to ISO, preferring the currency
 * table's symbol and falling back to the shared display-label mapping. A
 * reference that resolves to nothing refuses by name: an unlabelled bucket
 * cannot be compared, and guessing its currency would misstate the verdict.
 */
export function sourceIsoCurrency(
  kind: string,
  ref: string,
  currencyId: unknown,
  displayLabel: unknown,
  symbolById: ReadonlyMap<string, string>,
): string {
  const id = String(currencyId ?? "").trim();
  const symbol = (id ? symbolById.get(id) : undefined)?.trim().toUpperCase();
  if (symbol && /^[A-Z]{3}$/.test(symbol)) return symbol;
  const iso = netSuiteCurrencyIso(displayLabel);
  if (iso) return iso;
  throw new Error(
    `cannot resolve ISO currency for source ${kind} ${ref} ` +
      `(${String(displayLabel ?? currencyId ?? "unstated")}); ` +
      "the source currency record must carry an ISO symbol before this scope can be compared",
  );
}

export interface MoneyBucket {
  currency: string;
  amount: string;
}

export interface AlignedBucket {
  currency: string;
  ours: string;
  theirs: string;
}

/**
 * Align two bucketed populations on the union of their currency labels,
 * zero-filling a currency one side lacks so a missing bucket reads as a
 * difference, never as agreement. Duplicate labels on one side are summed
 * in exact decimal arithmetic rather than silently dropped.
 */
export function alignMoneyBuckets(
  ours: readonly MoneyBucket[],
  theirs: readonly MoneyBucket[],
): AlignedBucket[] {
  const sum = (rows: readonly MoneyBucket[]): Map<string, bigint> => {
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      const key = String(row.currency ?? "").trim().toUpperCase();
      if (!key) {
        throw new Error(
          "refusing to compare a bucket with no currency label; " +
            "resolve the legal entity's base currency before comparing",
        );
      }
      totals.set(
        key,
        (totals.get(key) ?? 0n) + toUnits(String(row.amount ?? "0")),
      );
    }
    return totals;
  };
  const ourTotals = sum(ours);
  const theirTotals = sum(theirs);
  return [...new Set([...ourTotals.keys(), ...theirTotals.keys()])]
    .sort()
    .map((currency) => ({
      currency,
      ours: fromUnits(ourTotals.get(currency) ?? 0n),
      theirs: fromUnits(theirTotals.get(currency) ?? 0n),
    }));
}
