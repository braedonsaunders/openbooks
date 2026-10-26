/**
 * What a posting into a non-primary accounting book goes through before it
 * is written: the book's account mappings, then translation into the book's
 * currency for every subsidiary the book carries in a currency other than
 * its functional currency. postEntry applies this to every non-primary
 * posting, so replicated documents and generated entries (depreciation,
 * recognition, allocations, revaluation) all follow the same rules.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { applyBookAccountMaps, type AppliedBookAccountMap } from "./book-account-maps.ts";
import {
  resolveBookBases,
  resolveBookRates,
  type BookProfile,
  type BookRateEvidence,
} from "./book-basis.ts";
import {
  isIdentityBasis,
  translateLinesIntoBook,
  type BookSubsidiaryBasis,
  type TranslatableLine,
} from "./book-translation.ts";

/**
 * How a caller states its amounts. `functional`: amounts are in each line's
 * subsidiary functional currency (what every posting engine produces) and
 * translate into the book currency. `book`: amounts are already measured in
 * the book currency (the book's own FX revaluation) and only pass the
 * currency checks.
 */
export type BookAmountBasis = "functional" | "book";
/** Ledger-derived legs already name the book's physical accounts; source legs resolve effective mappings. */
export type BookAccountBasis = "source" | "book";

export interface BookPostingEvidence {
  bookId: string;
  accountMaps: AppliedBookAccountMap[];
  rates: BookRateEvidence[];
  absorbedRounding: { subsidiaryId: string; amount: string }[];
  currencyDifferences: { subsidiaryId: string; amount: string }[];
}

export async function applyBookPostingPolicy<
  T extends TranslatableLine & { lineNumber: number; fxStated: boolean },
>(
  runner: SqlExecutor,
  args: {
    orgId: string;
    book: BookProfile;
    entryLabel: string;
    postingDate: string;
    amountBasis: BookAmountBasis;
    accountBasis?: BookAccountBasis;
    lines: readonly T[];
    nextLineNumber: () => number;
  },
): Promise<{
  lines: T[];
  bases: Map<string, BookSubsidiaryBasis>;
  evidence: BookPostingEvidence | null;
}> {
  const bases = await resolveBookBases(runner, {
    orgId: args.orgId,
    book: args.book,
    subsidiaryIds: args.lines.map((line) => line.subsidiaryId),
    postingDate: args.postingDate,
  });
  if (args.book.isPrimary) return { lines: [...args.lines], bases, evidence: null };
  const mapped =
    args.accountBasis === "book"
      ? { lines: [...args.lines], applied: [] as AppliedBookAccountMap[] }
      : await applyBookAccountMaps(runner, {
          orgId: args.orgId,
          bookId: args.book.id,
          bookLabel: args.book.code,
          postingDate: args.postingDate,
          entryLabel: args.entryLabel,
          lines: args.lines,
        });
  const translating =
    args.amountBasis === "functional" &&
    [...bases.values()].some((basis) => !isIdentityBasis(basis));
  if (!translating) {
    return {
      lines: mapped.lines,
      bases,
      evidence:
        mapped.applied.length === 0
          ? null
          : {
              bookId: args.book.id,
              accountMaps: mapped.applied,
              rates: [],
              absorbedRounding: [],
              currencyDifferences: [],
            },
    };
  }
  const { rates, evidence: rateEvidence } = await resolveBookRates(runner, {
    orgId: args.orgId,
    bookCode: args.book.code,
    postingDate: args.postingDate,
    bases,
    lines: mapped.lines,
  });
  const differenceAccountId = args.book.currencyDifferenceAccountId;
  const translated = translateLinesIntoBook(
    mapped.lines,
    bases,
    rates,
    ({ subsidiaryId, bookCurrency, amount }) =>
      differenceAccountId
        ? ({
            accountId: differenceAccountId,
            subsidiaryId,
            amount,
            currency: bookCurrency,
            txnAmount: amount,
            fxRate: "1",
            memo: `Book ${args.book.code} currency difference`,
            lineNumber: args.nextLineNumber(),
            fxStated: true,
          } as unknown as T)
        : null,
    { bookLabel: args.book.code, entryLabel: args.entryLabel },
  );
  return {
    // Translated lines state their own book rate; identity lines keep theirs.
    lines: translated.lines.map((line) => {
      const basis = bases.get(line.subsidiaryId);
      return basis && !isIdentityBasis(basis) ? { ...line, fxStated: true } : line;
    }),
    bases,
    evidence: {
      bookId: args.book.id,
      accountMaps: mapped.applied,
      rates: rateEvidence,
      absorbedRounding: translated.absorbed,
      currencyDifferences: translated.differences,
    },
  };
}
