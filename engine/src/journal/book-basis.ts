import { toUnits } from "../money/money.ts";
/**
 * The measurement basis of an accounting book: which currency it carries
 * each subsidiary in, at which rate type, and the exact rates a posting
 * translates at. One resolver for every writer, so a replicated document,
 * a depreciation run and a book-specific journal translate alike.
 *
 * A book with no currency configuration for a subsidiary carries it in the
 * subsidiary's functional currency (an identity basis). Once a book has
 * configuration for a subsidiary, every posting date must fall inside one of
 * its windows: a date outside them refuses rather than silently falling back
 * to the functional currency. A missing rate refuses the same way.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import {
  averageSpotRateForMonthWithEvidence,
  lookupSpotRateWithEvidence,
} from "../fx/spot-rate.ts";
import {
  BookTranslationError,
  isIdentityBasis,
  rateKey,
  type BookSubsidiaryBasis,
} from "./book-translation.ts";

export interface BookProfile {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
  replicationMode: "adjustment_only" | "full";
  replicationFrom: string | null;
  currencyDifferenceAccountId: string | null;
}

/** Display label used in refusals: the book's code. */
export function bookLabel(book: Pick<BookProfile, "code">): string {
  return book.code;
}

export async function loadBookProfile(
  runner: SqlExecutor,
  orgId: string,
  bookId: string,
): Promise<BookProfile | null> {
  const row = (
    await runner.execute<{
      id: string;
      code: string;
      name: string;
      is_primary: boolean;
      replication_mode: "adjustment_only" | "full";
      replication_from: string | null;
      currency_difference_account_id: string | null;
    }>(
      sql`
    select id, code, name, is_primary, replication_mode, replication_from::text as replication_from,
           currency_difference_account_id
      from accounting_books where org_id = ${orgId} and id = ${bookId}`,
      "objects",
    )
  )[0];
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isPrimary: row.is_primary,
    replicationMode: row.replication_mode,
    replicationFrom: row.replication_from,
    currencyDifferenceAccountId: row.currency_difference_account_id,
  };
}

/**
 * The basis of each subsidiary in `book` on `postingDate`. The primary book
 * is always an identity basis.
 */
export async function resolveBookBases(
  runner: SqlExecutor,
  args: {
    orgId: string;
    book: Pick<BookProfile, "id" | "code" | "isPrimary">;
    subsidiaryIds: readonly string[];
    postingDate: string;
  },
): Promise<Map<string, BookSubsidiaryBasis>> {
  const ids = [...new Set(args.subsidiaryIds)];
  const out = new Map<string, BookSubsidiaryBasis>();
  if (ids.length === 0) return out;
  const subs = await runner.execute<{ id: string; name: string; base_currency: string }>(
    sql`
    select id, name, base_currency from subsidiaries
     where org_id = ${args.orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    "objects",
  );
  const byId = new Map(subs.map((sub) => [sub.id, sub]));
  const configured = args.book.isPrimary
    ? []
    : await runner.execute<{
        subsidiary_id: string;
        currency: string;
        rate_type: string;
        covers: boolean;
      }>(
        sql`
    select subsidiary_id, currency, rate_type,
           (effective_from <= ${args.postingDate}::date
             and (effective_to is null or effective_to >= ${args.postingDate}::date)) as covers
      from accounting_book_currencies
     where org_id = ${args.orgId} and book_id = ${args.book.id}
       and subsidiary_id = any(${`{${ids.join(",")}}`}::uuid[])`,
        "objects",
      );
  for (const id of ids) {
    const sub = byId.get(id);
    if (!sub)
      throw new BookTranslationError(`subsidiary ${id} does not exist in this organization`);
    const rows = configured.filter((row) => row.subsidiary_id === id);
    if (rows.length === 0) {
      out.set(id, {
        subsidiaryId: id,
        functionalCurrency: sub.base_currency,
        bookCurrency: sub.base_currency,
        rateType: "spot",
      });
      continue;
    }
    const covering = rows.find((row) => row.covers);
    if (!covering) {
      throw new BookTranslationError(
        `book ${args.book.code} carries subsidiary "${sub.name}" in ${rows[0]!.currency} but no currency version covers ${args.postingDate} — add a version covering that date in the book's currency settings`,
      );
    }
    out.set(id, {
      subsidiaryId: id,
      functionalCurrency: sub.base_currency,
      bookCurrency: covering.currency,
      rateType: covering.rate_type,
    });
  }
  return out;
}

export interface BookRateEvidence {
  subsidiaryId: string;
  from: string;
  to: string;
  rateType: string;
  rate: string;
  digest: string;
}

/**
 * Resolve every transaction-currency → book-currency rate the lines need,
 * under each subsidiary's rate type, for the posting date. `spot` is the
 * newest spot quote on or before the date; `month_average` is the mean of
 * the calendar month's spot quotes. A missing rate refuses by name.
 */
export async function resolveBookRates(
  runner: SqlExecutor,
  args: {
    orgId: string;
    bookCode: string;
    postingDate: string;
    bases: ReadonlyMap<string, BookSubsidiaryBasis>;
    lines: readonly {
      subsidiaryId: string;
      currency: string;
      amount?: string;
      txnAmount?: string;
    }[];
  },
): Promise<{ rates: Map<string, string>; evidence: BookRateEvidence[] }> {
  const rates = new Map<string, string>();
  const evidence: BookRateEvidence[] = [];
  const needed = new Map<string, { subsidiaryId: string; currency: string }>();
  for (const line of args.lines) {
    if (
      line.amount !== undefined &&
      line.txnAmount !== undefined &&
      toUnits(line.amount) === 0n &&
      toUnits(line.txnAmount) === 0n
    )
      continue;
    const basis = args.bases.get(line.subsidiaryId);
    if (!basis || isIdentityBasis(basis) || line.currency === basis.bookCurrency) continue;
    needed.set(rateKey(line.subsidiaryId, line.currency), line);
  }
  const [year, month] = args.postingDate.split("-").map(Number) as [number, number];
  // Sequential on purpose: the runner may be a single transaction client.
  for (const [key, need] of [...needed].sort(([a], [b]) => a.localeCompare(b))) {
    const basis = args.bases.get(need.subsidiaryId)!;
    const quote =
      basis.rateType === "month_average"
        ? await averageSpotRateForMonthWithEvidence(
            runner,
            args.orgId,
            need.currency,
            basis.bookCurrency,
            year,
            month,
          )
        : await lookupSpotRateWithEvidence(
            runner,
            args.orgId,
            need.currency,
            basis.bookCurrency,
            args.postingDate,
          );
    if (!quote.rate) {
      throw new BookTranslationError(
        basis.rateType === "month_average"
          ? `book ${args.bookCode} translates at the monthly average rate and no ${need.currency}→${basis.bookCurrency} spot rates are recorded in ${args.postingDate.slice(0, 7)} — record rates for that month under Setup → Exchange rates, then post again`
          : `book ${args.bookCode} needs a ${need.currency}→${basis.bookCurrency} spot rate on or before ${args.postingDate} — record it under Setup → Exchange rates, then post again`,
      );
    }
    rates.set(key, quote.rate);
    evidence.push({
      subsidiaryId: need.subsidiaryId,
      from: need.currency,
      to: basis.bookCurrency,
      rateType: basis.rateType,
      rate: quote.rate,
      digest: quote.digest,
    });
  }
  return { rates, evidence };
}
