import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { PaymentError } from "./payment-errors.ts";
/** The only run statuses a cancellation may consume. */
const CANCELLABLE_RUN_STATUSES = ["draft", "rejected", "rolled_back"];

/**
 * Actor identity for lifecycle writes the engine performs itself instead of an
 * operator — today, direct-debit cleanup after a failed run creation. The nil
 * UUID is the established system sentinel for actor columns without a users
 * foreign key (`payment_runs.updated_by`), so a system-initiated
 * cancellation is stamped on the mutated row itself.
 */
export const PAYMENT_RUN_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Cancel a draft run: void nothing — drafts are deleted, instructions cancelled.
 *
 * Cancellation evidence names who ordered it and why, and is written inside
 * the same transaction as the instruction/run mutation, so the canonical
 * `run_cancelled` payment_event and the append-only audit_log row commit or
 * roll back together with the mutation — never before it, never after it.
 *
 * Both paths are attributable by contract. A user-initiated cancellation takes
 * the permission gate's authenticated user id as `actorId` plus the
 * client-supplied validated reason, and records that user on every evidence
 * surface. An engine-initiated cancellation passes
 * {@link PAYMENT_RUN_SYSTEM_ACTOR_ID} plus an internal reason code from
 * {@link PAYMENT_RUN_INTERNAL_CANCEL_REASONS}; because payment_events and
 * audit_log key actors to users, the sentinel maps to a null evidence actor —
 * the repository-wide "system" identity — while the mutated run row still
 * carries the sentinel in `updated_by`, and `details.source` distinguishes
 * `"system"` from `"user"` in both evidence payloads.
 *
 * Cancellability is judged twice: the caller-facing preflight refuses obvious
 * non-candidates fast, and the transaction re-judges under the run row lock
 * before any child row moves. A run that leaves the cancellable set after the
 * preflight (submitted, approved, its file regenerated, or posted by a
 * concurrent operator) can therefore never be stamped `cancelled` over the
 * state another lifecycle path installed — the predicated final write proves
 * the predicate held at write time or the whole cancellation rolls back.
 */
export async function cancelPaymentRun(
  runId: string,
  orgId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  if (!actorId.trim()) throw new PaymentError("a cancellation actor is required");
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new PaymentError("a cancellation reason is required");
  const systemInitiated = actorId === PAYMENT_RUN_SYSTEM_ACTOR_ID;
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (!CANCELLABLE_RUN_STATUSES.includes(run.status)) {
    throw new PaymentError(`a ${run.status} run cannot be cancelled`);
  }

  await db.transaction(async (tx) => {
    // The run row is the cancellation claim: lock it before judging or
    // mutating anything, serializing against posters, generators, and
    // settlement writers in their shared lock order.
    const locked = (await tx.execute<{ status: string }>(sql`
      select status
        from payment_runs
       where id = ${runId} and org_id = ${orgId}
        for update
    `)).rows[0];
    if (!locked) throw new PaymentError("payment run not found");
    if (!CANCELLABLE_RUN_STATUSES.includes(locked.status)) {
      throw new PaymentError(`a ${locked.status} run cannot be cancelled`);
    }
    const instructions = await tx
      .select()
      .from(schema.paymentInstructions)
      .where(and(eq(schema.paymentInstructions.paymentRunId, runId), eq(schema.paymentInstructions.orgId, orgId)));

    for (const ins of instructions) {
      // Release the FK to the draft payment before deleting it.
      await tx
        .update(schema.paymentInstructions)
        .set({ status: "cancelled", paymentDocumentId: null, updatedAt: new Date() })
        .where(and(eq(schema.paymentInstructions.id, ins.id), eq(schema.paymentInstructions.orgId, orgId)));
      if (ins.paymentDocumentId) {
        const [doc] = await tx
          .select({ status: schema.documents.status })
          .from(schema.documents)
          .where(and(eq(schema.documents.id, ins.paymentDocumentId), eq(schema.documents.orgId, orgId)));
        if (doc && doc.status !== "draft") {
          throw new PaymentError("run has payments that are no longer drafts — it cannot be cancelled");
        }
        await tx.execute(sql`delete from document_lines where document_id = ${ins.paymentDocumentId} and org_id = ${orgId}`);
        await tx.execute(sql`delete from documents where id = ${ins.paymentDocumentId} and org_id = ${orgId}`);
      }
    }
    // Predicated on the same statuses judged under the lock above: a run that
    // changed state while this transaction worked cannot become `cancelled`.
    const cancelled = await tx.execute<{ id: string }>(sql`
      update payment_runs
         set status = 'cancelled', updated_at = now(), updated_by = ${actorId}
        where id = ${runId} and org_id = ${orgId}
          and status in ('draft', 'rejected', 'rolled_back')
        returning id
    `);
    if (!cancelled.rows[0]) {
      throw new PaymentError("the run changed state while it was being cancelled");
    }
    // Canonical lifecycle evidence, only after the mutation proved its own
    // predicate: the event feeds the run activity feed, the append-only audit
    // row is the auditor's before/after proof. Both sit inside this
    // transaction, so a refusal anywhere above leaves no trace of a
    // cancellation that never happened. A system-initiated cancellation
    // carries the null actor (the repository-wide "system" identity on these
    // user-keyed evidence tables); the sentinel itself is already stamped on
    // the run row above.
    await tx.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: "run_cancelled",
      fromStatus: locked.status,
      toStatus: "cancelled",
      details: { reason: trimmedReason, source: systemInitiated ? "system" : "user" },
      actorId: systemInitiated ? null : actorId,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_runs', ${runId}, 'void',
              ${JSON.stringify({ before: { status: locked.status }, after: { status: "cancelled" }, reason: trimmedReason, source: systemInitiated ? "system" : "user" })}::jsonb,
              ${systemInitiated ? null : actorId})
    `);
  });
}

/** Internal reason codes for engine-initiated cancellations (never user prose). */
export const PAYMENT_RUN_INTERNAL_CANCEL_REASONS = {
  /** A direct-debit collection run claimed its invoices, then creation failed. */
  directDebitCreationFailed: "direct_debit_creation_failed",
} as const;
