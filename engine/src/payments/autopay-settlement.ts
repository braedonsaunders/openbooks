import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { addCalendarDays, businessToday } from "../platform/business-date.ts";
import { type AcceptanceProvider, type WebhookEvent } from "./acceptance.ts";
import {
  AutopayError,
  classifyDecline,
  type AutopayPolicy,
  retryLadderForClass,
  resolveAutopayPolicy,
  auditAutopay,
  terminalDeclineDetail,
} from "./autopay-policy.ts";
import {
  type AutopayRunResult,
  type CollectionCandidate,
  errorMessage,
  type OpenAttempt,
  scopeSubscriptionIds,
} from "./autopay-collection-state.ts";
import { postCollectionReceipt } from "./autopay-recovery.ts";

/** Settlement of collection outcomes: decline recording, final actions on exhausted schedules, subscription reactivation and receipt posting. */

/**
 * Post the receipt for a charge the provider confirmed, in its own
 * transaction. The attempt already carries the provider reference, so when
 * this fails the collection stays on record and the next run posts the
 * receipt without charging again; the failure is reported by name.
 */
export async function postCollectedReceipt(
  orgId: string,
  candidate: CollectionCandidate,
  attempt: OpenAttempt,
  providerRef: string,
  result: AutopayRunResult,
): Promise<void> {
  try {
    const receipt = await withOrg(orgId, async () => {
      const posted = await postCollectionReceipt(orgId, attempt.id);
      const reactivated =
        posted.status === "posted" ? await reactivateScopeSubscriptions(orgId, candidate, null) : 0;
      return { ...posted, reactivated };
    });
    if (receipt.status === "pending_approval") {
      result.notices.push({
        invoiceId: candidate.invoiceId,
        attemptId: attempt.id,
        status: "receipt_pending",
        detail: `Complete the tenant Flow gates for receipt ${receipt.receiptId}. The collected payment is retained and will not be charged again.`,
      });
      return;
    }
    result.succeeded += 1;
    result.reactivated += receipt.reactivated;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: attempt.id,
      status: "succeeded",
      detail: attempt.fallbackOf
        ? `collected ${attempt.amount} ${attempt.currency} on the backup method after the primary declined`
        : `collected ${attempt.amount} ${attempt.currency}`,
    });
  } catch (error) {
    const detail = `collected ${attempt.amount} ${attempt.currency} on invoice ${attempt.documentNumber} (provider reference ${providerRef}) but the receipt could not post: ${errorMessage(error)}; the collection stays on record and the next run posts the receipt without charging again`;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId: attempt.id,
      status: "receipt_pending",
      detail: detail.slice(0, 500),
    });
    result.orgErrors.push({ orgId, error: detail.slice(0, 1000) });
  }
}

/** Record a provider decline: schedule the next retry or run the final action. */
export async function recordDecline(
  orgId: string,
  candidate: CollectionCandidate,
  attemptId: string,
  position: number,
  today: string,
  policy: AutopayPolicy,
  declineCode: string | null,
  result: AutopayRunResult,
  opts?: { authUrl?: string | null },
): Promise<void> {
  const kind = classifyDecline(declineCode) ?? "soft";
  const ladder = retryLadderForClass(policy, kind);
  const authUrl = opts?.authUrl ?? null;
  if (position < ladder.length) {
    const nextRetryOn = addCalendarDays(today, ladder[position]!);
    const updated = await db.execute<{ id: string }>(
      sql`
      update collection_attempts
         set status = 'failed', decline_code = ${declineCode}, decline_kind = ${kind},
             next_retry_on = ${nextRetryOn}::date, auth_url = ${authUrl}, updated_at = now()
       where id = ${attemptId} and org_id = ${orgId} and status = 'initiated'
       returning id
    `,
      "objects",
    );
    if (!updated[0])
      throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
    result.failed += 1;
    result.retried += 1;
    result.notices.push({
      invoiceId: candidate.invoiceId,
      attemptId,
      status: "failed",
      detail:
        kind === "insufficient_funds"
          ? `declined for insufficient funds${declineCode ? ` (${declineCode})` : ""}; retrying ${nextRetryOn} near payday`
          : `declined${declineCode ? ` (${declineCode})` : ""}; retrying ${nextRetryOn}`,
    });
    return;
  }
  const updated = await db.execute<{ id: string }>(
    sql`
    update collection_attempts
       set status = 'failed', decline_code = ${declineCode}, decline_kind = ${kind},
           next_retry_on = null, auth_url = ${authUrl}, updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status = 'initiated'
     returning id
  `,
    "objects",
  );
  if (!updated[0])
    throw new AutopayError("collection attempt changed underfoot; refusing to record over it");
  result.failed += 1;
  result.notices.push({
    invoiceId: candidate.invoiceId,
    attemptId,
    status: "failed",
    detail: terminalDeclineDetail(kind, declineCode),
  });
  const acted = await applyFinalAction(orgId, candidate, policy, null);
  result.suspended += acted.suspended;
  result.canceled += acted.canceled;
}

