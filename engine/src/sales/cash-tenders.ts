import { abs, add, cmp, neg, sum } from "../money/money.ts";
import { sumMoney, type Money } from "../money/brands.ts";
import {
  PostingError,
  type CashPostingTender,
  type CashSaleCloseout,
} from "../journal/posting-contracts.ts";

/**
 * Paid-at-sale tender evidence for `cash_sale` and `cash_refund`, read from
 * `document_tenders` (migration 0494).
 *
 * A tender is one way the document's total was (or will be) settled. Posting
 * treats every tender uniformly — debit its resolved account on a sale,
 * credit it on a refund — and never branches on `kind`: the writers resolve
 * which account a kind settles into, so a stored-value tender arrives here
 * already pointing at the liability. Unknown kinds therefore pass through
 * untouched — refusing them would make the rule the gatekeeper for a
 * product decision that belongs to the write boundary.
 */

/**
 * Tender channels the document writers offer. Stored value redeems a gift
 * card or store credit (sale) or credits one (refund); the writer resolves
 * the liability account before posting sees it.
 */
export const CASH_TENDER_KINDS = [
  "cash",
  "card",
  "bank_transfer",
  "wallet",
  "gateway",
  "stored_value",
  "other",
] as const;

export type { CashPostingTender };

/**
 * Refuse an empty tender set before any journal: a cash document with
 * nothing settled is an unfinished draft, never a partial post. The one
 * exception is a document whose tenders must settle exactly zero — a sale
 * discounted or comped in full, or the refund of one — which has nothing to
 * tender; any nonzero amount due still needs its tenders.
 */
export function assertCashTendersPresent(
  tenders: readonly CashPostingTender[],
  amountToTender: string,
  documentNumber: string,
  kindLabel: string,
): void {
  if (tenders.length === 0 && cmp(amountToTender, "0") !== 0) {
    throw new PostingError(
      `${kindLabel} ${documentNumber} has no tenders — add at least one tender ` +
        `naming the clearing or bank account and the amount received`,
    );
  }
}

/**
 * Cross-foot tenders against the document total both derive from: the income
 * and tax legs the rule just projected. Any difference — including a rounding
 * difference — is a refusal, never a silent plug: an unbalanced cash sale
 * would book revenue the till never received.
 */
export function assertTendersMatchTotal(
  tenders: readonly CashPostingTender[],
  incomeAndTaxTotal: Money,
  documentNumber: string,
  kindLabel: string,
): void {
  // Tendered is positive by construction; the income/tax total is negative on
  // a sale (credits) and positive on a refund (debits). The magnitudes must
  // match exactly; the message names both in document currency.
  const tendered = sumMoney(tenders.map((t) => t.amount));
  if (cmp(tendered, abs(incomeAndTaxTotal)) !== 0) {
    throw new PostingError(
      `${kindLabel} ${documentNumber} tenders ${tendered} but lines and tax total ${abs(incomeAndTaxTotal)} — ` +
        `tenders must sum to the document total; add, remove, or correct a tender`,
    );
  }
}

/**
 * The one close-out tender derivation: the till collects the document total
 * plus card tips, keeps back the processor fees withheld at settlement, and
 * counts over or short against the expected cash (over positive, short
 * negative). The posting kernel cross-foots through it below and the cash
 * drawer balances its tender editor through it, so the two can never
 * disagree about what a close-out must tender. Plain exact-decimal strings
 * in, canonical decimal text out; a malformed leg throws instead of
 * plugging.
 */
export function expectedTenderedForCloseout(
  documentTotal: string,
  tipsTotal: string,
  feeTotal: string,
  overShort: string,
): string {
  return sum([documentTotal, tipsTotal, neg(feeTotal), overShort]);
}

/**
 * Close-out tender cross-foot for a cash sale: tenders must equal the
 * shared derivation above, stated explicitly so a mis-tendered close-out
 * reads as arithmetic, never as a plug.
 */
export function assertCloseoutTendersMatchTotal(
  tenders: readonly CashPostingTender[],
  incomeAndTaxTotal: Money,
  closeout: CashSaleCloseout,
  documentNumber: string,
): void {
  const tendered = sumMoney(tenders.map((t) => t.amount));
  const expected = expectedTenderedForCloseout(
    abs(incomeAndTaxTotal),
    closeout.tipsTotal,
    closeout.feeTotal,
    closeout.overShort,
  );
  if (cmp(tendered, expected) !== 0) {
    const parts = [`document total ${abs(incomeAndTaxTotal)}`];
    if (cmp(closeout.tipsTotal, "0") !== 0) parts.push(`tips ${closeout.tipsTotal}`);
    if (cmp(closeout.feeTotal, "0") !== 0) parts.push(`fees −${closeout.feeTotal}`);
    if (cmp(closeout.overShort, "0") !== 0) {
      parts.push(
        cmp(closeout.overShort, "0") > 0
          ? `over ${closeout.overShort}`
          : `short ${closeout.overShort}`,
      );
    }
    throw new PostingError(
      `cash sale ${documentNumber} tenders ${tendered} but ${parts.join(" + ")} = ${add(expected, "0")} — ` +
        `tenders must sum to the document total + tips − fees ± over/short; add, remove, or correct a tender or the close-out`,
    );
  }
}
