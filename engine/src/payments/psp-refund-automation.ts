import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import { PSP_AUTOMATION_SYSTEM_ACTOR_ID, type PspAutomationPolicy, type ProviderRefundEvent, type RefundAutomationOutcome, PspAutomationError, loadAutomationContext } from "./psp-automation-context.ts";
import { insertDisputeRow, transitionDisputeRow, disputeRow, parkForReview, type ProviderDisputeEvent, type PendingAction, findDisputeByRef, historyHasEvent, pendingActionOf, parkDisputeForReview, asDocIds } from "./psp-automation-disputes.ts";
import { postedAgainstReceipt, voidAndReissueRemainder, refundAgainstCredit, openCreditCovering, setAttemptRefunded, openDisputeHold } from "./psp-automation-postings.ts";
import { transitionDisputeOutcome, eventFee } from "./psp-automation-dispute-outcomes.ts";

/**
 * Automatic provider refund/dispute accounting.
 *
 * A provider refund or chargeback used to land as an audit note while the
 * receipt stayed posted and the invoice stayed settled — the controller
 * hand-reversed every return. This module posts the accounting instead,
 * driven by the normalized webhook event:
 *
 * - Full refund: reverse the receipt through reversePaymentForReturn (the
 *   invoice reopens by the void machinery, never by editing applications).
 * - Partial refund: reverse the receipt and re-post the remainder against
 *   the invoice — or, when the operator issued a credit memo first, settle
 *   the refund against that credit. applications rows stay positive-only;
 *   the void plus re-receipt is the partial primitive.
 * - Dispute opened: reverse the receipt (the invoice reopens) and re-post
 *   the funds unapplied into the disputed-funds clearing account, so the
 *   hold is visible while the outcome is unknown.
 * - Dispute won: release the hold and re-collect against the invoice.
 * - Dispute lost: settle the invoice from the held funds and write the loss
 *   and the provider fee off to their expense accounts.
 *
 * Every event is recorded in payment_disputes, idempotent on
 * (org, provider, provider event id): a redelivered event converges instead
 * of posting twice, and a crashed run resumes because rows start life as
 * pending_review and only reach a terminal status after posting.
 * Anything the automation cannot post (review policy, missing accounts or
 * evidence, an approval gate, an over-refund) parks as pending_review with
 * the reason and the remedy, never as a 500 and never silently.
 */

/** The nil-UUID system actor every payment automation posts under — the same
 *  convention as PAYMENT_RUN_SYSTEM_ACTOR_ID,aliased so refund/dispute audit
 *  rows name their own actor without minting a second identity. */

/**
 * Run one provider refund event to posted accounting (or to the review
 * queue). The dispute row is created first as pending_review, so a crash
 * between the insert and the posting leaves a resumable record instead of
 * silent money movement — and a redelivery converges on it.
 */
