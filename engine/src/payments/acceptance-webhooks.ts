import { lockPaymentAttempt } from "./payment-attempt-lock.ts";
/** Provider webhook intake for payment acceptance: signature-verified
 *  deliveries are normalized by the adapters, then claimed and applied
 *  idempotently against the recorded checkout attempt. */
import { add, cmp } from "../money/money.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { db, withBypassContext, withOrg } from "../platform/db.ts";
import { ATTR_KIND, ATTR_ORG_ID, ATTR_SURFACE, runInSpan } from "../platform/telemetry.ts";
import { ACCEPTANCE_ADAPTERS } from "./acceptance-adapters.ts";
import { isJsonRecord, logPaymentWebhookEventFailure } from "./acceptance-provider-utils.ts";
import { recordSettlementDiscrepancy, settleAttempt } from "./acceptance-settlement.ts";
import { configSecrets } from "./acceptance-surcharge.ts";
import {
  type AcceptanceProvider,
  PaymentAcceptanceError,
  PaymentWebhookBatchError,
  type ProviderConfigRow,
  type ProviderWebhookResult,
  type WebhookEvent,
  type WebhookEventOutcome,
} from "./acceptance-types.ts";
import { paymentLinkTokenHash } from "./payment-link-seal.ts";
import { sql } from "drizzle-orm";

