import { sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import {
  allocationsMatchApprovedSnapshot,
  validateAllocationInputs,
  type AllocationInput,
} from "./settlement-policy.ts";
import { type CreditAllocationInput } from "./payment-contracts.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { documentPostingPermission } from "../records/document-kind-permissions.ts";

/**
 * A run-claimed payment must settle exactly the items, credits, discount and
 * withholding its payment run selected.
 */
export async function assertPaymentRunComposition(
  runId: string,
  paymentDocId: string,
  allocations: AllocationInput[],
  creditAllocations: CreditAllocationInput[],
  discountAmount: string,
  withholdingAmount: string,
  orgId: string,
): Promise<void> {
  const rows = await db.execute<{
    source_open_line_id: string;
    source_document_id: string;
    kind: string;
    gross_amount: string;
    credit_amount: string;
    discount_amount: string;
    withholding_amount: string;
    credit_target_allocations: Array<{ toLineId: string; amount: string }> | null;
  }>(
    sql`
    select source_open_line_id, source_document_id, kind, gross_amount::text,
           credit_amount::text, discount_amount::text, withholding_amount::text, credit_target_allocations
      from payment_run_items
     where payment_run_id = ${runId} and payment_instruction_id = (
       select id from payment_instructions
        where payment_run_id = ${runId} and payment_document_id = ${paymentDocId}
          and org_id = ${orgId}
     ) and org_id = ${orgId} and status = 'selected'
     order by kind, source_open_line_id
     for update
  `,
    "objects",
  );
  // A bill the run settles wholly with credits is reserved by the run but
  // carries no cash allocation; its credits are checked with the credit items.
  const cashItems = rows.filter(
    (row) => row.kind !== "credit" && toUnits(row.gross_amount) - toUnits(row.credit_amount) !== 0n,
  );
  const creditItems = rows.filter((row) => row.kind === "credit");
  const actualCash = new Map(allocations.map((allocation) => [allocation.openLineId, allocation]));
  const expectedDiscount = cashItems.reduce(
    (total, row) => total + toUnits(row.discount_amount),
    0n,
  );
  const expectedWithholding = cashItems.reduce(
    (total, row) => total + toUnits(row.withholding_amount),
    0n,
  );
  let cashMatches = actualCash.size === cashItems.length;
  for (const item of cashItems) {
    const allocation = actualCash.get(item.source_open_line_id);
    if (!allocation) {
      cashMatches = false;
      continue;
    }
    const planned = fromUnits(toUnits(item.gross_amount) - toUnits(item.credit_amount));
    if (
      toUnits(allocation.sourceTransactionAmount) !== toUnits(planned) ||
      toUnits(allocation.targetTransactionAmount) !== toUnits(planned)
    )
      cashMatches = false;
  }
  const expectedCredits = creditItems.flatMap((item) => {
    if (!Array.isArray(item.credit_target_allocations)) return [];
    return item.credit_target_allocations.map((target) => ({
      fromLineId: item.source_open_line_id,
      toLineId: target.toLineId,
      amount: target.amount,
      sourceDocumentId: item.source_document_id,
    }));
  });
  const creditKey = (item: CreditAllocationInput) =>
    `${item.fromLineId}:${item.toLineId}:${toUnits(item.amount)}:${item.sourceDocumentId}`;
  const actualCreditKeys = creditAllocations.map(creditKey).sort();
  const expectedCreditKeys = expectedCredits.map(creditKey).sort();
  const creditMatches =
    creditItems.every((item) => Array.isArray(item.credit_target_allocations)) &&
    actualCreditKeys.length === expectedCreditKeys.length &&
    actualCreditKeys.every((key, index) => key === expectedCreditKeys[index]);
  if (
    !cashMatches ||
    !creditMatches ||
    toUnits(discountAmount) !== expectedDiscount ||
    toUnits(withholdingAmount) !== expectedWithholding
  ) {
    throw new PaymentError(
      "payment composition differs from the approved run items; release the run and re-plan before posting",
    );
  }
}

/** Post the payment, applications, realized FX, and links as one atomic unit. */

/**
 * Resolve a replay of an already-posted payment to its retained journal entry.
 * Replay resolves immutable accounting: it cannot re-price an approved payment,
 * re-apply its open items, or run without a live run claim or posting authority.
 */
export async function replayPostedPayment(
  doc: typeof schema.documents.$inferSelect,
  retainedEntryId: string | null,
  allocations: AllocationInput[] | undefined,
  userId: string | undefined,
  runClaim: { runId: string; token: string } | undefined,
): Promise<{ entryId: string }> {
  const snapshot = (doc.custom ?? {}) as {
    allocations?: AllocationInput[];
    creditAllocations?: CreditAllocationInput[];
    discountAmount?: string;
    withholdingAmount?: string;
    providerReturn?: unknown;
  };
  // Replay resolves immutable accounting; it cannot re-price an approved
  // payment, re-apply its open items, or turn a caller's body into a change.
  if (allocations !== undefined) {
    validateAllocationInputs(allocations);
    if (!allocationsMatchApprovedSnapshot(allocations, snapshot.allocations ?? [])) {
      throw new PaymentError(
        "payment allocations differ from the posted document; use a governed correction instead of replaying changed settlement evidence",
      );
    }
  }
  if (runClaim) {
    await assertPaymentRunComposition(
      runClaim.runId,
      doc.id,
      snapshot.allocations ?? [],
      snapshot.creditAllocations ?? [],
      snapshot.discountAmount ?? "0",
      snapshot.withholdingAmount ?? "0",
      doc.orgId,
    );
  } else if (snapshot.providerReturn === undefined) {
    const permission = documentPostingPermission(doc.kind);
    if (!userId || !permission)
      throw new PaymentError("Payment posting replay requires an authorized posting actor.");
    await lockActorCommandAuthority(db, doc.orgId, userId, doc.subsidiaryId, permission);
  }
  // Every replay authority shares the same feature boundary. The caller's org
  // mutex already precedes book and accounting-evidence locks.
  if (!(await lockAndCheckOrgFeature(db, doc.orgId, "banking"))) {
    throw new PaymentError(
      "Enable Banking in Company Settings → Features before replaying payment posting effects.",
    );
  }
  if (!doc.postedEntryId || doc.postedEntryId !== retainedEntryId) {
    throw new PaymentError(
      "The posted payment's retained journal identity is unavailable; reconcile its native accounting before replaying.",
    );
  }
  const entry = (
    await db.execute<{ id: string }>(
      sql`select id from journal_entries
    where org_id = ${doc.orgId} and id = ${doc.postedEntryId} and source_document_id = ${doc.id}
      and status = 'posted' -- Live entries only: payment effect replay requires its current unreversed journal.
    `,
      "objects",
    )
  )[0];
  if (!entry)
    throw new PaymentError(
      "The posted payment's retained journal is not posted for this receipt; reconcile its native accounting before replaying.",
    );
  return { entryId: entry.id };
}