/**
 * Run the policy's final action after the schedule runs out: suspend (stop
 * billing, keep the contract for reactivation) or cancel. Audited per
 * subscription with before/after state. `none` leaves billing untouched.
 */
export async function applyFinalAction(
  orgId: string,
  candidate: Pick<CollectionCandidate, "partyId" | "subscriptionId" | "invoiceId">,
  policy: AutopayPolicy,
  actorId: string | null,
): Promise<{ suspended: number; canceled: number }> {
  const outcome = { suspended: 0, canceled: 0 };
  if (policy.finalAction === "none") return outcome;
  const today = await businessToday(orgId);
  const targets = await scopeSubscriptionIds(orgId, candidate);
  for (const subscriptionId of targets) {
    if (policy.finalAction === "suspend") {
      const flipped = await db.execute<{ id: string }>(
        sql`
        update subscriptions set status = 'suspended', updated_at = now(), updated_by = ${actorId}
         where id = ${subscriptionId} and org_id = ${orgId} and status = 'active'
         returning id
      `,
        "objects",
      );
      if (!flipped[0]) continue;
      outcome.suspended += 1;
      await auditAutopay(
        orgId,
        "subscriptions",
        subscriptionId,
        {
          event: "autopay_suspended",
          before: { status: "active" },
          after: { status: "suspended" },
          reason: `Automatic collection failed every retry under policy "${policy.policyName}"; billing stops until a payment succeeds.`,
        },
        actorId,
      );
    } else {
      const flipped = await db.execute<{ id: string }>(
        sql`
        update subscriptions set status = 'canceled', canceled_on = ${today}::date,
               updated_at = now(), updated_by = ${actorId}
         where id = ${subscriptionId} and org_id = ${orgId} and status in ('active', 'suspended')
         returning id
      `,
        "objects",
      );
      if (!flipped[0]) continue;
      outcome.canceled += 1;
      await auditAutopay(
        orgId,
        "subscriptions",
        subscriptionId,
        {
          event: "autopay_canceled",
          after: { status: "canceled" },
          reason: `Automatic collection failed every retry under policy "${policy.policyName}".`,
        },
        actorId,
      );
    }
  }
  return outcome;
}

/**
 * Reactivate subscriptions the final action suspended, once money moves
 * again. Only `suspended` flips — `canceled` stays terminal for the operator,
 * and `paused` stays the operator's own control.
 */
export async function reactivateScopeSubscriptions(
  orgId: string,
  candidate: Pick<CollectionCandidate, "partyId" | "subscriptionId">,
  actorId: string | null,
): Promise<number> {
  let count = 0;
  const targets = candidate.subscriptionId
    ? [candidate.subscriptionId]
    : (
        await db.execute<{ id: string }>(
          sql`
        select id from subscriptions
         where org_id = ${orgId} and customer_id = ${candidate.partyId} and status = 'suspended'
      `,
          "objects",
        )
      ).map((r) => r.id);
  for (const subscriptionId of targets) {
    const flipped = await db.execute<{ id: string }>(
      sql`
      update subscriptions set status = 'active', updated_at = now(), updated_by = ${actorId}
       where id = ${subscriptionId} and org_id = ${orgId} and status = 'suspended'
       returning id
    `,
      "objects",
    );
    if (!flipped[0]) continue;
    count += 1;
    await auditAutopay(
      orgId,
      "subscriptions",
      subscriptionId,
      {
        event: "autopay_reactivated",
        before: { status: "suspended" },
        after: { status: "active" },
        reason: "A collection succeeded; billing resumes.",
      },
      actorId,
    );
  }
  return count;
}

/**
 * Settle a provider payment event against a collection attempt (async bank
 * debit arriving days later, or a card result delivered by webhook instead
 * of the synchronous charge call). Returns null when no collection attempt
 * claims the event, so the hosted-checkout path runs as before.
 */
