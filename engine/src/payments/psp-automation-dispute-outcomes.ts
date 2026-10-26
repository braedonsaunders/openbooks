import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  stageReturnReceipt,
  postReturnReceipt,
  returnFinancialStage,
  returnStageDocument,
  withdrawReturnReceipts,
} from "./psp-return-stages.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, mulRate, neg, toUnits } from "../money/money.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { postEntry } from "../journal/post-entry.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import { openItemsForParty } from "./payment-queries.ts";
import {
  PSP_AUTOMATION_SYSTEM_ACTOR_ID,
  type RefundAutomationOutcome,
  PspAutomationError,
  type AutomationContext,
} from "./psp-automation-context.ts";
import {
  insertDisputeRow,
  transitionDisputeRow,
  disputeRow,
  type ProviderDisputeEvent,
  findDisputeByRef,
  parkDisputeForReview,
  asDocIds,
} from "./psp-automation-disputes.ts";
import { applyPaymentToOpenItem, openDisputeHold } from "./psp-automation-postings.ts";

/** Dispute outcomes: a won dispute restores the receipt, a lost dispute reverses it and charges the provider fee. */

/** Won and lost transitions, shared by live events and review approvals. */
export async function transitionDisputeOutcome(
  orgId: string,
  event: ProviderDisputeEvent,
  existing: Awaited<ReturnType<typeof findDisputeByRef>>,
  ctx: AutomationContext | null,
): Promise<RefundAutomationOutcome> {
  const { dispute } = event;
  if (!existing) {
    // No hold on file: won means the receipt stands (nothing to release);
    // lost compresses open-then-lost atomically so the economics match.
    if (!ctx || !ctx.receipt || ctx.receipt.status !== "posted") {
      const { id } = await insertDisputeRow(orgId, {
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
      });
      return parkDisputeForReview(
        orgId,
        id,
        dispute.state === "won" ? "dispute-won" : "dispute-lost",
        { providerEventId: event.providerEventId, dispute, feeAmount: eventFee(event) },
        `dispute ${dispute.id} (${dispute.state}) arrived with no hold and no posted receipt; approve once confirmed`,
      );
    }
    const { id } = await insertDisputeRow(orgId, {
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
    });
    if (dispute.state === "won") {
      await transitionDisputeRow(orgId, id, "won", [], "no hold on file; receipt stands");
      return { status: "posted", disputeId: id, documents: [] };
    }
    return runDisputeLost(orgId, id, event, ctx, true);
  }
  if (existing.status !== "opened" && asDocIds(existing.documents_posted).length === 0) {
    const { id } = existing;
    if (dispute.state === "won") {
      await withdrawReturnReceipts(
        orgId,
        id,
        PSP_AUTOMATION_SYSTEM_ACTOR_ID,
        "Dispute won before any hold posted; the original receipt stands",
      );
      await transitionDisputeRow(
        orgId,
        id,
        "won",
        asDocIds(existing.documents_posted),
        "no open hold; receipt stands",
      );
      return { status: "posted", disputeId: id, documents: asDocIds(existing.documents_posted) };
    }
    return runDisputeLost(orgId, id, event, ctx, true);
  }
  if (dispute.state === "won") {
    return runDisputeWon(orgId, existing.id, event, ctx);
  }
  return runDisputeLost(orgId, existing.id, event, ctx, false);
}

