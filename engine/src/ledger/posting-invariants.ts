/** Pure document-to-ledger projection rules. Transaction orchestration remains in posting.ts. */
import { isZero, sum, toUnits } from "../money/money.ts";
import { type Doc, PostingError } from "./posting-contracts.ts";
/**
 * Application-layer proof immediately before a ledger write. PostgreSQL
 * repeats these assertions at the deferred-constraint boundary; keeping both
 * defenses independent turns a malformed projection into a readable posting
 * error before any journal row is inserted.
 */
export function assertFinalKernelBalance(
  lines: readonly { amount: string; subsidiaryId: string }[],
): void {
  if (lines.length < 2)
    throw new PostingError("posting produced fewer than 2 lines");
  const total = sum(lines.map((line) => line.amount));
  if (!isZero(total))
    throw new PostingError(
      `functional-currency journal does not balance (sum=${total})`,
    );
  const bySubsidiary = new Map<string, string[]>();
  for (const line of lines) {
    const amounts = bySubsidiary.get(line.subsidiaryId) ?? [];
    amounts.push(line.amount);
    bySubsidiary.set(line.subsidiaryId, amounts);
  }
  for (const [subsidiaryId, amounts] of bySubsidiary) {
    const subsidiaryTotal = sum(amounts);
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
  if (doc.kind === "vendor_credit" && !migration && toUnits(doc.total) < 0n) {
    throw new PostingError(
      `a credit memo must carry a positive total; a negative balance owed to the vendor is a bill`,
    );
  }
}
