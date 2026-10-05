import { abs, cmp } from "../money/money.ts";
import { parseMoney, sumMoney, type Money } from "../money/brands.ts";
import { PostingError } from "../journal/posting-contracts.ts";

/**
 * Paid-at-sale tender evidence for `cash_sale` and `cash_refund`.
 *
 * A tender is one way the document's total was (or will be) settled: cash,
 * card, or bank money into a clearing or bank account the writer resolved
 * when the draft was built. Tenders ride `documents.custom.tenders` as plain
 * JSON so the whole document — lines, tax, and settlement — approves and
 * posts as one unit; the settled legs themselves live in the journal, which
 * stays the queryable book of record.
 *
 * Posting treats every tender uniformly (debit its account on a sale, credit
 * it on a refund) and never branches on `kind`: a later tender kind (gift
 * card and store credit redemption) only teaches the writers which account a
 * kind resolves to, never the posting rule. Unknown kinds therefore pass
 * through here untouched — refusing them would make the rule the gatekeeper
 * for a product decision that belongs to the write boundary.
 */

/**
 * Tender channels the document writers offer today. Posting never branches
 * on kind, so a later channel (gift card and store credit redemption) lands
 * by extending this list and teaching the writers which account it resolves
 * to — the kernel needs no change.
 */
export const CASH_TENDER_KINDS = ["cash", "card", "bank"] as const;

export interface CashTender {
  /** Tender channel (`cash`, `card`, `bank`, …). Descriptive only; posting never branches on it. */
  kind: string;
  /** Clearing or bank account settled by this tender. */
  accountId: string;
  /** Positive settled amount, canonical ledger money. */
  amount: Money;
  /** Operator reference (authorization code, slip number). Never a card number. */
  reference: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse and validate the tender evidence on a cash document. Every refusal
 * names the tender and the remedy: a malformed tender must fail here — before
 * any journal or post-commit evidence — rather than post a partial sale.
 */
export function parseCashTenders(
  custom: unknown,
  documentNumber: string,
  kindLabel: string,
): CashTender[] {
  const raw = isRecord(custom) ? custom.tenders : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PostingError(
      `${kindLabel} ${documentNumber} has no tenders — add at least one tender ` +
        `naming the clearing or bank account and the amount received`,
    );
  }
  return raw.map((entry, index) => {
    const label = `tender ${index + 1}`;
    if (!isRecord(entry)) {
      throw new PostingError(
        `${kindLabel} ${documentNumber} ${label} is not an object — rebuild the tenders on the document`,
      );
    }
    const kind = entry.kind;
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw new PostingError(
        `${kindLabel} ${documentNumber} ${label} has no tender kind — set it to cash, card, or bank`,
      );
    }
    const accountId = entry.accountId;
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new PostingError(
        `${kindLabel} ${documentNumber} ${label} names no account — pick the clearing or bank account the money settled into`,
      );
    }
    let amount: Money;
    try {
      amount = parseMoney(entry.amount);
    } catch {
      throw new PostingError(
        `${kindLabel} ${documentNumber} ${label} amount ${JSON.stringify(entry.amount)} is not a valid amount — enter the settled amount as a decimal number`,
      );
    }
    if (cmp(amount, "0") <= 0) {
      throw new PostingError(
        `${kindLabel} ${documentNumber} ${label} amount must be positive — payouts ride a cash refund, not a negative tender`,
      );
    }
    const reference = entry.reference;
    if (reference != null && typeof reference !== "string") {
      throw new PostingError(
        `${kindLabel} ${documentNumber} ${label} reference must be text — enter the authorization or slip reference, or leave it blank`,
      );
    }
    return {
      kind: kind.trim(),
      accountId,
      amount,
      reference: typeof reference === "string" && reference.length > 0 ? reference : null,
    };
  });
}

/**
 * Cross-foot tenders against the document total both derive from: the income
 * and tax legs the rule just projected. Any difference — including a rounding
 * difference — is a refusal, never a silent plug: an unbalanced cash sale
 * would book revenue the till never received.
 */
export function assertTendersMatchTotal(
  tenders: readonly CashTender[],
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
