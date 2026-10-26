import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import { event, lockPendingPaymentInstructions } from "./operations-shared.ts";

/**
 * Durable SFTP delivery claim (migration 0290). The publish-then-record race
 * this closes: delivery used to SELECT the approval, write the bytes to the
 * SFTP endpoint, and only then record — a void, supersede, rejection, or
 * rollback landing between the SELECT and the write published a disallowed
 * file while the record refused, leaving published bytes with no delivery
 * evidence.
 *
 * The lifecycle is now claim → publish → record, all conditional:
 *
 *   approved (or a live re-delivery from delivered)
 *     --claim--> delivering (lease: token + owner + expiry, row locked)
 *     --publish--> bytes on the endpoint
 *     --record--> delivered (conditional on the claim token)
 *
 * Compensation is explicit, never silent:
 * - a failed write releases the claim back to approved (nothing published);
 * - a failed record after a successful write parks the file in
 *   delivery_uncertain (bytes published but unconfirmed — re-delivery
 *   blocked, operator-visible), never as undelivered;
 * - an expired lease never auto-republishes (those bytes may already be at
 *   the bank): reclaim parks it uncertain too, and an explicit operator
 *   resolution releases or confirms it.
 */

/** How long one publish attempt owns its file before the lease is reclaimable. */
export const DELIVERY_CLAIM_TTL_SECONDS = 300;

export interface DeliveryClaim {
  token: string;
  owner: string;
  expiresAt: Date;
}

/** Name the actual file state and its remedy when a claim cannot be taken. */
function deliveryClaimRefusal(status: string | null, owner: string | null): PaymentError {
  switch (status) {
    case null:
    case undefined:
      return new PaymentError("payment file not found");
    case "pending_approval":
    case "generated":
      return new PaymentError("approve the payment file before SFTP delivery");
    case "rejected":
      return new PaymentError(
        "the payment file was rejected and cannot be delivered; reprocess the run to generate a new file",
      );
    case "voided":
    case "superseded":
      return new PaymentError(
        `the payment file is ${status} and cannot be delivered; generate a new file from the run`,
      );
    case "delivering":
      return new PaymentError(
        `an SFTP delivery by ${owner ?? "another worker"} is already in progress for this file; wait for it to complete or expire before retrying`,
      );
    case "delivery_uncertain":
      return new PaymentError(
        "this file's delivery outcome is uncertain (bytes may already be published); resolve the uncertain delivery before re-delivering",
      );
    default:
      return new PaymentError(
        `payment file is ${status} and cannot be delivered; generate a new file from the run`,
      );
  }
}

/**
 * Claim a payment file for SFTP delivery BEFORE the bytes are published, in
 * one transaction: lock the row, verify it is approved (or a live
 * re-delivery from delivered — never superseded, voided, rejected, or
 * pending), and move it to delivering with a lease. Returns the claim the
 * publish and record steps must present.
 */
