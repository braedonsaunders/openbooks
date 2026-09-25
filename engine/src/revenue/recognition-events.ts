/** Recognition event recording. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { eventMonth, recognitionEventDecimal } from "./recognition-dates.ts";
import { RevenueRecognitionError, assertEnabled } from "./recognition-transaction-price.ts";
import { buildAllRecognitionSchedulesOn, lockObligationContract, type RevenueChangeBasis } from "./recognition-schedule-build.ts";

// ---------------------------------------------------------------------------
// recordRecognitionEvent — persist a milestone or usage event
// ---------------------------------------------------------------------------

export interface RecordRecognitionEventInput {
  obligationId: string;
  orgId: string;
  actorId: string | null;
  /** Accounting month the event belongs to (YYYY-MM-01). */
  periodMonth: string;
  /** Amount to recognize, decimal string. */
  amount: string;
  description?: string | null;
  /** Stable source identity used to make retries exactly once. */
  sourceReference: string;
  unitRate?: string | null;
  quantity?: string | null;
}

export interface RecordRecognitionEventResult {
  eventId: string;
}

/**
 * Record a milestone achievement or metered-usage occurrence for a performance
 * obligation. The event is persisted as subledger evidence and drives the next
 * schedule rebuild: the next call to buildRecognitionSchedule on the obligation
 * will load these events and plan each period's unrecognized balance.
 *
 * Corrections and amendments are additive — posting history is never rewritten.
 * A correction event with a negative amount reverses the prior recognition in
 * the affected period through the normal schedule-rebuild / posting flow.
 */
export async function recordRecognitionEvent(
  input: RecordRecognitionEventInput,
): Promise<RecordRecognitionEventResult> {
  eventMonth(input.periodMonth);
  const amount = recognitionEventDecimal(input.amount, "event amount");
  const unitRate = input.unitRate == null ? null : recognitionEventDecimal(input.unitRate, "event unit rate");
  const quantity = input.quantity == null ? null : recognitionEventDecimal(input.quantity, "event quantity");
  const sourceReference = typeof input.sourceReference === "string"
    ? input.sourceReference.trim()
    : "";
  if (!sourceReference || sourceReference.length > 500) {
    throw new RevenueRecognitionError(
      "recognition events require a non-blank sourceReference of at most 500 characters",
    );
  }

  // The event row and every book's rebuilt schedule are one atomic financial
  // unit.  If a period is missing (or any book rebuild fails), the inserted
  // event rolls back with the partial schedules and a retry can safely claim
  // the source identity again.
  return await db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);

    await lockObligationContract(tx,input.orgId,input.obligationId);
    // Validate the obligation exists and uses a milestone or usage method.
    const oblRes = (await tx.execute<{ id: string; description: string; method: string; status: string }>(sql`
      select o.id, o.description, r.method, o.status
        from performance_obligations o
        join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
       where o.id = ${input.obligationId} and o.org_id = ${input.orgId}
       for update of o`));
    if (!oblRes.rows[0]) {
      throw new RevenueRecognitionError("obligation not found");
    }
    if (oblRes.rows[0].status === "cancelled") throw new RevenueRecognitionError("cancelled obligations cannot accept recognition events");
    if (oblRes.rows[0].method !== "milestone" && oblRes.rows[0].method !== "usage") {
      throw new RevenueRecognitionError(
        `recognition method '${oblRes.rows[0].method}' does not accept events; only milestone and usage methods are supported`,
      );
    }
    // A promise retired by a prospective modification keeps its satisfied
    // status but its schedules are closed: the rebuild plans zero lines for
    // them, so an accepted event would sit in an event row that can never
    // reach the plan or the GL. Refuse by name before inserting anything.
    // Fully satisfied but NOT retired promises still accept negative
    // corrections, which reverse earned revenue through the normal rebuild.
    const schedRes = (await tx.execute<{ change_basis: RevenueChangeBasis | null }>(sql`
      select change_basis from recognition_schedules
       where obligation_id = ${input.obligationId} and org_id = ${input.orgId}`));
    const retirement = schedRes.rows
      .map((row) => row.change_basis)
      .find((basis) => basis?.retired);
    if (retirement) {
      throw new RevenueRecognitionError(
        `"${oblRes.rows[0].description}" was retired by modification ${retirement.changeId} on ${retirement.effectiveOn} — record the event against its replacement promise or amend the contract`,
      );
    }

    // The partial unique index is the concurrency authority.  A conflicting
    // transaction waits for the winner to commit, then this statement returns
    // no row and the committed event is compared below.
    const res = (await tx.execute<{ id: string }>(sql`
      insert into recognition_events
        (org_id, obligation_id, period_month, amount, description, source_reference,
         unit_rate, quantity, created_by, updated_by)
      values (${input.orgId}, ${input.obligationId}, ${input.periodMonth},
              ${amount}, ${input.description ?? null}, ${sourceReference},
              ${unitRate}, ${quantity},
              ${input.actorId}, ${input.actorId})
      on conflict (org_id, obligation_id, source_reference)
        where source_reference is not null
      do nothing
      returning id`));

    if (res.rows[0]) {
      // Rebuild the obligation's schedule on every GL-posting book so the new
      // event immediately appears as a planned recognition line.  This stays
      // on tx, so a failure rolls back both the event and all schedule writes.
      await buildAllRecognitionSchedulesOn(tx, input.obligationId, input.orgId, input.actorId);
      return { eventId: res.rows[0].id };
    }

    // A source reference may be retried with the exact same event payload,
    // which is a successful replay.  Reusing it with a different payload is a
    // fail-closed conflict: silently accepting it would make the source key's
    // financial meaning depend on whichever request won the race.
    const existing = (await tx.execute<{ id: string; payload_matches: boolean }>(sql`
      select id,
             (
               period_month = ${input.periodMonth}
               and amount = ${amount}::numeric
               and description is not distinct from ${input.description ?? null}
               and source_reference = ${sourceReference}
               and unit_rate is not distinct from ${unitRate}::numeric
               and quantity is not distinct from ${quantity}::numeric
             ) as payload_matches
        from recognition_events
       where org_id = ${input.orgId}
         and obligation_id = ${input.obligationId}
         and source_reference = ${sourceReference}
       limit 1`));
    const prior = existing.rows[0];
    if (!prior) {
      // The unique index and the read must agree.  Reaching this state means a
      // concurrent delete or a schema drift bypassed the idempotency contract;
      // do not insert a second event under the same source identity.
      throw new RevenueRecognitionError("recognition event idempotency winner was not visible");
    }
    if (!prior.payload_matches) {
      throw new RevenueRecognitionError(
        "recognition event sourceReference was already used with a different payload",
      );
    }
    return { eventId: prior.id };
  });
}
