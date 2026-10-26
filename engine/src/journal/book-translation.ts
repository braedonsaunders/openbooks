/**
 * Pure book-currency translation for postings into an accounting book whose
 * base currency for a subsidiary differs from that subsidiary's functional
 * currency. No database: callers resolve the book basis and the rates first,
 * so the same inputs always produce the same lines.
 *
 * Translation policy, per subsidiary group of one entry:
 *  - A line already stated in the book currency keeps its transaction amount
 *    as its book amount (rate 1).
 *  - Every other line translates from its own transaction currency at the
 *    book's rate for that currency on the posting date: book amount =
 *    transaction amount × rate, rounded half away from zero to the ledger
 *    scale (exact bigint arithmetic, never floating point). The line keeps
 *    its transaction currency and amount, so the book's own FX revaluation
 *    measures foreign balances against the book currency.
 *  - A line with a functional amount but no transaction amount is a
 *    functional-currency remeasurement (a revaluation or settlement
 *    adjustment). It has no transaction value to translate and is refused;
 *    the book measures its own currency differences.
 *
 * Residual policy (the translated group must balance on its own):
 *  - When every line shares one transaction currency and the transaction
 *    amounts balance, any difference is per-line rounding (at most half a
 *    ledger unit per line). It is absorbed onto the largest line that is not
 *    a tax or open-item leg — the same rule the posting kernel applies to
 *    functional-currency rounding.
 *  - Any other difference is a genuine currency difference between the
 *    transaction currencies of the group. It posts as one book-currency line
 *    to the book's currency difference account; a book without that account
 *    refuses the posting.
 */
import { fromUnits, mulRate, toUnits } from "../money/money.ts";
import type { Money } from "../money/brands.ts";
import { absorbFxRoundingResidual } from "../organization/subsidiaries.ts";

export class BookTranslationError extends Error {
  override readonly name = "BookTranslationError";
}

/** One subsidiary's measurement basis in one accounting book. */
export interface BookSubsidiaryBasis {
  subsidiaryId: string;
  /** The subsidiary's functional (base) currency. */
  functionalCurrency: string;
  /** The book's base currency for this subsidiary. */
  bookCurrency: string;
  /** Rate type the book translates with (see BOOK_RATE_TYPES). */
  rateType: string;
}

export interface TranslatableLine {
  accountId: string;
  subsidiaryId: string;
  amount: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  taxCodeId?: string | null;
  isOpenItem?: boolean;
  memo?: string | null;
}

export interface TranslationOutcome<T extends TranslatableLine> {
  lines: T[];
  /** Rounding absorbed onto an existing line, per subsidiary (book currency). */
  absorbed: { subsidiaryId: string; amount: string }[];
  /** Currency differences posted to the difference account, per subsidiary. */
  differences: { subsidiaryId: string; amount: string }[];
}

/** A basis is an identity when the book shares the subsidiary's functional currency. */
export function isIdentityBasis(
  basis: Pick<BookSubsidiaryBasis, "functionalCurrency" | "bookCurrency">,
): boolean {
  return basis.functionalCurrency === basis.bookCurrency;
}

/**
 * Translate one entry's lines into the book. `bases` names every subsidiary
 * the lines touch; identity subsidiaries pass through unchanged. `rates`
 * maps `${subsidiaryId}:${currency}` to the transaction-currency → book
 * currency rate, resolved for the posting date under the basis rate type.
 * `makeDifferenceLine` builds the extra line for a currency difference (it
 * returns null when the book has no difference account, which refuses).
 */
