import { lockPaymentAttempt } from "./payment-attempt-lock.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { lockApprovalSubject, requestNativeCommandApproval } from "../platform/approval-routing.ts";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import {
  refundSource,
  refundSourceOf,
  refundDelta,
  postedAttemptRefunds,
} from "./refund-source.ts";
import { returnFinancialStage, withdrawReturnReceipts } from "./psp-return-stages.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import {
  PSP_AUTOMATION_SYSTEM_ACTOR_ID,
  type ProviderRefundEvent,
  type RefundAutomationOutcome,
  PspAutomationError,
  loadAutomationContext,
} from "./psp-automation-context.ts";
import {
  insertDisputeRow,
  transitionDisputeRow,
  disputeRow,
  parkForReview,
  type ProviderDisputeEvent,
  findDisputeByRef,
  historyHasEvent,
  pendingActionOf,
  pendingEventOf,
  parkDisputeForReview,
  asDocIds,
} from "./psp-automation-disputes.ts";
import {
  voidAndReissueRemainder,
  refundAgainstCredit,
  openCreditCovering,
  setAttemptRefunded,
  openDisputeHold,
} from "./psp-automation-postings.ts";
import { transitionDisputeOutcome, eventFee } from "./psp-automation-dispute-outcomes.ts";
import {
  approvedReturnCommand,
  lockReviewAuthority,
  reviewFingerprint,
  reviewHasPendingGates,
  reviewProviderReturn,
  withReviewedReturn,
} from "./psp-return-review.ts";

/**
 * Automatic provider refund/dispute accounting.
 *
 * Normalized provider evidence drives governed return accounting:
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
 * Anything the automation cannot post (missing accounts or
 * evidence, an approval gate, an over-refund) parks as pending_review with
 * the reason and the remedy, never as a 500 and never silently.
 */

/**
 * Run one provider refund event to posted accounting (or to the review
 * queue). The dispute row is created first as pending_review, so a crash
 * between the insert and the posting leaves a resumable record instead of
 * silent money movement — and a redelivery converges on it.
 */