export async function processProviderRefundEvent(
  orgId: string,
  event: ProviderRefundEvent,
  opts: { forcePolicy?: PspAutomationPolicy } = {},
): Promise<RefundAutomationOutcome> {
  return withOrg(orgId, async () => {
    if (!(await orgFeatureEnabled(orgId, "onlinePayments"))) {
      throw new PspAutomationError(
        "online payments are not enabled for this organization; enable them in Company Settings → Features",
      );
    }
    const ctx = await loadAutomationContext(orgId, event.attemptId);
    const receiptTotal = ctx.receipt?.status === "posted" ? ctx.receipt.total : null;
    const { id: disputeId, created } = await insertDisputeRow(orgId, {
      provider: event.provider,
      providerEventId: event.providerEventId,
      kind: "refund",
      status: "pending_review",
      attemptId: event.attemptId,
      receiptDocumentId: ctx.receipt?.id ?? null,
      invoiceDocumentId: ctx.invoice.id,
      currency: event.refundCurrency ?? ctx.link.currency,
      amount: event.refundedAmount ?? "0",
      feeAmount: "0",
      providerRef: event.providerRef,
      reason: null,
    });
    if (!created) {
      const existing = await disputeRow(orgId, disputeId);
      const docs = Array.isArray(existing.documents_posted) ? existing.documents_posted : [];
      // Only a terminal row with posted documents is a duplicate: anything
      // else is a crashed or parked run the redelivery must resume.
      if ((existing.status === "posted" || existing.status === "rejected") && docs.length > 0) {
        return { status: "duplicate", disputeId };
      }
      if (existing.status === "pending_review" && docs.length === 0) {
        // Parked before posting (review policy or missing evidence): resume
        // below with fresh state instead of posting twice.
      } else if (docs.length > 0) {
        return { status: "duplicate", disputeId };
      }
    }
    if ((opts.forcePolicy ?? ctx.policy) === "review") {
      return parkForReview(
        orgId,
        disputeId,
        `refund ${event.providerRef ?? event.providerEventId} for receipt ${ctx.receipt?.document_number ?? "(none)"} needs approval before posting`,
      );
    }
    if (!ctx.receipt || ctx.receipt.status !== "posted") {
      return parkForReview(
        orgId,
        disputeId,
        `refund arrived for attempt ${ctx.attempt.external_ref} with no posted receipt; approve once the receipt posts`,
      );
    }
    if (event.refundedAmount == null) {
      return parkForReview(
        orgId,
        disputeId,
        `provider did not report the refunded amount for ${event.providerRef ?? event.providerEventId}; approve with the amount once confirmed`,
      );
    }
    const refundCurrency = (event.refundCurrency ?? ctx.receipt.currency).toUpperCase();
    if (refundCurrency !== ctx.receipt.currency.toUpperCase()) {
      return parkForReview(
        orgId,
        disputeId,
        `refund reported in ${refundCurrency} against a ${ctx.receipt.currency} receipt; approve once the converted amount is confirmed`,
      );
    }
    const already = await postedAgainstReceipt(orgId, ctx.receipt.id);
    if (already + toUnits(event.refundedAmount) > toUnits(receiptTotal!)) {
      return parkForReview(
        orgId,
        disputeId,
        `refunds of ${fromUnits(already)} already posted against receipt ${ctx.receipt.document_number} total ${receiptTotal}; approve the extra ${event.refundedAmount} once confirmed as a second return`,
      );
    }
    const reason = `Provider refund ${event.providerRef ?? event.providerEventId} for ${ctx.receipt.document_number}`;
    if (toUnits(event.refundedAmount) >= toUnits(receiptTotal!)) {
      const reversalId = await reversePaymentForReturn(
        ctx.receipt.id,
        orgId,
        reason,
        PSP_AUTOMATION_SYSTEM_ACTOR_ID,
      );
      await setAttemptRefunded(orgId, ctx.attempt.id, null);
      await transitionDisputeRow(orgId, disputeId, "posted", [reversalId], null);
      return { status: "posted", disputeId, documents: [reversalId] };
    }
    const credit = await openCreditCovering(orgId, ctx.link.party_id, ctx.receipt.currency, event.refundedAmount);
    if (credit) {
      const { refundId, gated } = await refundAgainstCredit(
        orgId,
        ctx,
        credit.documentId,
        credit.lineId,
        event.refundedAmount,
      );
      if (gated) {
        return parkForReview(
          orgId,
          disputeId,
          `refund receipt ${refundId} needs approval before it can settle against the credit memo`,
        );
      }
      await setAttemptRefunded(orgId, ctx.attempt.id, null);
      await transitionDisputeRow(orgId, disputeId, "posted", [refundId], `settled against credit memo ${credit.documentId}`);
      return { status: "posted", disputeId, documents: [refundId] };
    }
    const { reversalId, remainderId, gated } = await voidAndReissueRemainder(
      orgId,
      ctx,
      receiptTotal!,
      event.refundedAmount,
      reason,
    );
    if (gated) {
      return parkForReview(
        orgId,
        disputeId,
        `replacement receipt ${remainderId} for the unrefunded remainder needs approval before the original receipt can reverse`,
      );
    }
    // The attempt now points at the remainder receipt, still collected: a
    // later refund for the rest claims from succeeded and reverses that.
    if (remainderId) {
      const relinked = (await db.execute(sql`
        update payment_attempts set status = 'succeeded', payment_document_id = ${remainderId}, updated_at = now()
         where id = ${ctx.attempt.id} and org_id = ${orgId}
      `));
      if ((relinked.rowCount ?? 0) !== 1) {
        throw new PspAutomationError("payment attempt could not be pointed at its remainder receipt");
      }
    } else {
      await setAttemptRefunded(orgId, ctx.attempt.id, null);
    }
    await transitionDisputeRow(
      orgId,
      disputeId,
      "posted",
      [reversalId, ...(remainderId ? [remainderId] : [])],
      null,
    );
    return { status: "posted", disputeId, documents: [reversalId, ...(remainderId ? [remainderId] : [])] };
  });
}