export function translateLinesIntoBook<T extends TranslatableLine>(
  lines: readonly T[],
  bases: ReadonlyMap<string, BookSubsidiaryBasis>,
  rates: ReadonlyMap<string, string>,
  makeDifferenceLine: (args: {
    subsidiaryId: string;
    bookCurrency: string;
    amount: string;
  }) => T | null,
  context: { bookLabel: string; entryLabel: string },
): TranslationOutcome<T> {
  const out: T[] = [];
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const basis = bases.get(line.subsidiaryId);
    if (!basis) {
      throw new BookTranslationError(
        `${context.entryLabel}: book ${context.bookLabel} has no measurement basis for subsidiary ${line.subsidiaryId}`,
      );
    }
    if (isIdentityBasis(basis)) {
      out.push(line);
      continue;
    }
    const txn = toUnits(line.txnAmount);
    const functional = toUnits(line.amount);
    // A zero monetary value carries no foreign exposure, including statistical measurements.
    if (txn === 0n && functional === 0n) {
      out.push(line);
      continue;
    }
    let translated: T;
    if (line.currency === basis.bookCurrency) {
      translated = { ...line, amount: fromUnits(txn) as Money, fxRate: "1" };
    } else {
      if (txn === 0n && functional !== 0n) {
        throw new BookTranslationError(
          `${context.entryLabel}: a ${line.currency} line carries a functional amount with no transaction amount — it remeasures the ${basis.functionalCurrency} ledger and has no value in book ${context.bookLabel} (${basis.bookCurrency}); the book measures its own currency differences through its FX revaluation`,
        );
      }
      const rate = rates.get(rateKey(line.subsidiaryId, line.currency));
      if (!rate) {
        throw new BookTranslationError(
          `${context.entryLabel}: no ${basis.rateType} rate for ${line.currency}→${basis.bookCurrency} is resolved for book ${context.bookLabel}`,
        );
      }
      translated = { ...line, amount: mulRate(line.txnAmount, rate) as Money, fxRate: rate };
    }
    out.push(translated);
    const group = groups.get(line.subsidiaryId);
    if (group) group.push(translated);
    else groups.set(line.subsidiaryId, [translated]);
  }

  const absorbed: TranslationOutcome<T>["absorbed"] = [];
  const differences: TranslationOutcome<T>["differences"] = [];
  for (const [subsidiaryId, group] of groups) {
    const basis = bases.get(subsidiaryId)!;
    const total = group.reduce((sum, line) => sum + toUnits(line.amount), 0n);
    if (total === 0n) continue;
    const currencies = new Set(group.map((line) => line.currency));
    const transactional = group.reduce((sum, line) => sum + toUnits(line.txnAmount), 0n);
    const magnitude = total < 0n ? -total : total;
    const rounding =
      currencies.size === 1 &&
      transactional === 0n &&
      2n * magnitude <= BigInt(group.length) &&
      group.some((line) => !line.taxCodeId && !line.isOpenItem);
    if (rounding) {
      absorbFxRoundingResidual(group);
      absorbed.push({ subsidiaryId, amount: fromUnits(total) });
      continue;
    }
    const difference = makeDifferenceLine({
      subsidiaryId,
      bookCurrency: basis.bookCurrency,
      amount: fromUnits(-total),
    });
    if (!difference) {
      throw new BookTranslationError(
        `${context.entryLabel}: translating into book ${context.bookLabel} leaves a ${basis.bookCurrency} currency difference of ${fromUnits(total)} for subsidiary ${subsidiaryId} and the book has no currency difference account — set one on the book's multi-book settings and post again`,
      );
    }
    out.push(difference);
    differences.push({ subsidiaryId, amount: fromUnits(-total) });
  }
  return { lines: out, absorbed, differences };
}

/** Rate lookup key: rates are resolved per subsidiary because bases differ. */
export function rateKey(subsidiaryId: string, currency: string): string {
  return `${subsidiaryId}:${currency}`;
}

/** Rate types a book may translate with. */
export const BOOK_RATE_TYPES = ["spot", "month_average"] as const;
export type BookRateType = (typeof BOOK_RATE_TYPES)[number];

export function isBookRateType(value: unknown): value is BookRateType {
  return typeof value === "string" && (BOOK_RATE_TYPES as readonly string[]).includes(value);
}
