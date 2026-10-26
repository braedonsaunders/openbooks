import { sql } from "drizzle-orm";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { replayTerminalPostingEffect } from "../ledger/posting-effects.ts";
import { loadPaymentDocument, paymentDocumentScope } from "./payment-queries.ts";
import type { PaymentKind } from "./payment-contracts.ts";

/** Replay a payment's terminal posting effect inside its organization boundary. */
export async function replayPaymentPostingEffect(args: {
  orgId: string;
  paymentId: string;
  paymentKind: PaymentKind;
  actorId: string;
  reason: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ payment: NonNullable<Awaited<ReturnType<typeof loadPaymentDocument>>> } | null> {
  return withOrgTransaction(args.orgId, async () => {
    const payment = await paymentDocumentScope(args.orgId, args.paymentId);
    if (!payment || payment.kind !== args.paymentKind) return null;
    const effect = (
      await db.execute<{ id: string }>(
        sql`select id from posting_effects where org_id = ${args.orgId} and document_id = ${args.paymentId}`,
        "objects",
      )
    )[0];
    if (!effect) return null;
    await replayTerminalPostingEffect({
      orgId: args.orgId,
      id: effect.id,
      actorId: args.actorId,
      reason: args.reason,
      allowedSubsidiaryIds: args.allowedSubsidiaryIds,
    });
    const updated = await loadPaymentDocument(
      args.paymentId,
      payment.kind,
      args.orgId,
      args.allowedSubsidiaryIds,
    );
    if (!updated) throw new ScopeNotFoundError();
    return { payment: updated };
  });
}