export async function handleProviderWebhook(
  provider: AcceptanceProvider,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<ProviderWebhookResult | null> {
  // bypass: connector-token — an inbound provider webhook is verified against every organization's signing secret.
  const configs = await withBypassContext(async () =>
    db.execute<ProviderConfigRow & { org_id: string }>(
      sql`
      select id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id,
             publishable_key, settings, surcharge_rule_id, secrets, org_id
        from psp_provider_configs
       where provider = ${provider} and is_enabled and acceptance_enabled
    `,
      "objects",
    ),
  );
  const adapter = ACCEPTANCE_ADAPTERS[provider];
  const verified: { orgId: string; events: WebhookEvent[] }[] = [];
  for (const config of configs) {
    const delivery = adapter.verifyWebhookDelivery(
      headers,
      rawBody,
      configSecrets(config, config.org_id),
    );
    if (delivery.signatureValid) verified.push({ orgId: config.org_id, events: delivery.events });
  }
  if (verified.length === 0) return null;
  const events = verified[0]?.events ?? [];
  const eventResults: ProviderWebhookResult["eventResults"] = [];
  let firstFailure: Error | null = null;
  for (const event of events) {
    let unresolved: ProviderWebhookResult["eventResults"][number] | null = null;
    let handled: ProviderWebhookResult["eventResults"][number] | null = null;
    let failure: ProviderWebhookResult["eventResults"][number] | null = null;
    for (const candidate of verified) {
      let outcome: WebhookEventOutcome;
      try {
        outcome = await runInSpan(
          "payment_webhook.event",
          {
            [ATTR_SURFACE]: "payment_webhooks",
            [ATTR_KIND]: provider,
            [ATTR_ORG_ID]: candidate.orgId,
            "openbooks.external_ref": event.externalRef,
            "openbooks.webhook_status": event.status,
          },
          () =>
            withOrg(candidate.orgId, async () => {
              // Settlement reads and retains the primary book before posting a
              // receipt. Hold the shared setup fence across the event so its
              // book/config reads agree with the posting kernel's transaction.
              await lockLedgerSetupFence(db, candidate.orgId, "shared");
              return processWebhookEvent(candidate.orgId, provider, event);
            }),
        );
      } catch (error) {
        // A tenant transaction failure rolls back only this event. Keep going
        // so a poison event cannot starve later collections in the delivery;
        // the aggregate error below still makes the provider retry honestly.
        logPaymentWebhookEventFailure(provider, candidate.orgId, event, error);
        firstFailure ??=
          error instanceof Error
            ? error
            : new PaymentAcceptanceError("payment webhook event processing failed");
        failure ??= {
          externalRef: event.externalRef,
          orgId: candidate.orgId,
          status: "processing_failed",
        };
        // A lookup can fail before this tenant resolves an attempt. Give later
        // verifying tenants their normal chance to claim the event; the saved
        // failure still forces a retry because this tenant was indeterminate.
        continue;
      }
      // A discrepancy is returned, rather than thrown inside withOrg, so its
      // attempt marker and audit row commit before this event is reported as
      // failed. Later events still run in independent tenant transactions.
      if (typeof outcome !== "string") {
        firstFailure ??= outcome.discrepancy;
        failure ??= {
          externalRef: event.externalRef,
          orgId: candidate.orgId,
          status: "processing_failed",
        };
        unresolved = null;
        break;
      }
      const status = outcome;
      const result = { externalRef: event.externalRef, orgId: candidate.orgId, status };
      if (status !== "unknown_attempt") {
        handled = result;
        unresolved = null;
        break;
      }
      unresolved ??= result;
    }
    const eventResult = failure ?? handled ?? unresolved;
    if (eventResult) eventResults.push(eventResult);
  }
  const primary =
    eventResults.find((result) => result.status !== "unknown_attempt") ?? eventResults[0];
  const result: ProviderWebhookResult = {
    signatureValid: true,
    orgId: primary?.orgId ?? verified[0]!.orgId,
    status:
      firstFailure !== null
        ? "processing_failed"
        : eventResults.length === 0
          ? "unhandled"
          : eventResults.length === 1
            ? primary!.status
            : "processed",
    eventResults,
  };
  if (firstFailure !== null) throw new PaymentWebhookBatchError(result, firstFailure);
  return result;
}

/**
 * Which attempt states each event kind may claim. Terminal states are never
 * claimable, so redelivered or concurrent deliveries dedupe instead of
 * re-running settlement; refunds may land on a settled attempt (post-receipt
 * clawback note) or an initiated one (refund beat the settlement event).
 *
 * The status column is constrained to initiated/succeeded/failed/cancelled/
 * refunded, so a succeeded claim moves straight to 'succeeded' before
 * settlement runs — exactly one delivery wins the update, and a failed
 * settlement rolls back to 'initiated' below.
 *
 * One deliberate exception lives at the claim site (not here, because it is
 * conditional on the journal marker): a succeeded event may re-claim an
 * attempt stuck at succeeded whose settlement never completed
 * (journal_entry_id is null) — the crash-between-claim-and-finalize window.
 * Without it, collected money would strand as unbookable forever and the
 * customer's retry would mint a second charge.
 *
 * The same exception covers succeeded-after-refund: a chargeback that beat
 * its settlement event claims the initiated attempt as refunded, and the
 * real settlement event landing afterwards must still book the receipt
 * (the clawback audit note stays for the controller to reverse against).
 * Deduping it instead strands a collected payment with no journal, no
 * recovery path, and a 200 to the provider.
 */
export const CLAIMABLE_FROM: Record<WebhookEvent["status"], string[]> = {
  succeeded: ["initiated"],
  processing: ["initiated"],
  failed: ["initiated"],
  cancelled: ["initiated"],
  // A second return for one attempt (a partial after a partial, a dispute
  // after a refund) must still claim: redeliveries converge on the
  // per-event automation record instead of posting twice, so widening the
  // claim here cannot double-post.
  refunded: ["succeeded", "initiated", "refunded"],
  disputed: ["succeeded", "initiated", "refunded"],
};

/**
 * Consume a parked refund-first marker for a succeeded event's intent and
 * return its normalized refund detail. The conditional update is the
 * once-only lock; concurrent consumers serialize and the loser sees no row.
 * Markers parked before automation existed carry only the raw payload, so
 * the replay parks for review instead of posting an amount nobody
 * normalized — fail closed across the upgrade window.
 */
export async function consumePendingClawback(
  orgId: string,
  provider: AcceptanceProvider,
  intentRef: string,
  attemptId: string,
): Promise<{
  providerEventId: string;
  refundedAmount: string | null;
  refundAmountBasis: "incremental" | "cumulative";
  providerRefundId: string | null;
  refundCurrency: string | null;
  providerRef: string | null;
  dispute: {
    id: string;
    amount: string;
    currency: string;
    reason?: string | null;
    state: "opened" | "won" | "lost";
  } | null;
  status: string;
} | null> {
  const consumed = await db.execute<{
    event_payload: Record<string, unknown> | null;
    event_status: string;
  }>(
    sql`
    update payment_pending_clawbacks
       set consumed_at = now(), consumed_attempt_id = ${attemptId}
     where org_id = ${orgId} and provider = ${provider} and intent_ref = ${intentRef}
       and consumed_at is null
     returning event_payload, event_status
  `,
    "objects",
  );
  const row = consumed[0];
  if (!row) return null;
  const detail = ((row.event_payload ?? {}).normalized ?? {}) as Record<string, unknown>;
  return {
    providerEventId:
      typeof detail.providerEventId === "string" && detail.providerEventId !== ""
        ? detail.providerEventId
        : `${provider}:${intentRef}:parked`,
    refundedAmount: typeof detail.refundedAmount === "string" ? detail.refundedAmount : null,
    refundAmountBasis:
      detail.refundAmountBasis === "cumulative" ||
      (detail.refundAmountBasis === undefined && provider === "stripe")
        ? "cumulative"
        : "incremental",
    providerRefundId: typeof detail.providerRefundId === "string" ? detail.providerRefundId : null,
    refundCurrency: typeof detail.refundCurrency === "string" ? detail.refundCurrency : null,
    providerRef: typeof detail.providerRef === "string" ? detail.providerRef : null,
    dispute: (detail.dispute ?? null) as {
      id: string;
      amount: string;
      currency: string;
      reason?: string | null;
      state: "opened" | "won" | "lost";
    } | null,
    status: row.event_status,
  };
}

export async function processWebhookEvent(
  orgId: string,
  provider: AcceptanceProvider,
  event: WebhookEvent,
): Promise<WebhookEventOutcome> {
  // Card updater refreshes never touch payment attempts: the autopay engine
  // claims them first by stored method id, and an unknown method stays
  // unknown (a 200 the provider may retry) rather than mis-settling money.
  // A recurring-contract notice carrying card detail is either an update to
  // an already-stored card or the first notice for a new setup: the refresh
  // runs first, and only an unknown method falls through to the setup claim
  // below instead of stranding a new method as unknown.
  if (event.cardUpdaterRefresh) {
    const { recordCardUpdaterEvent } = await import("./autopay-methods.ts");
    const outcome = await recordCardUpdaterEvent(orgId, provider, event.cardUpdaterRefresh);
    if (outcome !== "unknown_method" || !event.setupCompleted) return outcome;
  }
  // Stored-method setups never touch payment attempts: the autopay engine
  // claims them first, and an unclaimed one stays unknown (a 200 the
  // provider retries) rather than mis-settling as a payment.
  if (event.setupCompleted) {
    const { recordProviderSetupMethod } = await import("./autopay-methods.ts");
    return await recordProviderSetupMethod(orgId, provider, event);
  }
  // Resolve the attempt: by provider object id, by its alternate id (e.g.
  // GoCardless billing request vs payment id), by an intent id persisted from
  // the completed session, then by link token. Absent refs are bound as real
  // NULL params — an undefined in a drizzle template renders as nothing, which
  // would tear the SQL apart.
  const alternateRef = event.alternateExternalRef ?? null;
  const intentRef = event.intentRef ?? null;
  type ResolvedAttempt = {
    id: string;
    link_id: string;
    status: string;
    amount: string;
    surcharge_amount: string;
    currency: string;
  };
  let attempt = await db.execute<ResolvedAttempt>(sql`
    select a.id, a.link_id, a.status,
           coalesce(a.amount, l.amount) as amount,
           coalesce(a.surcharge_amount, l.surcharge_amount, 0) as surcharge_amount,
           l.currency
      from payment_attempts a
      join payment_links l on l.id = a.link_id and l.org_id = a.org_id
     where a.org_id = ${orgId} and a.provider = ${provider}
       and (a.external_ref = ${event.externalRef}
            or (${alternateRef}::text is not null
                and a.external_ref = ${alternateRef})
            or (${intentRef}::text is not null
                and a.event_payload->>'paymentIntent' = ${intentRef}))
     order by a.created_at desc limit 1
  `);
  if (!attempt.rows[0] && event.linkToken) {
    attempt = await db.execute<ResolvedAttempt>(sql`
      select a.id, a.link_id, a.status,
             coalesce(a.amount, l.amount) as amount,
             coalesce(a.surcharge_amount, l.surcharge_amount, 0) as surcharge_amount,
             l.currency
        from payment_attempts a
        join payment_links l on l.id = a.link_id and l.org_id = a.org_id
       where a.org_id = ${orgId} and a.provider = ${provider}
         and l.token_hash = ${paymentLinkTokenHash(event.linkToken)}
         and a.status = 'initiated'
       order by a.created_at desc limit 1
    `);
  }
  const found = attempt.rows[0];
  if (event.refundObservation) {
    if (!found) return "unknown_attempt";
    const payload =
      isJsonRecord(event.raw.data) && isJsonRecord(event.raw.data.object)
        ? event.raw.data.object
        : {};
    await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_attempts', ${found.id}, 'update',
        ${JSON.stringify({ mode: "provider_refund_observation", provider, providerEventId: event.providerEventId ?? null, refundId: payload.id ?? null, status: payload.status ?? null })}::jsonb, null)`);
    return "refunded_noted";
  }
  if (!found) {
    // Automatic collection settles against collection attempts, not payment
    // attempts: offer async-debit and off-session results to autopay before
    // the refund-first logic below. Disputed events ride along: autopay
    // records the dispute against its collection, and a null outcome falls
    // through to the payment automation below.
    if (
      event.status === "succeeded" ||
      event.status === "processing" ||
      event.status === "failed" ||
      event.status === "refunded" ||
      event.status === "disputed"
    ) {
      const { settleCollectionAttemptEvent } = await import("./autopay-settlement.ts");
      const collectionOutcome = await settleCollectionAttemptEvent(orgId, provider, event);
      if (collectionOutcome !== null) return collectionOutcome;
    }
    // Refund-first: a return that beat its settlement event cannot resolve —
    // the intent id is only persisted onto the attempt from the completed
    // session — so park it as a pending-clawback marker instead of dropping it
    // as unknown_attempt (which 200s and loses the return forever). The later
    // succeeded event consumes the marker, settles, and replays the parked
    // return through refund/dispute automation. Redeliveries upsert
    // idempotently but never re-arm a consumed marker (only
    // last_seen_at/payload refresh), so one return posts exactly once.
    // Normal-order returns never land here because they resolve above. Events
    // without an intent key have nothing to park under and stay unknown.
    if ((event.status === "refunded" || event.status === "disputed") && intentRef) {
      // The normalized envelope replays after settlement; the raw body stays
      // for forensics. Markers parked before automation existed carry no
      // envelope, and their replay parks for review instead of auto-posting.
      const markerStatus = event.status === "disputed" ? "disputed" : "refunded";
      await db.execute(sql`
        insert into payment_pending_clawbacks
          (org_id, provider, intent_ref, event_status, event_payload, last_seen_at)
        values (${orgId}, ${provider}, ${intentRef}, ${markerStatus},
                ${JSON.stringify({
                  externalRef: event.externalRef,
                  normalized: {
                    providerEventId: event.providerEventId ?? null,
                    refundedAmount: event.refundedAmount ?? null,
                    refundAmountBasis: event.refundAmountBasis ?? "incremental",
                    providerRefundId: event.providerRefundId ?? null,
                    refundCurrency: event.refundCurrency ?? null,
                    providerRef: event.disputeDetail?.id ?? event.externalRef,
                    dispute: event.disputeDetail ?? null,
                  },
                  raw: event.raw ?? null,
                })}::jsonb, now())
        on conflict (org_id, provider, intent_ref)
        do update set event_status = excluded.event_status,
          event_payload = excluded.event_payload,
          last_seen_at = now()
      `);
      return "pending_clawback";
    }
    return "unknown_attempt";
  }

  await lockPaymentAttempt(orgId, found.id);
  if (event.status === "succeeded") {
    const hasPaidAmount = event.paidAmount != null;
    const hasPaidCurrency = event.paidCurrency != null;
    const expectedAmount = add(found.amount, found.surcharge_amount);
    const expectedCurrency = found.currency.toUpperCase();
    const reportedCurrency = event.paidCurrency?.toUpperCase() ?? null;
    // Stripe and Adyen success payloads always carry both values. GoCardless
    // payment lifecycle webhooks carry neither, but must still be checked if a
    // future/provider-expanded payload supplies either value.
    if (
      hasPaidAmount !== hasPaidCurrency ||
      (provider !== "gocardless" && (!hasPaidAmount || !hasPaidCurrency))
    ) {
      return recordSettlementDiscrepancy(
        orgId,
        found.id,
        {
          reason: "missing_settlement_evidence",
          provider,
          externalRef: event.externalRef,
          reportedAmount: event.paidAmount ?? null,
          reportedCurrency,
          expectedAmount,
          expectedCurrency,
        },
        `${provider} settlement did not report both paid amount and currency`,
      );
    }
    if (hasPaidAmount && hasPaidCurrency) {
      if (cmp(event.paidAmount!, expectedAmount) !== 0 || reportedCurrency !== expectedCurrency) {
        return recordSettlementDiscrepancy(
          orgId,
          found.id,
          {
            reason: "amount_currency_mismatch",
            provider,
            externalRef: event.externalRef,
            reportedAmount: event.paidAmount!,
            reportedCurrency,
            expectedAmount,
            expectedCurrency,
          },
          `${provider} reported ${event.paidAmount} ${reportedCurrency}, but checkout expected ${expectedAmount} ${expectedCurrency}`,
        );
      }
    }
  }

  // Evidence merged into every claim: the intent id lets later refund/dispute
  // events match this attempt even though checkout stored the session id.
  const merge: Record<string, unknown> = { webhook: true, status: event.status };
  if (event.dispute) merge.dispute = true;
  if (event.intentRef) merge.paymentIntent = event.intentRef;
  if (event.paidAmount != null) merge.paidAmount = event.paidAmount;
  if (event.paidCurrency != null) merge.paidCurrency = event.paidCurrency.toUpperCase();
  // 'processing' has no column value (see CLAIMABLE_FROM): the row stays
  // initiated and the payload marker records the in-flight provider state.
  // 'disputed' persists as refunded: attempts track collection state, and the
  // dispute lifecycle lives in payment_disputes — the attempt CHECK admits no
  // dispute state.
  const rowStatus =
    event.status === "processing"
      ? "initiated"
      : event.status === "disputed"
        ? "refunded"
        : event.status;

  // Atomic claim: exactly one concurrent delivery transitions the attempt out
  // of its current state; every later delivery sees a non-claimable row and
  // dedupes instead of settling again.
  //
  // Crash recovery: claim and settlement share one transaction, so a process
  // death mid-settlement rolls the claim back — but a claim that committed
  // before an earlier crash (or a finalize that never ran after an external
  // post) leaves the attempt at succeeded with journal_entry_id null. Such a
  // row is reclaimable by another succeeded event: settleAttempt resumes
  // exactly-once (reusing any reserved receipt draft, minting one when the
  // crash preceded the reservation). A fully settled attempt — journal entry
  // written — stays terminal. The same reclaim covers a succeeded event
  // landing after a chargeback that beat it (refunded, journal unset): the
  // collection is still real money and must book, with the clawback note
  // left for the controller. The conditional update is also the resume lock:
  // concurrent resumers serialize on the row lock for the whole settlement,
  // and the loser rechecks journal_entry_id after the winner commits.
  const claimableFrom = CLAIMABLE_FROM[event.status];
  let claim: { rows: { id: string }[] };
  try {
    claim = await db.execute<{ id: string }>(sql`
      update payment_attempts
         set status = ${rowStatus},
             external_ref = ${event.externalRef},
             event_payload = coalesce(event_payload, '{}'::jsonb) || ${JSON.stringify(merge)}::jsonb,
             updated_at = now()
       where id = ${found.id} and org_id = ${orgId}
         and (status in (${sql.join(
           claimableFrom.map((s) => sql`${s}`),
           sql`, `,
         )})
              ${event.status === "succeeded" ? sql`or (status in ('succeeded', 'refunded') and journal_entry_id is null)` : sql``})
       returning id
    `);
  } catch (err) {
    // Re-keying to the provider object id hit an already-processed delivery.
    if ((err as { code?: string }).code === "23505") return "duplicate";
    throw err;
  }
  if (!claim.rows[0]) {
    // Crash-after-settle with a parked return: the receipt is already booked
    // (journal set, so this delivery correctly dedupes) but the parked
    // return never replayed. Replay it now so the return posts instead of
    // stranding.
    if (event.status === "succeeded" && intentRef) {
      const parked = await consumePendingClawback(orgId, provider, intentRef, found.id);
      if (parked) await replayParkedReturn(orgId, provider, found.id, parked);
    }
    return "duplicate";
  }

  if (event.status === "succeeded") {
    // A return that beat this settlement parked a marker on the intent. Peek
    // before settling (the replay needs the receipt); consume and replay
    // only after settlement commits, so a settlement failure keeps the
    // marker for the retry instead of losing the return.
    const parkedBefore = intentRef ? await peekPendingClawback(orgId, provider, intentRef) : null;
    try {
      const outcome = await settleAttempt(orgId, found.id);
      if (typeof outcome !== "string") return outcome;
      if (parkedBefore) {
        const parked = await consumePendingClawback(orgId, provider, intentRef!, found.id);
        if (parked) await replayParkedReturn(orgId, provider, found.id, parked);
      }
      return outcome === "gated" ? "awaiting_approval" : "settled";
    } catch (err) {
      // Roll the claim back so the next delivery retries settlement. The
      // reserved receipt document is kept on the attempt: resume reuses that
      // exact draft rather than minting another one per retry.
      await db.execute(sql`
        update payment_attempts set status = 'initiated', updated_at = now()
         where id = ${found.id} and org_id = ${orgId} and status = 'succeeded' and journal_entry_id is null
      `);
      throw err;
    }
  }
  if (event.status === "refunded" || event.status === "disputed") {
    // A marker parked by an earlier out-of-order delivery is superseded: the
    // automation below records the return, so close the marker silently
    // after it does.
    const outcome = await runReturnAutomation(orgId, provider, found.id, event);
    if (intentRef) {
      await db.execute(sql`
        update payment_pending_clawbacks
           set consumed_at = now(), consumed_attempt_id = ${found.id}
         where org_id = ${orgId} and provider = ${provider} and intent_ref = ${intentRef}
           and consumed_at is null
      `);
    }
    return outcome;
  }
  return event.status;
}

/** Peek a parked marker without consuming it. */
export async function peekPendingClawback(
  orgId: string,
  provider: AcceptanceProvider,
  intentRef: string,
): Promise<boolean> {
  const row = (
    await db.execute<{ id: string }>(
      sql`
    select id from payment_pending_clawbacks
     where org_id = ${orgId} and provider = ${provider} and intent_ref = ${intentRef}
       and consumed_at is null
  `,
      "objects",
    )
  )[0];
  return !!row;
}

/**
 * Provider delivery id for automation idempotency. Providers that send none
 * (bank-debit returns) key on the payment object instead: one payment is
 * returned once, so the key stays unique per return.
 */
export function returnEventId(provider: AcceptanceProvider, event: WebhookEvent): string {
  if (event.providerEventId) return event.providerEventId;
  return `${provider}:${event.intentRef ?? event.externalRef}:${event.status}`;
}

/** Route one return event through refund/dispute automation. */
export async function runReturnAutomation(
  orgId: string,
  provider: AcceptanceProvider,
  attemptId: string,
  event: WebhookEvent,
): Promise<string> {
  const { processProviderRefundEvent, processProviderDisputeEvent } =
    await import("./psp-refund-automation.ts");
  const prefix = event.status === "disputed" ? "disputed" : "refunded";
  if (event.status === "disputed" && event.disputeDetail) {
    const outcome = await processProviderDisputeEvent(orgId, {
      provider,
      providerEventId: returnEventId(provider, event),
      attemptId,
      dispute: event.disputeDetail,
      raw: event.raw,
    });
    return `${prefix}_${outcome.status}`;
  }
  const outcome = await processProviderRefundEvent(orgId, {
    provider,
    providerEventId: returnEventId(provider, event),
    attemptId,
    refundedAmount: event.refundedAmount ?? null,
    refundAmountBasis: event.refundAmountBasis,
    providerRefundId: event.providerRefundId,
    refundCurrency: event.refundCurrency ?? null,
    providerRef: event.disputeDetail?.id ?? event.externalRef,
    raw: event.raw,
  });
  return `${prefix}_${outcome.status}`;
}

/** Replay a refund-first marker after its payment lands. */
export async function replayParkedReturn(
  orgId: string,
  provider: AcceptanceProvider,
  attemptId: string,
  parked: {
    providerEventId: string;
    refundedAmount: string | null;
    refundAmountBasis: "incremental" | "cumulative";
    providerRefundId: string | null;
    refundCurrency: string | null;
    providerRef: string | null;
    dispute: {
      id: string;
      amount: string;
      currency: string;
      reason?: string | null;
      state: "opened" | "won" | "lost";
    } | null;
    status: string;
  },
): Promise<void> {
  const { processProviderRefundEvent, processProviderDisputeEvent } =
    await import("./psp-refund-automation.ts");
  if (parked.status === "disputed" && parked.dispute) {
    await processProviderDisputeEvent(orgId, {
      provider,
      providerEventId: parked.providerEventId,
      attemptId,
      dispute: parked.dispute,
    });
    return;
  }
  await processProviderRefundEvent(orgId, {
    provider,
    providerEventId: parked.providerEventId,
    attemptId,
    refundedAmount: parked.refundedAmount,
    refundAmountBasis: parked.refundAmountBasis,
    providerRefundId: parked.providerRefundId,
    refundCurrency: parked.refundCurrency,
    providerRef: parked.providerRef,
  });
}