/** Release the hold and re-collect against the invoice. */
async function runDisputeWon(
  orgId: string,
  disputeId: string,
  event: ProviderDisputeEvent,
  ctx: AutomationContext | null,
): Promise<RefundAutomationOutcome> {
  const row = await disputeRow(orgId, disputeId);
  const docs = asDocIds(row.documents_posted);
  const stagedId = await returnStageDocument(orgId, disputeId, "dispute-opened", "hold");
  if (!ctx)
    return parkDisputeForReview(
      orgId,
      disputeId,
      "dispute-won",
      {
        providerEventId: event.providerEventId,
        dispute: event.dispute,
        feeAmount: eventFee(event),
      },
      "The dispute's payment attempt could not be resolved; reconcile its provider identity before resuming.",
    );
  const candidates = [...new Set(stagedId ? [stagedId] : docs)];
  const holds = candidates.length
    ? await db.execute<{ id: string; control_account_id: string }>(
        sql`
    select d.id, jl.account_id as control_account_id from documents d
      join journal_lines jl on jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
      join journal_entries entry on entry.org_id = d.org_id and entry.id = d.posted_entry_id and entry.status = 'posted' -- Live entries only: a reversed dispute hold cannot authorize settlement.
     where d.org_id = ${orgId} and d.id in (${sql.join(
       candidates.map((id) => sql`${id}`),
       sql`, `,
     )})
       and d.kind = 'customer_payment' and d.status = 'posted' and d.currency = ${row.currency}
       and d.party_id = ${ctx.link.party_id} and d.subsidiary_id = ${ctx.link.subsidiary_id}
       and d.total = ${row.amount}::numeric
       and (d.custom->'providerReturn' @> ${JSON.stringify({ disputeId, phase: "dispute-opened", role: "hold" })}::jsonb
            or d.memo = ${`PSP dispute hold ${row.provider_ref ?? event.dispute.id}`})
     for update of d
  `,
        "objects",
      )
    : [];
  if (holds.length !== 1)
    return parkDisputeForReview(
      orgId,
      disputeId,
      "dispute-won",
      {
        providerEventId: event.providerEventId,
        dispute: event.dispute,
        feeAmount: eventFee(event),
      },
      "The posted hold receipt could not be uniquely resolved; reconcile its receipt identity before resuming.",
    );
  const hold = holds[0]!;
  const issued = await stageReturnReceipt(orgId, {
    disputeId,
    phase: "dispute-won",
    role: "recollection",
    sourceReceiptId: hold.id,
    partyId: ctx.link.party_id,
    bankAccountId: ctx.bankAccountId,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: row.currency,
    amount: row.amount,
    controlAccountId: hold.control_account_id,
    applyInvoiceId: row.invoice_document_id ?? ctx.invoice.id,
    memo: `Provider dispute re-collection ${disputeId}`,
  });
  if (!issued.ready)
    return parkDisputeForReview(
      orgId,
      disputeId,
      "dispute-won",
      {
        providerEventId: event.providerEventId,
        dispute: event.dispute,
        feeAmount: eventFee(event),
      },
      `Approve re-collection receipt ${issued.receiptId}, then resume this review. The dispute hold remains posted.`,
    );
  return returnFinancialStage<RefundAutomationOutcome>(async () => {
    const reversalId = await reversePaymentForReturn(
      hold.id,
      orgId,
      `Dispute ${event.dispute.id} won; hold released`,
      PSP_AUTOMATION_SYSTEM_ACTOR_ID,
    );
    await postReturnReceipt(orgId, issued.receiptId);
    const relinked =
      await db.execute<never>(sql`update payment_attempts set status = 'succeeded', payment_document_id = ${issued.receiptId}, updated_at = now()
      where id = ${ctx.attempt.id} and org_id = ${orgId}`);
    if (relinked.rowCount !== 1)
      throw new PspAutomationError(
        "The payment attempt could not be linked to its re-collected receipt.",
      );
    const documents = [...docs, reversalId, issued.receiptId];
    await transitionDisputeRow(orgId, disputeId, "won", documents, null);
    return { status: "posted", disputeId, documents };
  });
}