/**
 * Run one provider dispute event (opened, won, lost) to posted accounting.
 * Lifecycle rows are keyed by the provider dispute id: a won or lost event
 * finds its opened row and transitions it, so the hold, the release and the
 * write-off read as one story with every document attached.
 */
export async function processProviderDisputeEvent(
  orgId: string,
  event: ProviderDisputeEvent,
  opts: { forcePolicy?: PspAutomationPolicy } = {},
): Promise<RefundAutomationOutcome> {
  return withOrg(orgId, async () => {
    if (!(await orgFeatureEnabled(orgId, "onlinePayments"))) {
      throw new PspAutomationError(
        "online payments are not enabled for this organization; enable them in Company Settings → Features",
      );
    }
    const { dispute } = event;
    if (!dispute.id.trim()) {
      // No dispute identity to age a lifecycle on: record this event on its
      // own key and park it, so a later event for the same return cannot
      // converge onto the wrong dispute.
      const { id } = await insertDisputeRow(orgId, {
        provider: event.provider,
        providerEventId: event.providerEventId,
        kind: "dispute",
        status: "pending_review",
        attemptId: event.attemptId,
        receiptDocumentId: null,
        invoiceDocumentId: null,
        currency: dispute.currency || "XXX",
        amount: dispute.amount || "0",
        feeAmount: "0",
        providerRef: event.providerEventId,
        reason: null,
      });
      return parkDisputeForReview(orgId, id, "dispute-opened",
        { providerEventId: event.providerEventId, dispute },
        `dispute arrived without a provider dispute id; approve once the dispute is identified`);
    }
    const existing = await findDisputeByRef(orgId, event.provider, dispute.id);
    if (existing && historyHasEvent(existing.status_history, event.providerEventId)) {
      return { status: "duplicate", disputeId: existing.id };
    }
    if (existing && (existing.status === "won" || existing.status === "lost" || existing.status === "rejected")) {
      await transitionDisputeRow(orgId, existing.id, existing.status, asDocIds(existing.documents_posted), `duplicate ${event.providerEventId} noted`);
      return { status: "duplicate", disputeId: existing.id };
    }
    const ctx = event.attemptId ? await loadAutomationContext(orgId, event.attemptId) : null;
    if (ctx && (opts.forcePolicy ?? ctx.policy) === "review") {
      const row = existing ?? (await insertDisputeRow(orgId, {
        provider: event.provider,
        providerEventId: event.providerEventId,
        kind: "dispute",
        status: "pending_review",
        attemptId: event.attemptId,
        receiptDocumentId: ctx.receipt?.id ?? null,
        invoiceDocumentId: ctx.invoice.id,
        currency: dispute.currency,
        amount: dispute.amount,
        feeAmount: "0",
        providerRef: dispute.id,
        reason: null,
      }));
      return parkDisputeForReview(
        orgId,
        row.id,
        `dispute-${dispute.state}` as PendingAction,
        { providerEventId: event.providerEventId, dispute },
        `dispute ${dispute.id} (${dispute.state}) needs approval before posting`,
      );
    }
    if (dispute.state === "opened") {
      if (!ctx || !ctx.receipt || ctx.receipt.status !== "posted") {
        const row = existing ?? (await insertDisputeRow(orgId, {
          provider: event.provider,
          providerEventId: event.providerEventId,
          kind: "dispute",
          status: "pending_review",
          attemptId: event.attemptId,
          receiptDocumentId: ctx?.receipt?.id ?? null,
          invoiceDocumentId: ctx?.invoice.id ?? null,
          currency: dispute.currency,
          amount: dispute.amount,
          feeAmount: "0",
          providerRef: dispute.id,
          reason: null,
        }));
        return parkDisputeForReview(orgId, row.id, "dispute-opened",
          { providerEventId: event.providerEventId, dispute },
          `dispute ${dispute.id} arrived with no posted receipt; approve once the receipt posts`);
      }
      if (dispute.currency.toUpperCase() !== ctx.receipt.currency.toUpperCase()) {
        const row = existing ?? (await insertDisputeRow(orgId, {
          provider: event.provider, providerEventId: event.providerEventId, kind: "dispute",
          status: "pending_review", attemptId: event.attemptId, receiptDocumentId: ctx.receipt.id,
          invoiceDocumentId: ctx.invoice.id, currency: dispute.currency, amount: dispute.amount,
          feeAmount: "0", providerRef: dispute.id, reason: null,
        }));
        return parkDisputeForReview(orgId, row.id, "dispute-opened",
          { providerEventId: event.providerEventId, dispute },
          `dispute ${dispute.id} in ${dispute.currency} against a ${ctx.receipt.currency} receipt; approve once the converted amount is confirmed`);
      }
      if (toUnits(dispute.amount) > toUnits(ctx.receipt.total)) {
        const row = existing ?? (await insertDisputeRow(orgId, {
          provider: event.provider, providerEventId: event.providerEventId, kind: "dispute",
          status: "pending_review", attemptId: event.attemptId, receiptDocumentId: ctx.receipt.id,
          invoiceDocumentId: ctx.invoice.id, currency: dispute.currency, amount: dispute.amount,
          feeAmount: "0", providerRef: dispute.id, reason: null,
        }));
        return parkDisputeForReview(orgId, row.id, "dispute-opened",
          { providerEventId: event.providerEventId, dispute },
          `dispute ${dispute.id} for ${dispute.amount} exceeds receipt ${ctx.receipt.document_number} total ${ctx.receipt.total}; approve once confirmed`);
      }
      const row = existing ?? (await insertDisputeRow(orgId, {
        provider: event.provider,
        providerEventId: event.providerEventId,
        kind: "dispute",
        status: "pending_review",
        attemptId: event.attemptId,
        receiptDocumentId: ctx.receipt.id,
        invoiceDocumentId: ctx.invoice.id,
        currency: dispute.currency,
        amount: dispute.amount,
        feeAmount: "0",
        providerRef: dispute.id,
        reason: null,
      }));
      let held: { documents: string[]; holdId: string; gated: boolean };
      try {
        held = await openDisputeHold(orgId, ctx, dispute.amount, dispute.id);
      } catch (error) {
        if (error instanceof PspAutomationError) {
          return parkDisputeForReview(orgId, row.id, "dispute-opened",
            { providerEventId: event.providerEventId, dispute }, error.message);
        }
        throw error;
      }
      if (held.gated) {
        return parkDisputeForReview(orgId, row.id, "dispute-opened",
          { providerEventId: event.providerEventId, dispute },
          `replacement receipt for the undisputed remainder needs approval before the dispute hold can post`);
      }
      await setAttemptRefunded(orgId, ctx.attempt.id, held.holdId);
      await transitionDisputeRow(orgId, row.id, "opened", held.documents, null);
      return { status: "posted", disputeId: row.id, documents: held.documents };
    }
    return transitionDisputeOutcome(orgId, event, existing, ctx);
  });
}

