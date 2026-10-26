import { canonicalDecimal } from "../money/exact-decimal.ts";
/** Pure document-to-ledger projection rules. Transaction orchestration remains in posting.ts. */
import { isZero, toUnits } from "../money/money.ts";
import { sumMoney } from "../money/brands.ts";
import { type Doc, PostingError } from "./posting-contracts.ts";
/**
 * A zero-money leg that records an exact measurement: a nonzero quantity of
 * at most four decimal places with a unit. Statistical journals post only
 * these; a cash document that settles exactly zero records its quantities
 * this way. Every other zero-money leg carries nothing and is dropped.
 */
export function isMeasurementLeg(line: {
  amount: string;
  quantity?: string | null;
  unit?: string | null;
}): boolean {
  const quantity = canonicalDecimal(canonicalDecimal(line.quantity, 8), 4);
  return (
    isZero(line.amount) && !!line.unit?.trim() && quantity !== null && toUnits(quantity) !== 0n
  );
}

/**
 * The legs a projection posts: every leg that moves money, every measurement,
 * and — in a statistical journal — every leg that states a quantity. Fewer
 * than two legs are refused unless the one leg is a measurement.
 */
export function retainedKernelLines<
  T extends { amount: string; quantity?: string | null; unit?: string | null },
>(lines: readonly T[], statistical: boolean): T[] {
  const kept = lines.filter(
    (line) => !isZero(line.amount) || (statistical && !!line.quantity) || isMeasurementLeg(line),
  );
  const single = kept.length === 1 ? kept[0] : undefined;
  if (kept.length < 2 && !(statistical && single) && !(single && isMeasurementLeg(single)))
    throw new PostingError("posting produced fewer than 2 lines");
  return kept;
}

/**
 * Application-layer proof immediately before a ledger write. PostgreSQL
 * repeats these assertions at the deferred-constraint boundary; keeping both
 * defenses independent turns a malformed projection into a readable posting
 * error before any journal row is inserted.
 */
export function assertFinalKernelBalance(
  lines: readonly {
    amount: string;
    subsidiaryId: string;
    quantity?: string | null;
    unit?: string | null;
  }[],
): void {
  // Document quantities carry eight storage decimals; only exact four-place
  // statistical values qualify, including their zero-padded storage readback.
  const single = lines.length === 1 ? lines[0] : undefined;
  const quantity = canonicalDecimal(canonicalDecimal(single?.quantity, 8), 4);
  const measurement =
    single !== undefined &&
    isZero(single.amount) &&
    !!single.unit?.trim() &&
    quantity !== null &&
    toUnits(quantity) !== 0n;
  if (lines.length < 2 && !measurement)
    throw new PostingError("posting produced fewer than 2 lines");
  const total = sumMoney(lines.map((line) => line.amount));
  if (!isZero(total))
    throw new PostingError(`functional-currency journal does not balance (sum=${total})`);
  const bySubsidiary = new Map<string, string[]>();
  for (const line of lines) {
    const amounts = bySubsidiary.get(line.subsidiaryId) ?? [];
    amounts.push(line.amount);
    bySubsidiary.set(line.subsidiaryId, amounts);
  }
  for (const [subsidiaryId, amounts] of bySubsidiary) {
    const subsidiaryTotal = sumMoney(amounts);
    if (!isZero(subsidiaryTotal)) {
      throw new PostingError(
        `functional-currency journal does not balance for subsidiary ${subsidiaryId} (sum=${subsidiaryTotal})`,
      );
    }
  }
}

/**
 * Credit memos are stated in their own direction — positive lines, positive
 * total — with the kernel flipping the sign at posting. A negative-total
 * credit would post backwards: a customer credit becomes a shadow invoice
 * (debit AR, credit income) outside every invoice-gated control, from
 * dunning to capacity, and a vendor credit becomes a shadow bill (debit
 * expense, credit AP). A balance owed by the customer is an invoice; a
 * balance owed to a vendor is a bill. Migrations replaying source-system
 * history pass migration=true and are unaffected.
 */
export function assertCreditMemoDirection(
  doc: Pick<Doc, "kind" | "total">,
  migration?: boolean,
): void {
  if (doc.kind === "customer_credit" && !migration && toUnits(doc.total) < 0n) {
    throw new PostingError(
      `a credit memo must carry a positive total; a negative balance owed by the customer is an invoice`,
    );
  }
  if (doc.kind === "cash_refund" && !migration && toUnits(doc.total) < 0n) {
    throw new PostingError(
      `a cash refund must carry a positive total; money taken from the customer is a cash sale`,
    );
  }
  if (doc.kind === "vendor_credit" && !migration && toUnits(doc.total) < 0n) {
    throw new PostingError(
      `a credit memo must carry a positive total; a negative balance owed to the vendor is a bill`,
    );
  }
}
