import "server-only";
import { sql } from "drizzle-orm";
import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "./format";
import { db } from "@openbooks/engine/platform/db";
import { trialBalance } from "./reports/statements";
import type { DimFilter } from "./reports/filters";
import { decimalAdd, decimalIsZero, decimalNeg, type ExactDecimal } from "./statement-format";
import { COMPUTED_RETAINED_EARNINGS_PRIOR_ID } from "./computed-earnings";
import { isReportUuidParam } from "./report-filters";
import type { ExportData } from "./report-pdf";

/**
 * Book-to-book differences: each account's balance in the primary book and
 * in a secondary book as of a date, and the difference. Both columns come
 * from the trial balance reader, so the comparison agrees with each book's
 * own trial balance to the cent. Where the two books carry the viewed
 * subsidiaries in different currencies there is no single-currency
 * difference: both balances show with their currency and the difference is
 * left empty rather than mixing currencies.
 */

export class BookDifferenceSelectionError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "BookDifferenceSelectionError";
  }
}

export type BookOption = { id: string; code: string; name: string; isPrimary: boolean };

export interface BookDifferenceRow {
  id: string;
  number: string | null;
  name: string;
  type: string;
  primary: ExactDecimal;
  compare: ExactDecimal;
  /** Null when the two books measure the view in different currencies. */
  difference: ExactDecimal | null;
}

/** The primary book and the chosen comparison book (default: the first secondary book). */
export async function bookDifferenceSelection(
  orgId: string,
  requested: string | null | undefined,
): Promise<{
  primary: BookOption;
  compare: BookOption;
  options: BookOption[];
}> {
  if (requested != null && !isReportUuidParam(requested))
    throw new BookDifferenceSelectionError(
      "Choose an active secondary accounting book to compare.",
    );
  const books = await db.execute<BookOption>(
    sql`
    select id, code, name, is_primary as "isPrimary" from accounting_books
     where org_id = ${orgId} and is_active
     order by is_primary desc, code, id`,
    "objects",
  );
  const primary = books.find((book) => book.isPrimary);
  const options = books.filter((book) => !book.isPrimary);
  if (!primary || options.length === 0) {
    throw new BookDifferenceSelectionError(
      "There is no secondary accounting book to compare. Add one under Setup → Accounting Books.",
    );
  }
  const compare =
    requested == null ? options[0] : options.find((book) => book.id === requested.toLowerCase());
  if (!compare)
    throw new BookDifferenceSelectionError(
      "Choose an active secondary accounting book to compare.",
    );
  return { primary, compare, options };
}

export async function bookDifferenceRows(args: {
  orgId: string;
  asOf: string;
  dims: DimFilter;
  primaryBookId: string;
  compareBookId: string;
  sameCurrency: boolean;
}): Promise<BookDifferenceRow[]> {
  // Sequential: both reads may share one request-scoped connection.
  const primary = await trialBalance(args.asOf, args.dims, args.orgId, args.primaryBookId);
  const compare = await trialBalance(args.asOf, args.dims, args.orgId, args.compareBookId);
  const byId = new Map<string, BookDifferenceRow>();
  const ensure = (row: { id: string; number: string | null; name: string; type: string }) => {
    let out = byId.get(row.id);
    if (!out) {
      out = {
        id: row.id,
        number: row.number,
        name: row.name,
        type: row.type,
        primary: "0",
        compare: "0",
        difference: null,
      };
      byId.set(row.id, out);
    }
    return out;
  };
  for (const row of primary) ensure(row).primary = String(row.balance);
  for (const row of compare) ensure(row).compare = String(row.balance);
  const rows = [...byId.values()]
    .map((row) => ({
      ...row,
      difference: args.sameCurrency ? decimalAdd(row.compare, decimalNeg(row.primary)) : null,
    }))
    .filter((row) => !(decimalIsZero(row.primary) && decimalIsZero(row.compare)));
  // Accounts in chart order; the prior-years earnings line stays last.
  return rows.sort((a, b) => {
    if (a.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID) return 1;
    if (b.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID) return -1;
    return (a.number ?? "￿").localeCompare(b.number ?? "￿") || a.name.localeCompare(b.name);
  });
}

/** Export and scheduled-run data for the book differences report. */
export async function bookDifferencesExportData(args: {
  orgId: string;
  asOf: string;
  dims: DimFilter;
  compareBook: string | null;
  primaryCurrency: string;
  compareCurrency: string;
}): Promise<ExportData> {
  const t = await getTranslations("reports.bookDifferences");
  const locale = await getLocale();
  const { primary, compare } = await bookDifferenceSelection(args.orgId, args.compareBook);
  const sameCurrency = args.primaryCurrency === args.compareCurrency;
  const rows = await bookDifferenceRows({
    orgId: args.orgId,
    asOf: args.asOf,
    dims: args.dims,
    primaryBookId: primary.id,
    compareBookId: compare.id,
    sameCurrency,
  });
  return {
    title: t("title"),
    dateRangeLabel: t(
      "asOf",
      civilDateParams({ date: args.asOf, primary: primary.name, compare: compare.name }, locale),
    ),
    summary: [],
    groups: [
      {
        kind: "results",
        title: t("title"),
        columns: [
          t("columns.accountNumber"),
          t("columns.accountName"),
          t("columns.primary", { book: primary.code, currency: args.primaryCurrency }),
          t("columns.compare", { book: compare.code, currency: args.compareCurrency }),
          t("columns.difference"),
        ],
        align: ["left", "left", "right", "right", "right"],
        money: [false, false, sameCurrency, sameCurrency, sameCurrency],
        rows: rows.map((row) => [
          row.number ?? "",
          row.id === COMPUTED_RETAINED_EARNINGS_PRIOR_ID ? t("retainedEarningsPrior") : row.name,
          sameCurrency ? row.primary : `${row.primary} ${args.primaryCurrency}`,
          sameCurrency ? row.compare : `${row.compare} ${args.compareCurrency}`,
          row.difference ?? "",
        ]),
      },
    ],
  };
}