/**
 * Approve a queued refund or dispute: re-runs the automatic path with fresh
 * state. Terminal rows converge instead of posting twice.
 */
export async function approveDisputeReview(
  orgId: string,
  disputeId: string,
  actorId: string,
): Promise<RefundAutomationOutcome> {
  return withOrg(orgId, async () => {
    const row = await disputeRow(orgId, disputeId);
    if (row.status === "posted" || row.status === "won" || row.status === "lost") {
      return { status: "duplicate", disputeId };
    }
    if (row.status === "rejected") {
      throw new PspAutomationError("a rejected review cannot be approved; wait for the provider's next event");
    }
    const action = pendingActionOf(row.status_history) ?? (row.kind === "refund" ? "refund" : "dispute-opened");
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_disputes', ${disputeId}, 'approve',
              ${JSON.stringify({ after: { action } })}::jsonb, ${actorId})
    `);
    if (action === "refund") {
      if (!row.attempt_id) throw new PspAutomationError("review has no payment attempt to resume");
      const event: ProviderRefundEvent = {
        provider: row.provider,
        providerEventId: `${row.provider_event_id}#approved`,
        attemptId: row.attempt_id,
        refundedAmount: row.amount,
        refundCurrency: row.currency,
        providerRef: row.provider_ref,
      };
      // Approval resumes under the automatic path: force the policy by
      // running the posting directly against a same-event key.
      return runApprovedRefund(orgId, disputeId, event);
    }
    const state = action === "dispute-won" ? "won" : action === "dispute-lost" ? "lost" : "opened";
    if (!row.attempt_id && state === "opened") {
      throw new PspAutomationError("review has no payment attempt to resume");
    }
    const event: ProviderDisputeEvent = {
      provider: row.provider,
      providerEventId: `${row.provider_event_id}#approved`,
      attemptId: row.attempt_id,
      dispute: {
        id: row.provider_ref ?? row.provider_event_id,
        amount: row.amount,
        currency: row.currency,
        state: state as "opened" | "won" | "lost",
      },
    };
    void eventFee(event);
    return runApprovedDispute(orgId, disputeId, event);
  });
}