export async function settleCollectionAttemptEvent(
  orgId: string,
  provider: AcceptanceProvider,
  event: WebhookEvent,
): Promise<string | null> {
  return withOrg(orgId, async () => {
    const alternateRef = event.alternateExternalRef ?? null;
    const found = (
      await db.execute<{
        id: string;
        invoice_id: string;
        status: string;
        party_id: string;
        subscription_id: string | null;
      }>(
        sql`
      select a.id, a.invoice_id, a.status, e.party_id, e.subscription_id
        from collection_attempts a
        join autopay_enrollments e on e.id = a.enrollment_id and e.org_id = a.org_id
       where a.org_id = ${orgId} and a.provider = ${provider}
         and (a.provider_ref = ${event.externalRef}
              or (${alternateRef}::text is not null and a.provider_ref = ${alternateRef}))
       order by a.created_at desc limit 1
    `,
        "objects",
      )
    )[0];
    if (!found) return null;
    if (event.status === "succeeded") {
      const claimed = await db.execute<{ id: string }>(
        sql`
        update collection_attempts set status = 'processing', provider_ref = ${event.externalRef}, updated_at = now()
         where id = ${found.id} and org_id = ${orgId} and status in ('initiated', 'processing')
         returning id
      `,
        "objects",
      );
      if (!claimed[0]) return "duplicate";
      const receipt = await postCollectionReceipt(orgId, found.id);
      if (receipt.status === "pending_approval") return "receipt_pending";
      await reactivateScopeSubscriptions(
        orgId,
        { partyId: found.party_id, subscriptionId: found.subscription_id },
        null,
      );
      return "settled";
    }
    if (event.status === "processing") {
      await db.execute(sql`
        update collection_attempts set status = 'processing', provider_ref = ${event.externalRef}, updated_at = now()
         where id = ${found.id} and org_id = ${orgId} and status = 'initiated'
      `);
      return "processing";
    }
    if (event.status === "failed") {
      // Webhook failures on an already-settled attempt are stale duplicates.
      const current = (
        await db.execute<{ status: string }>(
          sql`
        select status from collection_attempts where id = ${found.id} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      if (!current || (current.status !== "initiated" && current.status !== "processing"))
        return "duplicate";
      const policy = await resolveAutopayPolicy(orgId);
      const today = await businessToday(orgId);
      const position =
        (
          await db.execute<{ retry_position: number }>(
            sql`
        select retry_position from collection_attempts where id = ${found.id} and org_id = ${orgId}
      `,
            "objects",
          )
        )[0]?.retry_position ?? 0;
      const candidate = {
        invoiceId: found.invoice_id,
        partyId: found.party_id,
        subscriptionId: found.subscription_id,
      };
      const kind =
        classifyDecline(
          (event.raw as Record<string, unknown> | undefined)?.declineCode as string | null,
        ) ?? "soft";
      const ladder = retryLadderForClass(policy, kind);
      if (position < ladder.length) {
        const nextRetryOn = addCalendarDays(today, ladder[position]!);
        await db.execute(sql`
          update collection_attempts
             set status = 'failed', decline_code = 'provider_reported', decline_kind = ${kind},
                 next_retry_on = ${nextRetryOn}::date, provider_ref = ${event.externalRef}, updated_at = now()
           where id = ${found.id} and org_id = ${orgId}
        `);
        return "failed_retry_scheduled";
      }
      await db.execute(sql`
        update collection_attempts
           set status = 'failed', decline_code = 'provider_reported', decline_kind = ${kind},
               next_retry_on = null, provider_ref = ${event.externalRef}, updated_at = now()
         where id = ${found.id} and org_id = ${orgId}
      `);
      await applyFinalAction(orgId, candidate, policy, null);
      return "failed_terminal";
    }
    if (event.status === "refunded" || event.status === "disputed") {
      // A chargeback parks a marker so the scan refuses the invoice until
      // finance reviews; a voluntary refund only needs the controller note.
      // Disputed events always carry the dispute flag, so they take the
      // chargeback arm with the provider dispute id attached.
      if (event.dispute && event.intentRef) {
        await db.execute(sql`
          insert into payment_pending_clawbacks
            (org_id, provider, intent_ref, event_status, event_payload, last_seen_at)
          values (${orgId}, ${provider}, ${event.intentRef}, 'refunded',
                  ${JSON.stringify({ externalRef: event.externalRef, collectionAttemptId: found.id })}::jsonb, now())
          on conflict (org_id, provider, intent_ref)
          do update set event_status = excluded.event_status,
            event_payload = excluded.event_payload,
            last_seen_at = now()
        `);
      }
      await auditAutopay(
        orgId,
        "collection_attempts",
        found.id,
        {
          event: event.dispute ? "dispute_reported" : "refund_reported",
          reason: event.dispute
            ? "Provider reported a chargeback against this collection; reverse the receipt via payments if funds were clawed back."
            : "Provider reported a refund against this collection; the invoice balance already reflects it.",
        },
        null,
      );
      return "refunded_noted";
    }
    return null;
  });
}