export async function claimPaymentFileDelivery(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  /** Names the delivery attempt, e.g. `sftp:<serverId>`. Surfaced on conflicts. */
  owner: string;
  ttlSeconds?: number;
}): Promise<DeliveryClaim> {
  const ttlSeconds = opts.ttlSeconds ?? DELIVERY_CLAIM_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new PaymentError("delivery claim TTL must be a positive number of seconds");
  }
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  return withOrgTransaction(opts.orgId, async () => {
    // Read the immutable run link, then use the generation/posting lock order:
    // run → instructions → file. This prevents both stale eligibility and
    // cycles with a generator that must lock the run before the artifact.
    const reference = (
      await db.execute<{ payment_run_id: string }>(
        sql`
      select payment_run_id from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}
    `,
        "objects",
      )
    )[0];
    if (!reference) throw deliveryClaimRefusal(null, null);
    const run = (
      await db.execute<{ id: string }>(
        sql`
      select id from payment_runs where id = ${reference.payment_run_id} and org_id = ${opts.orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!run) throw deliveryClaimRefusal(null, null);
    await lockPendingPaymentInstructions(reference.payment_run_id, opts.orgId);
    // The file state is judged only after its row lock; a void, supersede,
    // rejection, or rollback that commits first leaves no claimable state.
    const current = (
      await db.execute<{
        payment_run_id: string;
        status: string;
        delivery_claim_owner: string | null;
      }>(
        sql`
      select payment_run_id, status, delivery_claim_owner from payment_files
       where id = ${opts.fileId} and org_id = ${opts.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (
      !current ||
      current.payment_run_id !== reference.payment_run_id ||
      (current.status !== "approved" && current.status !== "delivered")
    ) {
      throw deliveryClaimRefusal(current?.status ?? null, current?.delivery_claim_owner ?? null);
    }
    // Predicated on the judged state (belt and braces — the row is already
    // locked): the returning row proves the predicate held at write time,
    // and a zero-row outcome fails the whole transaction instead of
    // claiming a file that moved.
    const fromStatus = current.status;
    const claimed = await db.execute<{ id: string }>(
      sql`
      update payment_files set status = 'delivering',
        delivery_claim_token = ${token}, delivery_claim_owner = ${opts.owner},
        delivery_claim_expires_at = ${expiresAt},
        updated_at = now(), updated_by = ${opts.userId}
       where id = ${opts.fileId} and org_id = ${opts.orgId} and status = ${fromStatus}
      returning id
    `,
      "objects",
    );
    if (!claimed[0])
      throw new PaymentError(
        "cannot claim the payment file for SFTP delivery: the file moved while it was locked; reload and retry",
      );
    await event({
      orgId: opts.orgId,
      runId: current.payment_run_id,
      fileId: opts.fileId,
      actorId: opts.userId,
      eventType: "file_delivery_claimed",
      fromStatus,
      toStatus: "delivering",
      details: { owner: opts.owner },
    });
    return { token, owner: opts.owner, expiresAt };
  });
}

/**
 * Release a held claim after a failed publish (nothing reached the bank):
 * delivering + the claim token moves back to approved with the lease
 * cleared. Strict: any other state throws instead of silently absorbing a
 * race the caller cannot see.
 */
export async function releaseDeliveryClaim(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  token: string;
}): Promise<void> {
  await withOrgTransaction(opts.orgId, async () => {
    const released = await db.execute<{ payment_run_id: string }>(
      sql`
      update payment_files set status = 'approved',
        delivery_claim_token = null, delivery_claim_owner = null, delivery_claim_expires_at = null,
        updated_at = now(), updated_by = ${opts.userId}
       where id = ${opts.fileId} and org_id = ${opts.orgId}
         and status = 'delivering' and delivery_claim_token = ${opts.token}
      returning payment_run_id
    `,
      "objects",
    );
    if (!released[0]) {
      const current = (
        await db.execute<{ status: string }>(
          sql`
        select status from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}
      `,
          "objects",
        )
      )[0];
      throw new PaymentError(
        `cannot release the SFTP delivery claim: the file is ${current?.status ?? "no longer present"}, not delivering under this claim`,
      );
    }
    await event({
      orgId: opts.orgId,
      runId: released[0].payment_run_id,
      fileId: opts.fileId,
      actorId: opts.userId,
      eventType: "file_delivery_claim_released",
      fromStatus: "delivering",
      toStatus: "approved",
    });
  });
}

/**
 * Record an SFTP delivery AFTER a successful publish, conditional on the
 * claim: only the delivering row carrying this token moves to delivered
 * (lease cleared). A raced void/supersede/reject would have refused while
 * the claim was held, so a zero-row outcome means the claim itself was
 * lost (expired and reclaimed, or operator-resolved) — fail closed and say
 * so rather than recording a delivery the claim no longer owns. Bytes were
 * published by the caller: on refusal the file must be parked uncertain by
 * the caller, never left delivering and never recorded as undelivered.
 */
export async function recordPaymentFileSftpDelivery(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  targetRef: string;
  claimToken: string;
  response?: Record<string, unknown>;
}): Promise<void> {
  await withOrgTransaction(opts.orgId, async () => {
    const reference = (
      await db.execute<{ payment_run_id: string }>(
        sql`
      select payment_run_id from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}
    `,
        "objects",
      )
    )[0];
    if (!reference) throw new PaymentError("payment file not found");
    const run = (
      await db.execute<{ id: string }>(
        sql`
      select id from payment_runs where id = ${reference.payment_run_id} and org_id = ${opts.orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!run) throw new PaymentError("payment run not found");
    const file = await db.execute<{ payment_run_id: string }>(
      sql`
      select payment_run_id from payment_files
       where id = ${opts.fileId} and org_id = ${opts.orgId}
         and status = 'delivering' and delivery_claim_token = ${opts.claimToken}
       for update
    `,
      "objects",
    );
    if (!file[0]) {
      const current = (
        await db.execute<{ status: string; delivery_claim_owner: string | null }>(
          sql`
        select status, delivery_claim_owner from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}
      `,
          "objects",
        )
      )[0];
      throw new PaymentError(
        current?.status === "delivered"
          ? "the SFTP delivery was already recorded as delivered"
          : `cannot record the SFTP delivery: ${current ? `the file is ${current.status} (claim ${current.delivery_claim_owner ? `by ${current.delivery_claim_owner}` : "missing"})` : "the file is no longer present"} — park the published file as delivery-uncertain instead of recording against a lost claim`,
      );
    }
    await db.insert(schema.paymentFileDeliveries).values({
      orgId: opts.orgId,
      paymentFileId: opts.fileId,
      channel: "sftp",
      targetRef: opts.targetRef,
      status: "delivered",
      attemptCount: 1,
      lastAttemptAt: new Date(),
      deliveredAt: new Date(),
      response: opts.response ?? {},
      createdBy: opts.userId,
      updatedBy: opts.userId,
    });
    // Conditional on the claim token (belt and braces — the select above
    // already locked onto the same row): a claim lost between the select
    // and this write cannot transition, and the missing returning row fails
    // the whole transaction.
    const delivered = await db.execute<{ id: string }>(
      sql`
      update payment_files set status = 'delivered',
        delivery_claim_token = null, delivery_claim_owner = null, delivery_claim_expires_at = null,
        updated_at = now(), updated_by = ${opts.userId}
       where id = ${opts.fileId} and org_id = ${opts.orgId}
         and status = 'delivering' and delivery_claim_token = ${opts.claimToken}
       returning id
    `,
      "objects",
    );
    if (!delivered[0])
      throw new PaymentError(
        "cannot record the SFTP delivery: the delivery claim was lost before the record committed",
      );
    await markRunDelivered(opts.orgId, opts.userId, file[0].payment_run_id);
    await event({
      orgId: opts.orgId,
      runId: file[0].payment_run_id,
      fileId: opts.fileId,
      actorId: opts.userId,
      eventType: "file_delivered_sftp",
      fromStatus: "delivering",
      toStatus: "delivered",
      details: { targetRef: opts.targetRef },
    });
  });
}

/**
 * Flip the run to delivered when it is still generated; tolerate an already
 * delivered run (re-delivery); any other run state refuses by name. Shared
 * by the SFTP record path and the uncertain-resolution path so both agree
 * on what a delivery may conclude.
 */
async function markRunDelivered(orgId: string, userId: string, runId: string): Promise<void> {
  const runDelivered = await db.execute<{ id: string }>(
    sql`
    update payment_runs set status = 'delivered', updated_at = now(), updated_by = ${userId}
     where id = ${runId} and org_id = ${orgId} and status = 'generated'
     returning id
  `,
    "objects",
  );
  if (!runDelivered[0]) {
    const runState = (
      await db.execute<{ status: string }>(
        sql`
      select status from payment_runs
       where id = ${runId} and org_id = ${orgId}
    `,
        "objects",
      )
    )[0];
    if (runState?.status !== "delivered") {
      throw new PaymentError(
        `payment run is ${runState?.status ?? "no longer present"} and cannot be marked delivered; reload the run before recording the delivery`,
      );
    }
  }
}

/**
 * Park a published-but-unconfirmed file as delivery_uncertain: the record
 * step failed after the bytes reached the endpoint, so the file must read
 * as published (never undelivered) while blocking re-delivery until an
 * operator resolves it. Conditional on the claim token; the lease owner is
 * kept as evidence of which attempt published.
 */
export async function markDeliveryUncertain(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  token: string;
  error: string;
}): Promise<void> {
  await withOrgTransaction(opts.orgId, async () => {
    const parked = await db.execute<{ payment_run_id: string }>(
      sql`
      update payment_files set status = 'delivery_uncertain',
        delivery_claim_token = null,
        updated_at = now(), updated_by = ${opts.userId}
       where id = ${opts.fileId} and org_id = ${opts.orgId}
         and status = 'delivering' and delivery_claim_token = ${opts.token}
      returning payment_run_id
    `,
      "objects",
    );
    if (!parked[0]) {
      const current = (
        await db.execute<{ status: string }>(
          sql`
        select status from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}
      `,
          "objects",
        )
      )[0];
      throw new PaymentError(
        `cannot park the published file as delivery-uncertain: the file is ${current?.status ?? "no longer present"}, not delivering under this claim`,
      );
    }
    await event({
      orgId: opts.orgId,
      runId: parked[0].payment_run_id,
      fileId: opts.fileId,
      actorId: opts.userId,
      eventType: "file_delivery_uncertain",
      fromStatus: "delivering",
      toStatus: "delivery_uncertain",
      details: { error: opts.error },
    });
  });
}

/**
 * Recover expired leases: a worker that died mid-delivery leaves its file
 * in delivering with a dead lease. Reclaim parks each such file as
 * delivery_uncertain (re-delivery blocked, operator-visible) — never back
 * to approved, because the bytes may already be at the bank and a silent
 * re-publish would duplicate them. Returns the parked files.
 */
export async function reclaimExpiredDeliveryClaims(opts: {
  orgId: string;
  userId: string;
}): Promise<{ fileId: string; runId: string }[]> {
  return withOrgTransaction(opts.orgId, async () => {
    const expired = await db.execute<{ id: string; payment_run_id: string }>(
      sql`
      select id, payment_run_id from payment_files
       where org_id = ${opts.orgId} and status = 'delivering'
         and delivery_claim_expires_at is not null and delivery_claim_expires_at < now()
       for update
    `,
      "objects",
    );
    const reclaimed: { fileId: string; runId: string }[] = [];
    for (const row of expired) {
      await db.execute(sql`
        update payment_files set status = 'delivery_uncertain', delivery_claim_token = null,
          updated_at = now(), updated_by = ${opts.userId}
         where id = ${row.id} and org_id = ${opts.orgId} and status = 'delivering'
      `);
      await event({
        orgId: opts.orgId,
        runId: row.payment_run_id,
        fileId: row.id,
        actorId: opts.userId,
        eventType: "file_delivery_uncertain",
        fromStatus: "delivering",
        toStatus: "delivery_uncertain",
        details: { reason: "delivery claim expired" },
      });
      reclaimed.push({ fileId: row.id, runId: row.payment_run_id });
    }
    return reclaimed;
  });
}

/**
 * Explicit operator resolution of an uncertain delivery, with a mandatory
 * reason: confirm the bank has the file (delivered, recording delivery
 * evidence) or release it back to approved for a careful re-delivery (only
 * after verifying with the bank that nothing arrived). Either way the
 * decision and its reason are audited on the file's event trail.
 */
export async function resolveUncertainDelivery(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  outcome: "delivered" | "approved";
  reason: string;
  /** When the caller authorized a run (not an arbitrary file), keep lineage inside it. */
  runId?: string | null;
}): Promise<void> {
  if (!opts.reason.trim())
    throw new PaymentError("resolving an uncertain delivery requires a reason");
  if (opts.outcome !== "delivered" && opts.outcome !== "approved") {
    throw new PaymentError("uncertain delivery outcome must be 'delivered' or 'approved'");
  }
  await withOrgTransaction(opts.orgId, async () => {
    const reference = (
      await db.execute<{ payment_run_id: string }>(
        sql`
      select payment_run_id from payment_files
       where id = ${opts.fileId} and org_id = ${opts.orgId}
         ${opts.runId ? sql`and payment_run_id = ${opts.runId}` : sql``}
    `,
        "objects",
      )
    )[0];
    if (!reference) throw new PaymentError("payment file not found");
    const run = (
      await db.execute<{ id: string }>(
        sql`
      select id from payment_runs where id = ${reference.payment_run_id} and org_id = ${opts.orgId} for update
    `,
        "objects",
      )
    )[0];
    if (!run) throw new PaymentError("payment run not found");
    const file = await db.execute<{ payment_run_id: string }>(
      sql`
      select payment_run_id from payment_files
       where id = ${opts.fileId} and org_id = ${opts.orgId} and status = 'delivery_uncertain'
         ${opts.runId ? sql`and payment_run_id = ${opts.runId}` : sql``}
       for update
    `,
      "objects",
    );
    if (!file[0]) {
      const current = (
        await db.execute<{ status: string }>(
          sql`
        select status from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}
      `,
          "objects",
        )
      )[0];
      throw new PaymentError(
        `cannot resolve the uncertain delivery: the file is ${current?.status ?? "no longer present"}, not delivery-uncertain`,
      );
    }
    if (opts.outcome === "delivered") {
      await db.insert(schema.paymentFileDeliveries).values({
        orgId: opts.orgId,
        paymentFileId: opts.fileId,
        channel: "sftp",
        targetRef: null,
        status: "delivered",
        attemptCount: 1,
        lastAttemptAt: new Date(),
        deliveredAt: new Date(),
        response: { resolution: opts.reason },
        createdBy: opts.userId,
        updatedBy: opts.userId,
      });
    }
    await db.execute(sql`
      update payment_files set status = ${opts.outcome},
        delivery_claim_token = null, delivery_claim_owner = null, delivery_claim_expires_at = null,
        updated_at = now(), updated_by = ${opts.userId}
       where id = ${opts.fileId} and org_id = ${opts.orgId} and status = 'delivery_uncertain'
    `);
    if (opts.outcome === "delivered") {
      await markRunDelivered(opts.orgId, opts.userId, file[0].payment_run_id);
    }
    await event({
      orgId: opts.orgId,
      runId: file[0].payment_run_id,
      fileId: opts.fileId,
      actorId: opts.userId,
      eventType: "file_delivery_uncertain_resolved",
      fromStatus: "delivery_uncertain",
      toStatus: opts.outcome,
      details: { reason: opts.reason },
    });
  });
}

export async function recordPaymentFileDeliveryFailure(opts: {
  fileId: string;
  orgId: string;
  userId: string;
  channel: "sftp" | "bank_api";
  targetRef: string;
  error: string;
}): Promise<void> {
  await withOrgTransaction(opts.orgId, async () => {
    const file = await db.execute<{ payment_run_id: string }>(
      sql`select payment_run_id from payment_files where id = ${opts.fileId} and org_id = ${opts.orgId}`,
      "objects",
    );
    if (!file[0]) throw new PaymentError("payment file not found");
    await db
      .insert(schema.paymentFileDeliveries)
      .values({
        orgId: opts.orgId,
        paymentFileId: opts.fileId,
        channel: opts.channel,
        targetRef: opts.targetRef,
        status: "failed",
        attemptCount: 1,
        lastAttemptAt: new Date(),
        error: opts.error,
        createdBy: opts.userId,
        updatedBy: opts.userId,
      });
    await event({
      orgId: opts.orgId,
      runId: file[0].payment_run_id,
      fileId: opts.fileId,
      actorId: opts.userId,
      eventType: "file_delivery_failed",
      details: { channel: opts.channel, targetRef: opts.targetRef, error: opts.error },
    });
  });
}