/** Approval re-runs post against the queued row itself (never a new row),
 *  under the automatic path: the operator's approval IS the policy gate. */
async function runApprovedRefund(
  orgId: string,
  disputeId: string,
  event: ProviderRefundEvent,
): Promise<RefundAutomationOutcome> {
  const outcome = await processProviderRefundEvent(
    orgId,
    { ...event, providerEventId: event.providerEventId.replace(/#approved$/, "") },
    { forcePolicy: "automatic" },
  );
  if (outcome.status === "duplicate" || outcome.disputeId !== disputeId) return outcome;
  return outcome;
}

async function runApprovedDispute(
  orgId: string,
  disputeId: string,
  event: ProviderDisputeEvent,
): Promise<RefundAutomationOutcome> {
  const outcome = await processProviderDisputeEvent(
    orgId,
    { ...event, providerEventId: event.providerEventId.replace(/#approved$/, "") },
    { forcePolicy: "automatic" },
  );
  if (outcome.disputeId !== disputeId) return outcome;
  return outcome;
}

/**
 * Reject a queued refund or dispute: no money moves. The provider's next
 * event for the same return creates its own record.
 */
export async function rejectDisputeReview(
  orgId: string,
  disputeId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.trim();
  if (trimmed.length < 5 || trimmed.length > 500) {
    throw new PspAutomationError("rejection reason must be between 5 and 500 characters");
  }
  return withOrg(orgId, async () => {
    const row = await disputeRow(orgId, disputeId);
    if (row.status !== "pending_review") {
      throw new PspAutomationError(`review is ${row.status}; only a queued review can be rejected`);
    }
    await transitionDisputeRow(orgId, disputeId, "rejected", [], trimmed);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_disputes', ${disputeId}, 'reject',
              ${JSON.stringify({ after: { reason: trimmed } })}::jsonb, ${actorId})
    `);
  });
}

/**
 * Replay a refund-first marker after its payment lands: the parked refund
 * posts through the same automation as an in-order event, instead of
 * writing a controller note nobody acts on.
 */
export async function replayParkedRefund(
  orgId: string,
  attemptId: string,
  parked: {
    providerEventId: string;
    refundedAmount: string | null;
    refundCurrency: string | null;
    providerRef: string | null;
    provider: string;
  },
): Promise<RefundAutomationOutcome> {
  return processProviderRefundEvent(orgId, {
    provider: parked.provider,
    providerEventId: parked.providerEventId,
    attemptId,
    refundedAmount: parked.refundedAmount,
    refundCurrency: parked.refundCurrency,
    providerRef: parked.providerRef,
  });
}