export async function processProviderRefundEvent(
  orgId: string,
  event: ProviderRefundEvent,
): Promise<RefundAutomationOutcome> {
  return withOrg(orgId, async () => {
    if (!(await orgFeatureEnabled(orgId, "onlinePayments"))) {
      throw new PspAutomationError(
        "online payments are not enabled for this organization; enable them in Company Settings → Features",
      );
    }
    await lockPaymentAttempt(orgId, event.attemptId);
    const ctx = await loadAutomationContext(orgId, event.attemptId);
    if (ctx.attempt.provider !== event.provider)
      throw new PspAutomationError("The refund provider does not match its payment attempt.");
    const source = refundSource(event);
    const identity = (
      await db.execute<{ id: string }>(
        sql`
      select id from payment_disputes where org_id = ${orgId} and provider = ${event.provider} and kind = 'refund'
        and (provider_event_id = ${event.providerEventId} or
          (${source.refundId}::text is not null and attempt_id = ${event.attemptId}
            and status_history @> ${JSON.stringify([{ refundSource: { refundId: source.refundId } }])}::jsonb))
       order by created_at limit 1
    `,
        "objects",
      )
    )[0];
    const disputeId =
      identity?.id ??
      (
        await insertDisputeRow(orgId, {
          provider: event.provider,
          providerEventId: event.providerEventId,
          kind: "refund",
          status: "pending_review",
          attemptId: event.attemptId,
          receiptDocumentId: ctx.receipt?.id ?? null,
          invoiceDocumentId: ctx.invoice.id,
          currency: source.currency ?? ctx.link.currency,
          amount: source.amount ?? "0",
          feeAmount: "0",
          providerRef: event.providerRef,
          reason: null,
          refundSource: source,
        })
      ).id;
    const row = await disputeRow(orgId, disputeId);
    if (row.attempt_id !== event.attemptId)
      throw new PspAutomationError(
        "The refund delivery is already associated with another payment attempt.",
      );
    if (row.status === "posted" || row.status === "rejected")
      return { status: "duplicate", disputeId };
    const persistedSource = refundSourceOf(row.status_history);
    if (await reviewHasPendingGates(orgId, disputeId)) {
      if (canonicalJson(persistedSource) !== canonicalJson(source))
        throw new PspAutomationError(
          "The provider refund changed while its Flow gates are pending. Recall that submission and resubmit the confirmed provider evidence.",
        );
      return { status: "pending_review", disputeId };
    }
    const completingEvidence = persistedSource?.amount === null && source.amount !== null;
    if (
      completingEvidence &&
      (persistedSource.basis !== source.basis ||
        (persistedSource.currency !== null && persistedSource.currency !== source.currency))
    ) {
      return parkForReview(
        orgId,
        disputeId,
        "The redelivered refund evidence changes its currency or amount basis; reconcile its provider identity before resuming.",
      );
    }
    const evidence = completingEvidence ? source : (persistedSource ?? source);
    if (!persistedSource || completingEvidence) {
      const recorded = await db.execute<never>(sql`update payment_disputes
        set status_history = status_history || ${JSON.stringify({ at: new Date().toISOString(), refundSource: source })}::jsonb
        where org_id = ${orgId} and id = ${disputeId}`);
      if (recorded.rowCount !== 1)
        throw new PspAutomationError("The refund's provider evidence could not be recorded.");
    }
    const currency = evidence.currency ?? ctx.link.currency;
    const already = await postedAttemptRefunds(orgId, event.attemptId, currency);
    const delta = refundDelta(evidence, already);
    if (delta === null)
      return parkForReview(
        orgId,
        disputeId,
        "The provider did not report a refund amount; redeliver its confirmed refund event before approving this review.",
      );
    if (delta === 0n) {
      await withdrawReturnReceipts(
        orgId,
        disputeId,
        PSP_AUTOMATION_SYSTEM_ACTOR_ID,
        "Refund total already represented by posted provider returns",
      );
      const observed = await db.execute<never>(
        sql`update payment_disputes set amount = '0' where org_id = ${orgId} and id = ${disputeId}`,
      );
      if (observed.rowCount !== 1)
        throw new PspAutomationError("The refund observation could not be recorded.");
      await transitionDisputeRow(
        orgId,
        disputeId,
        "posted",
        [],
        "Provider refund total already represented; no accounting movement",
      );
      return { status: "duplicate", disputeId };
    }
    if (already + delta > toUnits(ctx.attempt.amount))
      return parkForReview(
        orgId,
        disputeId,
        "The confirmed refund total exceeds the original collected amount; reconcile the provider charge before resuming.",
      );
    const refundAmount = fromUnits(delta);
    const amountWritten =
      await db.execute<never>(sql`update payment_disputes set amount = ${refundAmount}
      where org_id = ${orgId} and id = ${disputeId} and status = 'pending_review'`);
    if (amountWritten.rowCount !== 1)
      throw new PspAutomationError(
        "The refund review changed before its amount could be recorded.",
      );
    const receipt = ctx.receipt;
    if (!receipt || receipt.status !== "posted")
      return parkForReview(
        orgId,
        disputeId,
        "The refund has no posted source receipt; reconcile its payment before resuming the review.",
      );
    if (currency !== receipt.currency.toUpperCase())
      return parkForReview(
        orgId,
        disputeId,
        `The refund is in ${currency} against a ${receipt.currency} receipt; reconcile the provider currency before resuming.`,
      );
    if (delta > toUnits(receipt.total))
      return parkForReview(
        orgId,
        disputeId,
        "The refund exceeds the remaining receipt; reconcile earlier returns and credits before resuming.",
      );
    const reason = `Provider refund ${event.providerRef ?? event.providerEventId} for ${receipt.document_number}`;
    try {
      if (
        await reviewProviderReturn(orgId, disputeId, ctx, "refund", {
          providerEventId: row.provider_event_id,
        })
      )
        return { status: "pending_review", disputeId };
      return await returnFinancialStage<RefundAutomationOutcome>(async () => {
        if (delta === toUnits(receipt.total)) {
          const reversalId = await returnFinancialStage(() =>
            reversePaymentForReturn(receipt.id, orgId, reason, PSP_AUTOMATION_SYSTEM_ACTOR_ID),
          );
          await setAttemptRefunded(orgId, ctx.attempt.id, null);
          await transitionDisputeRow(orgId, disputeId, "posted", [reversalId], null);
          return { status: "posted", disputeId, documents: [reversalId] };
        }
        const credit = await openCreditCovering(
          orgId,
          ctx.link.party_id,
          ctx.link.subsidiary_id,
          receipt.currency,
          refundAmount,
        );
        if (credit) {
          const issued = await refundAgainstCredit(
            orgId,
            ctx,
            credit.documentId,
            credit.lineId,
            refundAmount,
            disputeId,
          );
          if (issued.gated)
            return parkForReview(
              orgId,
              disputeId,
              `Approve refund receipt ${issued.refundId}, then resume this provider review.`,
            );
          await setAttemptRefunded(orgId, ctx.attempt.id, null);
          await transitionDisputeRow(
            orgId,
            disputeId,
            "posted",
            [issued.refundId],
            `Settled against credit memo ${credit.documentId}`,
          );
          return { status: "posted", disputeId, documents: [issued.refundId] };
        }
        const outcome = await voidAndReissueRemainder(
          orgId,
          ctx,
          receipt.total,
          refundAmount,
          reason,
          disputeId,
        );
        if (outcome.gated)
          return parkForReview(
            orgId,
            disputeId,
            `Approve replacement receipt ${outcome.remainderId}, then resume this provider review. The original receipt remains posted.`,
          );
        if (outcome.remainderId) {
          const relinked =
            await db.execute<never>(sql`update payment_attempts set status = 'succeeded', payment_document_id = ${outcome.remainderId}, updated_at = now()
            where id = ${ctx.attempt.id} and org_id = ${orgId}`);
          if (relinked.rowCount !== 1)
            throw new PspAutomationError(
              "The payment attempt could not be linked to its remainder receipt.",
            );
        } else await setAttemptRefunded(orgId, ctx.attempt.id, null);
        const documents = [
          outcome.reversalId,
          ...(outcome.remainderId ? [outcome.remainderId] : []),
        ];
        await transitionDisputeRow(orgId, disputeId, "posted", documents, null);
        return { status: "posted", disputeId, documents };
      });
    } catch (error) {
      if (error instanceof PaymentError || error instanceof PostingError)
        return parkForReview(orgId, disputeId, error.message);
      throw error;
    }
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
  opts: { resumeReview?: true } = {},
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
      return parkDisputeForReview(
        orgId,
        id,
        "dispute-opened",
        { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
        `dispute arrived without a provider dispute id; approve once the dispute is identified`,
      );
    }
    if (event.attemptId) await lockPaymentAttempt(orgId, event.attemptId);
    const ctx = event.attemptId ? await loadAutomationContext(orgId, event.attemptId) : null;
    if (ctx && ctx.attempt.provider !== event.provider)
      throw new PspAutomationError("The dispute provider does not match its payment attempt.");
    const existing = await findDisputeByRef(orgId, event.provider, dispute.id);
    if (existing && event.attemptId !== existing.attempt_id)
      throw new PspAutomationError(
        "The dispute delivery does not match its original payment attempt.",
      );
    if (
      existing &&
      !opts.resumeReview &&
      existing.status !== "pending_review" &&
      historyHasEvent(existing.status_history, event.providerEventId)
    ) {
      return { status: "duplicate", disputeId: existing.id };
    }
    if (
      existing &&
      (existing.status === "won" || existing.status === "lost" || existing.status === "rejected")
    ) {
      await transitionDisputeRow(
        orgId,
        existing.id,
        existing.status,
        asDocIds(existing.documents_posted),
        `duplicate ${event.providerEventId} noted`,
      );
      return { status: "duplicate", disputeId: existing.id };
    }
    if (
      existing &&
      dispute.state === "opened" &&
      (asDocIds(existing.documents_posted).length > 0 ||
        ["dispute-won", "dispute-lost"].includes(pendingActionOf(existing.status_history) ?? ""))
    ) {
      return { status: "duplicate", disputeId: existing.id };
    }
    if (existing && (await reviewHasPendingGates(orgId, existing.id))) {
      const action =
        dispute.state === "won"
          ? "dispute-won"
          : dispute.state === "lost"
            ? "dispute-lost"
            : "dispute-opened";
      const retained = pendingEventOf(existing.status_history);
      if (
        pendingActionOf(existing.status_history) !== action ||
        canonicalJson(retained) !==
          canonicalJson({
            providerEventId: event.providerEventId,
            dispute,
            feeAmount: eventFee(event),
          })
      )
        throw new PspAutomationError(
          "The provider dispute changed while its Flow gates are pending. Recall that submission and resubmit the confirmed provider evidence.",
        );
      return { status: "pending_review", disputeId: existing.id };
    }
    if (dispute.state === "opened") {
      if (!ctx || !ctx.receipt || ctx.receipt.status !== "posted") {
        const row =
          existing ??
          (await insertDisputeRow(orgId, {
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
        return parkDisputeForReview(
          orgId,
          row.id,
          "dispute-opened",
          { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
          `dispute ${dispute.id} arrived with no posted receipt; approve once the receipt posts`,
        );
      }
      if (dispute.currency.toUpperCase() !== ctx.receipt.currency.toUpperCase()) {
        const row =
          existing ??
          (await insertDisputeRow(orgId, {
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
        return parkDisputeForReview(
          orgId,
          row.id,
          "dispute-opened",
          { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
          `dispute ${dispute.id} in ${dispute.currency} against a ${ctx.receipt.currency} receipt; approve once the converted amount is confirmed`,
        );
      }
      if (toUnits(dispute.amount) > toUnits(ctx.receipt.total)) {
        const row =
          existing ??
          (await insertDisputeRow(orgId, {
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
        return parkDisputeForReview(
          orgId,
          row.id,
          "dispute-opened",
          { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
          `dispute ${dispute.id} for ${dispute.amount} exceeds receipt ${ctx.receipt.document_number} total ${ctx.receipt.total}; approve once confirmed`,
        );
      }
      const row =
        existing ??
        (await insertDisputeRow(orgId, {
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
      try {
        if (
          await reviewProviderReturn(orgId, row.id, ctx, "dispute-opened", {
            providerEventId: event.providerEventId,
            dispute,
            feeAmount: eventFee(event),
          })
        )
          return { status: "pending_review", disputeId: row.id };
        return await returnFinancialStage<RefundAutomationOutcome>(async () => {
          const held = await openDisputeHold(orgId, ctx, dispute.amount, dispute.id, row.id);
          if (held.gated)
            return parkDisputeForReview(
              orgId,
              row.id,
              "dispute-opened",
              { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
              "Approve the staged remainder and hold receipts, then resume this review. The original receipt remains posted.",
            );
          await setAttemptRefunded(orgId, ctx.attempt.id, held.holdId);
          await transitionDisputeRow(orgId, row.id, "opened", held.documents, null);
          return { status: "posted", disputeId: row.id, documents: held.documents };
        });
      } catch (error) {
        if (error instanceof PaymentError || error instanceof PostingError) {
          return parkDisputeForReview(
            orgId,
            row.id,
            "dispute-opened",
            { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
            error.message,
          );
        }
        throw error;
      }
    }
    try {
      if (
        existing &&
        ctx &&
        (await reviewProviderReturn(
          orgId,
          existing.id,
          ctx,
          dispute.state === "won" ? "dispute-won" : "dispute-lost",
          { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
        ))
      )
        return { status: "pending_review", disputeId: existing.id };
      return await returnFinancialStage<RefundAutomationOutcome>(() =>
        transitionDisputeOutcome(orgId, event, existing, ctx),
      );
    } catch (error) {
      if (!(error instanceof PaymentError || error instanceof PostingError)) throw error;
      const row =
        existing ??
        (await insertDisputeRow(orgId, {
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
      return parkDisputeForReview(
        orgId,
        row.id,
        dispute.state === "won" ? "dispute-won" : "dispute-lost",
        { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
        error.message,
      );
    }
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
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  approvalRunId?: string,
): Promise<RefundAutomationOutcome> {
  return withOrgTransaction(orgId, async () => {
    await lockApprovalSubject(orgId, "payment_dispute_review", disputeId);
    const row = await lockReviewAuthority(orgId, disputeId, actorId, allowedSubsidiaryIds);
    if (row.status === "posted" || row.status === "won" || row.status === "lost") {
      return { status: "duplicate", disputeId };
    }
    if (row.status === "rejected") {
      throw new PspAutomationError(
        "a rejected review cannot be approved; wait for the provider's next event",
      );
    }
    const action =
      pendingActionOf(row.status_history) ?? (row.kind === "refund" ? "refund" : "dispute-opened");
    const retainedApproval =
      !approvalRunId && (await approvedReturnCommand(orgId, disputeId, action));
    if (
      !retainedApproval &&
      (await requestNativeCommandApproval({
        orgId,
        actorId,
        subjectKind: "payment_dispute_review",
        subjectId: disputeId,
        command: { action },
        approvalRunId,
      }))
    )
      return { status: "pending_review", disputeId };
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_disputes', ${disputeId}, ${approvalRunId ? "approve" : retainedApproval ? "resume" : "submit"},
              ${JSON.stringify({ after: { action } })}::jsonb, ${actorId})
    `);
    if (action === "refund") {
      if (!row.attempt_id) throw new PspAutomationError("review has no payment attempt to resume");
      const source = refundSourceOf(row.status_history);
      if (row.provider === "stripe" && !source)
        throw new PspAutomationError(
          "This Stripe review has no refund amount basis. Redeliver its confirmed provider event before approving it.",
        );
      const event: ProviderRefundEvent = {
        provider: row.provider,
        providerEventId: `${row.provider_event_id}#approved`,
        attemptId: row.attempt_id,
        refundedAmount: source?.amount ?? row.amount,
        refundAmountBasis: source?.basis,
        providerRefundId: source?.refundId,
        refundCurrency: source?.currency ?? row.currency,
        providerRef: row.provider_ref,
      };
      // Resume the same retained provider evidence after native command authorization.
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
      raw: { feeAmount: pendingEventOf(row.status_history)?.feeAmount ?? row.fee_amount },
    };
    return runApprovedDispute(orgId, disputeId, event);
  });
}

/** Approval re-runs post against the queued row itself (never a new row),
 * under the native posting path after the tenant Flow decision. */
async function runApprovedRefund(
  orgId: string,
  disputeId: string,
  event: ProviderRefundEvent,
): Promise<RefundAutomationOutcome> {
  const fingerprint = await reviewFingerprint(orgId, disputeId);
  const outcome = await withReviewedReturn(
    { orgId, id: disputeId, action: "refund", fingerprint },
    () =>
      processProviderRefundEvent(orgId, {
        ...event,
        providerEventId: event.providerEventId.replace(/#approved$/, ""),
      }),
  );
  if (outcome.status === "duplicate" || outcome.disputeId !== disputeId) return outcome;
  return outcome;
}

async function runApprovedDispute(
  orgId: string,
  disputeId: string,
  event: ProviderDisputeEvent,
): Promise<RefundAutomationOutcome> {
  const fingerprint = await reviewFingerprint(orgId, disputeId);
  const action =
    event.dispute.state === "won"
      ? "dispute-won"
      : event.dispute.state === "lost"
        ? "dispute-lost"
        : "dispute-opened";
  const outcome = await withReviewedReturn({ orgId, id: disputeId, action, fingerprint }, () =>
    processProviderDisputeEvent(
      orgId,
      { ...event, providerEventId: event.providerEventId.replace(/#approved$/, "") },
      { resumeReview: true },
    ),
  );
  if (outcome.disputeId !== disputeId) return outcome;
  return outcome;
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
    refundAmountBasis?: "incremental" | "cumulative";
    providerRefundId?: string | null;
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
    refundAmountBasis: parked.refundAmountBasis,
    providerRefundId: parked.providerRefundId,
    refundCurrency: parked.refundCurrency,
    providerRef: parked.providerRef,
  });
}