/** Settle the invoice from the held funds and write off the loss and fee. */
async function runDisputeLost(
  orgId: string,
  disputeId: string,
  event: ProviderDisputeEvent,
  ctx: AutomationContext | null,
  compressed: boolean,
): Promise<RefundAutomationOutcome> {
  const row = await disputeRow(orgId, disputeId);
  const docs = asDocIds(row.documents_posted);
  if (!ctx || !ctx.receipt) {
    return parkDisputeForReview(
      orgId,
      disputeId,
      "dispute-lost",
      {
        providerEventId: event.providerEventId,
        dispute: event.dispute,
        feeAmount: eventFee(event),
      },
      `dispute ${event.dispute.id} was lost with no receipt context; approve once confirmed`,
    );
  }
  const lossAccount = ctx.disputeAccounts.chargebackLossAccountId;
  if (!lossAccount) {
    return parkDisputeForReview(
      orgId,
      disputeId,
      "dispute-lost",
      {
        providerEventId: event.providerEventId,
        dispute: event.dispute,
        feeAmount: eventFee(event),
      },
      `chargeback loss account is not configured; set it in Company Settings → Payment Providers for ${ctx.attempt.provider}`,
    );
  }
  if (ctx.disputeAccounts.disputeFeeAccountId === null && cmp(eventFee(event), "0") > 0) {
    return parkDisputeForReview(
      orgId,
      disputeId,
      "dispute-lost",
      {
        providerEventId: event.providerEventId,
        dispute: event.dispute,
        feeAmount: eventFee(event),
      },
      `dispute fee account is not configured; set it in Company Settings → Payment Providers for ${ctx.attempt.provider}`,
    );
  }
  let holdId = docs.length > 0 ? docs[docs.length - 1]! : null;
  let documents = [...docs];
  if (compressed || !holdId) {
    // Lost with no hold on file: run the hold first so the write-off below
    // sees the same shape as a normally aged dispute.
    let held: { documents: string[]; holdId: string; gated: boolean };
    try {
      held = await openDisputeHold(orgId, ctx, row.amount, event.dispute.id, disputeId);
    } catch (error) {
      if (error instanceof PspAutomationError) {
        return parkDisputeForReview(
          orgId,
          disputeId,
          "dispute-lost",
          {
            providerEventId: event.providerEventId,
            dispute: event.dispute,
            feeAmount: eventFee(event),
          },
          error.message,
        );
      }
      throw error;
    }
    if (held.gated) {
      return parkDisputeForReview(
        orgId,
        disputeId,
        "dispute-lost",
        {
          providerEventId: event.providerEventId,
          dispute: event.dispute,
          feeAmount: eventFee(event),
        },
        `replacement receipt for the undisputed remainder needs approval before the loss can post`,
      );
    }
    holdId = held.holdId;
    documents = [...documents, ...held.documents];
    await transitionDisputeRow(
      orgId,
      disputeId,
      "opened",
      documents,
      compressed ? "hold compressed from the lost event" : null,
    );
  }
  // Apply the held credit to the invoice: the customer owes nothing — the
  // provider took the money — so the invoice settles from the hold.
  const invoice = (
    await db.execute<{ id: string; open_balance: string }>(
      sql`
    select id, open_balance::text from documents where id = ${row.invoice_document_id ?? ctx.invoice.id} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!invoice) throw new PspAutomationError("invoice is not in this organization");
  const holdLine = (
    await db.execute<{ id: string }>(
      sql`
    select jl.id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${orgId} and je.source_document_id = ${holdId} and jl.is_open_item
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!holdLine) throw new PspAutomationError("dispute hold posted without an open item");
  const invoiceItems = await openItemsForParty(ctx.link.party_id, "ar", orgId);
  const invoiceItem = invoiceItems.find((i) => i.documentId === invoice.id);
  const applied = cmp(row.amount, invoice.open_balance) < 0 ? row.amount : invoice.open_balance;
  if (cmp(applied, "0") > 0 && invoiceItem) {
    // Convergent retry: an existing application for these endpoints settles
    // the run without a second write.
    const settled = (
      await db.execute<{ id: string }>(
        sql`
      select id from applications
       where org_id = ${orgId} and from_line_id = ${holdLine.id} and to_line_id = ${invoiceItem.lineId}
         and unapplied_at is null
    `,
        "objects",
      )
    )[0];
    if (!settled) {
      await applyPaymentToOpenItem(orgId, {
        fromLineId: holdLine.id,
        toLineId: invoiceItem.lineId,
        amount: applied,
        currency: row.currency,
        reference: `dispute ${event.dispute.id} lost; hold settles invoice`,
      });
    }
  }
  // Write off the held funds to chargeback loss (plus the provider fee to
  // fees), clearing the hold account to zero.
  const { primaryBookId, periodForDate } = await import("./psp-settlement.ts");
  const bookId = await primaryBookId(orgId);
  const postingDate = await businessToday(orgId);
  const periodId = await periodForDate(orgId, postingDate, ctx.link.subsidiary_id);
  if (!periodId) throw new PspAutomationError(`no open accounting period for ${postingDate}`);
  await assertPeriodModulesOpen(db, {
    orgId,
    periodId,
    bookId,
    subsidiaryIds: [ctx.link.subsidiary_id],
    modules: ["banking"],
  });
  const fee = eventFee(event);
  const feeWritten = await db.execute<never>(sql`update payment_disputes set fee_amount = ${fee}
    where org_id = ${orgId} and id = ${disputeId}`);
  if (feeWritten.rowCount !== 1)
    throw new PspAutomationError("The dispute's fee evidence could not be recorded.");
  // A dispute in a currency other than the subsidiary's functional currency
  // clears its hold at the rate the hold receipt posted at (the posting
  // kernel stamps that rate on the hold document). Converting at that one
  // rate clears the disputed-funds balance to exactly zero in both
  // currencies, and the rate and its source travel on the entry as evidence.
  const holdBasis = (
    await db.execute<{ currency: string; fx_rate: string; functional: string }>(
      sql`
    select d.currency, d.fx_rate::text as fx_rate, s.base_currency as functional
      from documents d
      join subsidiaries s on s.id = ${ctx.link.subsidiary_id} and s.org_id = d.org_id
     where d.id = ${holdId} and d.org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!holdBasis) throw new PspAutomationError("dispute hold receipt is not in this organization");
  if (holdBasis.currency.toUpperCase() !== row.currency.toUpperCase()) {
    throw new PspAutomationError(
      `dispute ${event.dispute.id} is in ${row.currency} but its hold receipt is in ${holdBasis.currency}; review the hold before recording the loss`,
    );
  }
  const foreign = row.currency.toUpperCase() !== holdBasis.functional.toUpperCase();
  const holdRate = holdBasis.fx_rate;
  const leg = (accountId: string, txn: string, credit: boolean, memo: string) => {
    if (!foreign)
      return { accountId, amount: credit ? neg(txn) : txn, currency: row.currency, memo };
    const functionalAmount = mulRate(txn, holdRate);
    return {
      accountId,
      amount: credit ? neg(functionalAmount) : functionalAmount,
      currency: row.currency,
      txnAmount: credit ? neg(txn) : txn,
      fxRate: holdRate,
      memo,
    };
  };
  const entryId = randomUUID();
  const entryNumber = `PSP-DISPUTE-${event.dispute.id.slice(0, 12).toUpperCase()}-LOSS`;
  const posted = await postEntry(db, {
    id: entryId,
    orgId,
    bookId,
    subsidiaryId: ctx.link.subsidiary_id,
    entryNumber,
    postingDate,
    periodId,
    memo: `Chargeback loss for dispute ${event.dispute.id}`,
    origin: "document",
    actorId: PSP_AUTOMATION_SYSTEM_ACTOR_ID,
    idempotencyKey: `psp-dispute-loss:${orgId}:${disputeId}`,
    ...(foreign
      ? {
          custom: {
            fxEvidence: {
              rate: holdRate,
              source: "dispute_hold_receipt",
              sourceDocumentId: holdId,
              currency: row.currency,
              functionalCurrency: holdBasis.functional,
            },
          },
        }
      : {}),
    lines: [
      leg(lossAccount, row.amount, false, "Chargeback loss"),
      ...(cmp(fee, "0") > 0
        ? [leg(ctx.disputeAccounts.disputeFeeAccountId!, fee, false, "Provider dispute fee")]
        : []),
      leg(ctx.disputeAccounts.disputedFundsAccountId!, row.amount, true, "Clear dispute hold"),
      ...(cmp(fee, "0") > 0 ? [leg(ctx.bankAccountId, fee, true, "Dispute fee taken")] : []),
    ],
  });
  await transitionDisputeRow(orgId, disputeId, "lost", [...documents, posted.entryId], null);
  return { status: "posted", disputeId, documents: [...documents, posted.entryId] };
}

export function eventFee(event: ProviderDisputeEvent): string {
  const raw = event.raw as Record<string, unknown> | undefined;
  const fee = raw?.feeAmount ?? raw?.fee_amount;
  if (typeof fee === "string" && /^\d+(\.\d{1,4})?$/.test(fee.trim()))
    return fromUnits(toUnits(fee.trim()));
  return "0";
}
