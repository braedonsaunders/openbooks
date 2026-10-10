import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, mulRate, neg, toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { postEntry } from "../journal/post-entry.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import {
  createPaymentDocument,
  updateDraftPayment,
} from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { paymentControlDeps } from "./payment-accounts.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { applyStandaloneCredits } from "./credit-settlement.ts";
import { sameCurrencyAllocation, type AllocationInput } from "./settlement-policy.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { finalizePaymentAcceptanceForDocument } from "../payments-core/acceptance-effect.ts";
import { PAYMENT_RUN_SYSTEM_ACTOR_ID } from "./run-cancellation.ts";

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
export const PSP_AUTOMATION_SYSTEM_ACTOR_ID = PAYMENT_RUN_SYSTEM_ACTOR_ID;

export type PspAutomationPolicy = "automatic" | "review";

export interface ProviderDisputeDetail {
  id: string;
  amount: string;
  currency: string;
  reason?: string | null;
  state: "opened" | "won" | "lost";
}

export interface ProviderRefundEvent {
  provider: string;
  providerEventId: string;
  attemptId: string;
  refundedAmount: string | null;
  refundCurrency: string | null;
  providerRef: string | null;
  dispute?: ProviderDisputeDetail | null;
  raw?: unknown;
}

export type RefundAutomationOutcome =
  | { status: "posted"; disputeId: string; documents: string[] }
  | { status: "pending_review"; disputeId: string }
  | { status: "duplicate"; disputeId: string };

export class PspAutomationError extends PaymentError {}

type AutomationContext = {
  attempt: {
    id: string;
    status: string;
    provider: string;
    external_ref: string;
    payment_document_id: string | null;
  };
  link: {
    id: string;
    document_id: string;
    party_id: string;
    subsidiary_id: string;
    bank_account_id: string;
    currency: string;
    created_by: string | null;
  };
  receipt: {
    id: string;
    status: string;
    document_number: string;
    total: string;
    currency: string;
    custom: Record<string, unknown>;
  } | null;
  invoice: {
    id: string;
    document_number: string;
    open_balance: string;
  };
  policy: PspAutomationPolicy;
  disputeAccounts: {
    disputedFundsAccountId: string | null;
    chargebackLossAccountId: string | null;
    disputeFeeAccountId: string | null;
  };
  bankAccountId: string;
};

async function loadAutomationContext(
  orgId: string,
  attemptId: string,
): Promise<AutomationContext> {
  const attempt = (await db.execute<{
    id: string;
    status: string;
    provider: string;
    external_ref: string;
    payment_document_id: string | null;
    link_id: string;
  }>(sql`
    select id, status, provider, external_ref, payment_document_id, link_id
      from payment_attempts
     where id = ${attemptId} and org_id = ${orgId}
     for update
  `)).rows[0];
  if (!attempt) throw new PspAutomationError("payment attempt is not in this organization");
  const link = (await db.execute<{
    id: string;
    document_id: string;
    party_id: string;
    subsidiary_id: string;
    bank_account_id: string;
    currency: string;
    created_by: string | null;
  }>(sql`
    select l.id, l.document_id, l.party_id, l.subsidiary_id, l.bank_account_id,
           l.currency, l.created_by
      from payment_links l
     where l.id = ${attempt.link_id} and l.org_id = ${orgId}
  `)).rows[0];
  if (!link) throw new PspAutomationError("payment link is not in this organization");
  const receipt = attempt.payment_document_id
    ? ((await db.execute<{
      id: string;
      status: string;
      document_number: string;
      total: string;
      currency: string;
      custom: Record<string, unknown> | null;
    }>(sql`
        select id, status, document_number, total::text, currency, custom
          from documents
         where id = ${attempt.payment_document_id} and org_id = ${orgId}
      `)).rows[0] ?? null)
    : null;
  const invoice = (await db.execute<{ id: string; document_number: string; open_balance: string }>(sql`
    select id, document_number, open_balance::text
      from documents
     where id = ${link.document_id} and org_id = ${orgId}
  `)).rows[0];
  if (!invoice) throw new PspAutomationError("invoice is not in this organization");
  const config = (await db.execute<{
    refund_policy: string | null;
    default_disputed_funds_account_id: string | null;
    default_chargeback_loss_account_id: string | null;
    default_dispute_fee_account_id: string | null;
  }>(sql`
    select refund_policy, default_disputed_funds_account_id,
           default_chargeback_loss_account_id, default_dispute_fee_account_id
      from psp_provider_configs
     where org_id = ${orgId} and provider = ${attempt.provider}
  `)).rows[0];
  // New configs default to automatic (migration 0497); a missing row means a
  // provider configured before automation existed — same behaviour.
  const policy: PspAutomationPolicy = config?.refund_policy === "review" ? "review" : "automatic";
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      provider: attempt.provider,
      external_ref: attempt.external_ref,
      payment_document_id: attempt.payment_document_id,
    },
    link,
    receipt: receipt
      ? {
        id: receipt.id,
        status: receipt.status,
        document_number: receipt.document_number,
        total: receipt.total,
        currency: receipt.currency,
        custom: receipt.custom ?? {},
      }
      : null,
    invoice,
    policy,
    disputeAccounts: {
      disputedFundsAccountId: config?.default_disputed_funds_account_id ?? null,
      chargebackLossAccountId: config?.default_chargeback_loss_account_id ?? null,
      disputeFeeAccountId: config?.default_dispute_fee_account_id ?? null,
    },
    bankAccountId: link.bank_account_id,
  };
}

function historyAppend(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

async function insertDisputeRow(
  orgId: string,
  row: {
    provider: string;
    providerEventId: string;
    kind: "refund" | "dispute";
    status: string;
    attemptId: string | null;
    receiptDocumentId: string | null;
    invoiceDocumentId: string | null;
    currency: string;
    amount: string;
    feeAmount: string;
    providerRef: string | null;
    reason: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  // The event key is the automation idempotency lock: a redelivery converges
  // on the stored row instead of posting twice. The conflict is expected on
  // every redelivery, which is why doing nothing here is benign.
  const id = randomUUID();
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into payment_disputes
      (id, org_id, provider, provider_event_id, kind, status, attempt_id,
       receipt_document_id, invoice_document_id, currency, amount, fee_amount,
       provider_ref, reason, status_history, created_by, updated_by)
    values (${id}, ${orgId}, ${row.provider}, ${row.providerEventId}, ${row.kind},
            ${row.status}, ${row.attemptId}, ${row.receiptDocumentId}, ${row.invoiceDocumentId},
            ${row.currency}, ${row.amount}, ${row.feeAmount}, ${row.providerRef}, ${row.reason},
            ${JSON.stringify([{ status: row.status, at: new Date().toISOString(), reason: row.reason }])}::jsonb,
            ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}, ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
    -- Repeated provider delivery reuses the dispute selected below instead of recording it twice.
    on conflict (org_id, provider, provider_event_id) do nothing
    returning id
  `));
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const existing = (await db.execute<{ id: string }>(sql`
    select id from payment_disputes
     where org_id = ${orgId} and provider = ${row.provider} and provider_event_id = ${row.providerEventId}
  `)).rows[0];
  if (!existing) throw new PspAutomationError("dispute record could not be locked");
  return { id: existing.id, created: false };
}

async function transitionDisputeRow(
  orgId: string,
  disputeId: string,
  status: string,
  documents: string[],
  reason: string | null,
): Promise<void> {
  // The zero-row check is the failure, not the update: under RLS an unscoped
  // write silently matches nothing, which would report a posted refund whose
  // record never moved.
  const updated = (await db.execute(sql`
    update payment_disputes
       set status = ${status},
           documents_posted = ${JSON.stringify(documents)}::jsonb,
           reason = coalesce(${reason}, reason),
           status_history = status_history || ${historyAppend({ status, at: new Date().toISOString(), reason, documents })}::jsonb,
           updated_at = now(),
           updated_by = ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}
     where id = ${disputeId} and org_id = ${orgId}
  `));
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("dispute record is not in this organization");
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'payment_disputes', ${disputeId}, 'update',
            ${JSON.stringify({ after: { status, documents, reason } })}::jsonb,
            ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
  `);
}

async function disputeRow(
  orgId: string,
  disputeId: string,
): Promise<{
  id: string;
  kind: string;
  status: string;
  attempt_id: string | null;
  receipt_document_id: string | null;
  invoice_document_id: string | null;
  currency: string;
  amount: string;
  fee_amount: string;
  provider: string;
  provider_event_id: string;
  provider_ref: string | null;
  reason: string | null;
  documents_posted: unknown;
  status_history: unknown;
}> {
  const row = (await db.execute<{
    id: string;
    kind: string;
    status: string;
    attempt_id: string | null;
    receipt_document_id: string | null;
    invoice_document_id: string | null;
    currency: string;
    amount: string;
    fee_amount: string;
    provider: string;
    provider_event_id: string;
    provider_ref: string | null;
    reason: string | null;
    documents_posted: unknown;
    status_history: unknown;
  }>(sql`
    select id, kind, status, attempt_id, receipt_document_id, invoice_document_id,
           currency, amount::text, fee_amount::text, provider, provider_event_id,
           provider_ref, reason, documents_posted, status_history
      from payment_disputes
     where id = ${disputeId} and org_id = ${orgId}
     for update
  `)).rows[0];
  if (!row) throw new PspAutomationError("dispute record is not in this organization");
  return row;
}

/** Total already refunded or held against one receipt through posted automation rows. */
async function postedAgainstReceipt(orgId: string, receiptId: string): Promise<bigint> {
  const rows = (await db.execute<{ amount: string }>(sql`
    select amount::text from payment_disputes
     where org_id = ${orgId} and receipt_document_id = ${receiptId}
       and status in ('posted', 'opened', 'lost')
  `)).rows;
  return rows.reduce((sum, r) => sum + toUnits(r.amount), 0n);
}

/** A posted receipt carrying our purpose memo — the crash-retry convergence
 *  rule: a retried run reuses the receipt it already posted instead of
 *  minting a second one. */
async function findPostedPurposeReceipt(orgId: string, memo: string): Promise<string | null> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from documents
     where org_id = ${orgId} and kind = 'customer_payment' and status = 'posted' and memo = ${memo}
     order by created_at desc limit 1
  `)).rows[0];
  return row?.id ?? null;
}

/** The receivable account an open item sits on: by its journal line, or by
 *  a posted document's own open-item leg. Fails closed when none exists. */
async function openItemAccount(
  orgId: string,
  target: { lineId: string } | { documentId: string },
): Promise<string> {
  const row = (await db.execute<{ account_id: string }>("lineId" in target
    ? sql`select account_id from journal_lines where org_id = ${orgId} and id = ${target.lineId} and is_open_item`
    : sql`
      select jl.account_id
        from documents d
        join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id and jl.is_open_item
       where d.org_id = ${orgId} and d.id = ${target.documentId}
       order by jl.line_number
       limit 1`)).rows[0];
  if (!row) throw new PspAutomationError("the settled document has no posted receivable open item");
  return row.account_id;
}

/** Post an unapplied customer receipt (cash moves, nothing settles) — the
 *  same validated draft shape settleAttempt builds when the invoice needs no
 *  application. A gated receipt parks: the caller records pending_review and
 *  the approval resumes it, so nothing voids before the hold can post. */
async function postUnappliedReceipt(
  orgId: string,
  opts: {
    partyId: string;
    bankAccountId: string;
    subsidiaryId: string;
    currency: string;
    total: string;
    memo: string;
    referenceNumber: string;
    /** The receivable account of the open item this receipt will later
     *  settle against: applications require both endpoints on one account,
     *  so the receipt posts to the target's own account, never a default. */
    controlAccountId: string;
  },
): Promise<{ receiptId: string; gated: boolean }> {
  const actorId = PSP_AUTOMATION_SYSTEM_ACTOR_ID;
  const payment = await createPaymentDocument({
    orgId,
    kind: "customer_payment",
    createdBy: actorId,
    allowedSubsidiaryIds: null,
    partyId: opts.partyId,
    bankAccountId: opts.bankAccountId,
    documentDate: await businessToday(orgId),
    memo: opts.memo,
    subsidiaryId: opts.subsidiaryId,
    currency: opts.currency,
  });
  await db.execute(sql`delete from document_lines where document_id = ${payment.id} and org_id = ${orgId}`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
    values (${orgId}, ${payment.id}, 1, ${opts.bankAccountId}, '1', ${opts.total}, ${opts.total}, '0')
  `);
  const shaped = await db.execute<{ id: string }>(sql`
    update documents
       set reference_number = ${opts.referenceNumber},
           custom = coalesce(custom, '{}'::jsonb) || jsonb_build_object('allocations', '[]'::jsonb, 'controlAccountId', ${opts.controlAccountId}::text),
           subtotal = ${opts.total}, tax_total = '0', total = ${opts.total},
           updated_at = now(), updated_by = ${actorId}
     where id = ${payment.id} and org_id = ${orgId} and status = 'draft'
     returning id
  `);
  if (!shaped.rows[0]) throw new PspAutomationError("the unapplied receipt draft changed before it could be completed");
  const submission = await submitAndReleaseIfUngated("customer_payment", payment.id, actorId);
  if (submission.flowError) {
    throw new PspAutomationError(`receipt approval could not be routed: ${submission.flowError}`);
  }
  if (submission.gated) return { receiptId: payment.id, gated: true };
  await postDocument(payment.id, await paymentControlDeps(orgId));
  return { receiptId: payment.id, gated: false };
}

/** Post a receipt applied to one invoice (plus on-account for any remainder),
 *  through the standard submit-and-post path. A gated receipt parks instead
 *  of posting: the caller records pending_review and the review approval
 *  resumes it — nothing voids before the replacement can post. */
async function postAppliedReceipt(
  orgId: string,
  opts: {
    partyId: string;
    bankAccountId: string;
    subsidiaryId: string;
    currency: string;
    invoiceId: string;
    invoiceOpenBalance: string;
    amount: string;
    feeAmount: string;
    feeIncomeAccountId: string | null;
    memo: string;
    referenceNumber: string;
  },
): Promise<{ receiptId: string; gated: boolean }> {
  const actorId = PSP_AUTOMATION_SYSTEM_ACTOR_ID;
  const payment = await createPaymentDocument({
    orgId,
    kind: "customer_payment",
    createdBy: actorId,
    allowedSubsidiaryIds: null,
    partyId: opts.partyId,
    bankAccountId: opts.bankAccountId,
    documentDate: await businessToday(orgId),
    memo: opts.memo,
    subsidiaryId: opts.subsidiaryId,
    currency: opts.currency,
  });
  const openItems = await openItemsForParty(opts.partyId, "ar", orgId);
  const item = openItems.find((i) => i.documentId === opts.invoiceId);
  if (!item) throw new PspAutomationError("invoice open item not found");
  const invoicePortion = cmp(opts.amount, opts.invoiceOpenBalance) < 0 ? opts.amount : opts.invoiceOpenBalance;
  const allocations: AllocationInput[] = cmp(invoicePortion, "0") > 0
    ? [sameCurrencyAllocation(item.lineId, invoicePortion)]
    : [];
  const onAccountAmount = fromUnits(toUnits(opts.amount) - toUnits(invoicePortion));
  await updateDraftPayment(
    payment.id,
    {
      allocations,
      referenceNumber: opts.referenceNumber,
      feeAmount: opts.feeAmount,
      feeIncomeAccountId: opts.feeIncomeAccountId,
      onAccountAmount,
    },
    actorId,
    orgId,
    // PSP automation on its own receipt draft: no actor entity set is
    // resolved here, so explicit null names the unrestricted grant outright.
    { allowedSubsidiaryIds: null },
  );
  const submission = await submitAndReleaseIfUngated("customer_payment", payment.id, actorId);
  if (submission.flowError) {
    throw new PspAutomationError(`receipt approval could not be routed: ${submission.flowError}`);
  }
  if (submission.gated) return { receiptId: payment.id, gated: true };
  await postPaymentWithApplications(payment.id, allocations, actorId, "api");
  await finalizePaymentAcceptanceForDocument(payment.id);
  return { receiptId: payment.id, gated: false };
}

/** Reverse a receipt and re-post the remainder against the invoice — the
 *  partial-refund primitive. Applications stay positive-only: the void
 *  reopens the invoice and the re-receipt settles what is still owed. */
async function voidAndReissueRemainder(
  orgId: string,
  ctx: AutomationContext,
  receiptTotal: string,
  refundedAmount: string,
  reason: string,
): Promise<{ reversalId: string; remainderId: string | null; gated: boolean }> {
  const reversalId = await reversePaymentForReturn(
    ctx.receipt!.id,
    orgId,
    reason,
    PSP_AUTOMATION_SYSTEM_ACTOR_ID,
  );
  const remainder = fromUnits(toUnits(receiptTotal) - toUnits(refundedAmount));
  if (cmp(remainder, "0") <= 0) return { reversalId, remainderId: null, gated: false };
  const custom = ctx.receipt!.custom as { feeAmount?: string; feeIncomeAccountId?: string };
  const invoice = (await db.execute<{ open_balance: string }>(sql`
    select open_balance::text from documents where id = ${ctx.invoice.id} and org_id = ${orgId}
  `)).rows[0];
  const purpose = `PSP auto-refund remainder for ${ctx.attempt.external_ref}`;
  const reused = await findPostedPurposeReceipt(orgId, purpose);
  if (reused) return { reversalId, remainderId: reused, gated: false };
  const issued = await postAppliedReceipt(orgId, {
    partyId: ctx.link.party_id,
    bankAccountId: ctx.bankAccountId,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: ctx.receipt!.currency,
    invoiceId: ctx.invoice.id,
    invoiceOpenBalance: invoice?.open_balance ?? "0",
    amount: remainder,
    feeAmount: typeof custom.feeAmount === "string" ? custom.feeAmount : "0",
    feeIncomeAccountId: typeof custom.feeIncomeAccountId === "string" ? custom.feeIncomeAccountId : null,
    memo: purpose,
    referenceNumber: `psp-refund:${ctx.attempt.external_ref.slice(0, 8)}`,
  });
  return { reversalId, remainderId: issued.receiptId, gated: issued.gated };
}

/** Settle a partial refund against an operator-issued credit memo: the
 *  negative receipt moves the cash, and the credit application links it to
 *  the credit the memo already gave. */
async function refundAgainstCredit(
  orgId: string,
  ctx: AutomationContext,
  creditDocumentId: string,
  creditLineId: string,
  refundedAmount: string,
): Promise<{ refundId: string; gated: boolean }> {
  const purpose = `PSP auto-refund against credit for ${ctx.attempt.external_ref}`;
  const reused = await findPostedPurposeReceipt(orgId, purpose);
  const issued = reused ? { receiptId: reused, gated: false } : await postUnappliedReceipt(orgId, {
    partyId: ctx.link.party_id,
    bankAccountId: ctx.bankAccountId,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: ctx.receipt!.currency,
    total: neg(refundedAmount),
    memo: purpose,
    referenceNumber: `psp-refund:${ctx.attempt.external_ref.slice(0, 8)}`,
    controlAccountId: await openItemAccount(orgId, { lineId: creditLineId }),
  });
  if (issued.gated) return { refundId: issued.receiptId, gated: true };
  const refundId = issued.receiptId;
  const refundLine = (await db.execute<{ id: string }>(sql`
    select jl.id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${orgId} and je.source_document_id = ${refundId} and jl.is_open_item
     limit 1
  `)).rows[0];
  if (!refundLine) throw new PspAutomationError("refund receipt posted without an open item");
  // Convergent retry: an existing application for these endpoints settles the
  // run without a second write.
  const settled = (await db.execute<{ id: string }>(sql`
    select id from applications
     where org_id = ${orgId} and from_line_id = ${creditLineId} and to_line_id = ${refundLine.id}
       and unapplied_at is null
  `)).rows[0];
  if (!settled) {
    await applyStandaloneCredits(
      orgId,
      PSP_AUTOMATION_SYSTEM_ACTOR_ID,
      {
        partyId: ctx.link.party_id,
        side: "ar",
        appliedOn: await businessToday(orgId),
        credits: [{
          fromLineId: creditLineId,
          toLineId: refundLine.id,
          amount: refundedAmount,
          sourceDocumentId: creditDocumentId,
        }],
        idempotencyKey: randomUUID(),
      },
      null,
    );
  }
  return { refundId, gated: false };
}

/**
 * Apply one posted payment open line to another posted open item (the lost
 * path settles the invoice from the dispute hold). Same currency, both
 * endpoints locked, evidence spelled out — the deposits precedent for a
 * payment-sourced application, since the credit-settlement path admits only
 * credit-memo lines. The open-balance trigger moves both balances; the
 * zero-row check fails the run instead of reporting a settled invoice the
 * ledger never reflects.
 */
async function applyPaymentToOpenItem(
  orgId: string,
  opts: {
    fromLineId: string;
    toLineId: string;
    amount: string;
    currency: string;
    reference: string;
  },
): Promise<string> {
  const appliedOn = await businessToday(orgId);
  await lockApplicationEvidence(db, orgId, [opts.fromLineId, opts.toLineId]);
  const endpoints = (await db.execute<{ id: string; currency: string; open: string }>(sql`
    select jl.id, jl.currency,
           (abs(jl.amount) - coalesce(sum(case when a.unapplied_at is null then a.source_amount else 0 end), 0))::text as open
      from journal_lines jl
      left join applications a on (a.from_line_id = jl.id or a.to_line_id = jl.id) and a.org_id = jl.org_id
     where jl.org_id = ${orgId} and (jl.id = ${opts.fromLineId} or jl.id = ${opts.toLineId})
     group by jl.id
  `)).rows;
  const from = endpoints.find((row) => row.id === opts.fromLineId);
  const to = endpoints.find((row) => row.id === opts.toLineId);
  if (!from || !to) {
    throw new PspAutomationError("a receipt or invoice line disappeared while settling; retry the event");
  }
  if (from.currency.toUpperCase() !== opts.currency.toUpperCase() || to.currency.toUpperCase() !== opts.currency.toUpperCase()) {
    throw new PspAutomationError(
      `settlement needs both lines in ${opts.currency}; re-check the receipt and invoice currencies`,
    );
  }
  if (toUnits(opts.amount) <= 0n) {
    throw new PspAutomationError("settlement amount must be positive");
  }
  if (toUnits(opts.amount) > toUnits(from.open) || toUnits(opts.amount) > toUnits(to.open)) {
    throw new PspAutomationError(
      `settlement of ${opts.amount} exceeds an open balance; reload the receipt and invoice and retry`,
    );
  }
  const applicationId = randomUUID();
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into applications
      (id, org_id, from_line_id, to_line_id, amount, source_amount,
       source_transaction_amount, source_transaction_currency,
       target_transaction_amount, target_transaction_currency,
       settlement_rate, settlement_rate_source, settlement_rate_reference,
       applied_on, created_by, updated_by)
    values (${applicationId}, ${orgId}, ${opts.fromLineId}, ${opts.toLineId}, ${opts.amount},
            ${opts.amount}, ${opts.amount}, ${opts.currency},
            ${opts.amount}, ${opts.currency},
            '1', 'same_currency', ${opts.reference},
            ${appliedOn}, ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}, ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new PspAutomationError("the settlement could not be recorded; retry the event");
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'applications', ${applicationId}, 'insert',
            ${JSON.stringify({ mode: "payment_applied_without_cash", source: "payments.psp-refund-automation", after: { fromLineId: opts.fromLineId, toLineId: opts.toLineId, amount: opts.amount, appliedOn } })}::jsonb,
            ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
  `);
  return inserted.id;
}

/** An open customer credit memo covering the refunded amount, if the
 *  operator issued one before the provider refund arrived. */
async function openCreditCovering(
  orgId: string,
  partyId: string,
  currency: string,
  refundedAmount: string,
): Promise<{ documentId: string; lineId: string; open: string } | null> {
  const credits = (await db.execute<{ id: string; open_balance: string }>(sql`
    select id, open_balance::text
      from documents
     where org_id = ${orgId} and kind = 'customer_credit' and status = 'posted'
       and party_id = ${partyId} and currency = ${currency}
       and open_balance::numeric >= ${refundedAmount}::numeric
     order by document_date asc limit 1
  `)).rows;
  const credit = credits[0];
  if (!credit) return null;
  const line = (await db.execute<{ id: string; open: string }>(sql`
    select jl.id, (abs(jl.amount) - coalesce(sum(a.source_amount), 0))::text as open
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      left join applications a on a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
     where jl.org_id = ${orgId} and je.source_document_id = ${credit.id} and jl.is_open_item
     group by jl.id having (abs(jl.amount) - coalesce(sum(a.source_amount), 0)) >= ${refundedAmount}::numeric
     limit 1
  `)).rows[0];
  if (!line) return null;
  return { documentId: credit.id, lineId: line.id, open: line.open };
}

/** Mark the attempt's collection state after automation posts. The zero-row
 *  check fails the run instead of reporting a posted refund the attempt
 *  never reflects. */
async function setAttemptRefunded(orgId: string, attemptId: string, receiptId: string | null): Promise<void> {
  const updated = (await db.execute(sql`
    update payment_attempts set status = 'refunded', updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status in ('succeeded', 'initiated', 'refunded')
  `));
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("payment attempt left the refundable state while posting");
  }
  if (receiptId !== null) {
    const relinked = (await db.execute(sql`
      update payment_attempts set payment_document_id = ${receiptId}, updated_at = now()
       where id = ${attemptId} and org_id = ${orgId}
    `));
    if ((relinked.rowCount ?? 0) !== 1) {
      throw new PspAutomationError("payment attempt could not be relinked to its replacement receipt");
    }
  }
}

async function parkForReview(
  orgId: string,
  disputeId: string,
  reason: string,
): Promise<RefundAutomationOutcome> {
  await transitionDisputeRow(orgId, disputeId, "pending_review", [], reason);
  return { status: "pending_review", disputeId };
}

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

export interface ProviderDisputeEvent {
  provider: string;
  providerEventId: string;
  attemptId: string | null;
  dispute: ProviderDisputeDetail;
  raw?: unknown;
}

type PendingAction = "refund" | "dispute-opened" | "dispute-won" | "dispute-lost";

async function findDisputeByRef(
  orgId: string,
  provider: string,
  providerRef: string,
): Promise<{
  id: string;
  status: string;
  attempt_id: string | null;
  receipt_document_id: string | null;
  invoice_document_id: string | null;
  currency: string;
  amount: string;
  fee_amount: string;
  provider_event_id: string;
  reason: string | null;
  documents_posted: unknown;
  status_history: unknown;
} | null> {
  const row = (await db.execute<{
    id: string;
    status: string;
    attempt_id: string | null;
    receipt_document_id: string | null;
    invoice_document_id: string | null;
    currency: string;
    amount: string;
    fee_amount: string;
    provider_event_id: string;
    reason: string | null;
    documents_posted: unknown;
    status_history: unknown;
  }>(sql`
    select id, status, attempt_id, receipt_document_id, invoice_document_id,
           currency, amount::text, fee_amount::text, provider_event_id, reason,
           documents_posted, status_history
      from payment_disputes
     where org_id = ${orgId} and provider = ${provider} and provider_ref = ${providerRef}
       and kind = 'dispute'
     order by created_at desc limit 1
     for update
  `)).rows[0];
  return row ?? null;
}

function historyHasEvent(history: unknown, providerEventId: string): boolean {
  if (!Array.isArray(history)) return false;
  return history.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (record.providerEventId === providerEventId) return true;
    const event = record.event as Record<string, unknown> | undefined;
    return event?.providerEventId === providerEventId;
  });
}

function pendingActionOf(history: unknown): PendingAction | null {
  if (!Array.isArray(history)) return null;
  for (const entry of history) {
    if (typeof entry !== "object" || entry === null) continue;
    const action = (entry as Record<string, unknown>).pendingAction;
    if (action === "refund" || action === "dispute-opened" || action === "dispute-won" || action === "dispute-lost") {
      return action;
    }
  }
  return null;
}

async function parkDisputeForReview(
  orgId: string,
  disputeId: string,
  pendingAction: PendingAction,
  event: Record<string, unknown>,
  reason: string,
): Promise<RefundAutomationOutcome> {
  const updated = (await db.execute(sql`
    update payment_disputes
       set status = 'pending_review',
           reason = ${reason},
           status_history = status_history || ${JSON.stringify({ status: "pending_review", at: new Date().toISOString(), reason, pendingAction, event })}::jsonb,
           updated_at = now(),
           updated_by = ${PSP_AUTOMATION_SYSTEM_ACTOR_ID}
     where id = ${disputeId} and org_id = ${orgId}
  `));
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("dispute record is not in this organization");
  }
  return { status: "pending_review", disputeId };
}

/** Post the dispute hold: the receipt reverses (the invoice reopens) and the
 *  disputed funds re-post unapplied into the clearing account, so the hold
 *  is a visible balance while the outcome is unknown. */
async function openDisputeHold(
  orgId: string,
  ctx: AutomationContext,
  disputeAmount: string,
  providerRef: string,
): Promise<{ documents: string[]; holdId: string; gated: boolean }> {
  const disputedFunds = ctx.disputeAccounts.disputedFundsAccountId;
  if (!disputedFunds) {
    throw new PspAutomationError(
      `disputed-funds clearing account is not configured; set it in Company Settings → Payment Providers for ${ctx.attempt.provider}`,
    );
  }
  const reason = `Provider dispute ${providerRef} for ${ctx.receipt!.document_number}`;
  const reversalId = await reversePaymentForReturn(
    ctx.receipt!.id,
    orgId,
    reason,
    PSP_AUTOMATION_SYSTEM_ACTOR_ID,
  );
  const documents = [reversalId];
  const remainder = fromUnits(toUnits(ctx.receipt!.total) - toUnits(disputeAmount));
  if (cmp(remainder, "0") > 0) {
    const custom = ctx.receipt!.custom as { feeAmount?: string; feeIncomeAccountId?: string };
    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance::text from documents where id = ${ctx.invoice.id} and org_id = ${orgId}
    `)).rows[0];
    const purpose = `PSP dispute remainder for ${providerRef}`;
    const reused = await findPostedPurposeReceipt(orgId, purpose);
    const remainderId = reused ?? (await postAppliedReceipt(orgId, {
      partyId: ctx.link.party_id,
      bankAccountId: ctx.bankAccountId,
      subsidiaryId: ctx.link.subsidiary_id,
      currency: ctx.receipt!.currency,
      invoiceId: ctx.invoice.id,
      invoiceOpenBalance: invoice?.open_balance ?? "0",
      amount: remainder,
      feeAmount: typeof custom.feeAmount === "string" ? custom.feeAmount : "0",
      feeIncomeAccountId: typeof custom.feeIncomeAccountId === "string" ? custom.feeIncomeAccountId : null,
      memo: purpose,
      referenceNumber: `psp-dispute:${providerRef.slice(0, 12)}`,
    })).receiptId;
    const issuedGated = !reused && (await db.execute<{ status: string }>(sql`
      select status from documents where id = ${remainderId} and org_id = ${orgId}
    `)).rows[0]?.status !== "posted";
    if (issuedGated) return { documents, holdId: "", gated: true };
    documents.push(remainderId);
  }
  const holdPurpose = `PSP dispute hold ${providerRef}`;
  const reusedHold = await findPostedPurposeReceipt(orgId, holdPurpose);
  const issuedHold = reusedHold
    ? { receiptId: reusedHold, gated: false }
    : await postUnappliedReceipt(orgId, {
      partyId: ctx.link.party_id,
      bankAccountId: disputedFunds,
      subsidiaryId: ctx.link.subsidiary_id,
      currency: ctx.receipt!.currency,
      total: disputeAmount,
      memo: holdPurpose,
      referenceNumber: `psp-dispute:${providerRef.slice(0, 12)}`,
      controlAccountId: await openItemAccount(orgId, { documentId: ctx.invoice.id }),
    });
  if (issuedHold.gated) return { documents, holdId: issuedHold.receiptId, gated: true };
  const holdId = issuedHold.receiptId;
  documents.push(holdId);
  return { documents, holdId, gated: false };
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

function asDocIds(documents: unknown): string[] {
  return Array.isArray(documents) ? documents.filter((d): d is string => typeof d === "string") : [];
}

/** Won and lost transitions, shared by live events and review approvals. */
async function transitionDisputeOutcome(
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
        provider: event.provider, providerEventId: event.providerEventId, kind: "dispute",
        status: "pending_review", attemptId: event.attemptId, receiptDocumentId: ctx?.receipt?.id ?? null,
        invoiceDocumentId: ctx?.invoice.id ?? null, currency: dispute.currency, amount: dispute.amount,
        feeAmount: "0", providerRef: dispute.id, reason: null,
      });
      return parkDisputeForReview(orgId, id, dispute.state === "won" ? "dispute-won" : "dispute-lost",
        { providerEventId: event.providerEventId, dispute },
        `dispute ${dispute.id} (${dispute.state}) arrived with no hold and no posted receipt; approve once confirmed`);
    }
    const { id } = await insertDisputeRow(orgId, {
      provider: event.provider, providerEventId: event.providerEventId, kind: "dispute",
      status: "pending_review", attemptId: event.attemptId, receiptDocumentId: ctx.receipt.id,
      invoiceDocumentId: ctx.invoice.id, currency: dispute.currency, amount: dispute.amount,
      feeAmount: "0", providerRef: dispute.id, reason: null,
    });
    if (dispute.state === "won") {
      await transitionDisputeRow(orgId, id, "won", [], "no hold on file; receipt stands");
      return { status: "posted", disputeId: id, documents: [] };
    }
    return runDisputeLost(orgId, id, event, ctx, true);
  }
  if (existing.status !== "opened") {
    const { id } = existing;
    if (dispute.state === "won") {
      await transitionDisputeRow(orgId, id, "won", asDocIds(existing.documents_posted), "no open hold; receipt stands");
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
  const holdId = docs.find((id) => row.receipt_document_id !== id) ?? docs[docs.length - 1];
  if (!ctx || !holdId) {
    return parkDisputeForReview(orgId, disputeId, "dispute-won",
      { providerEventId: event.providerEventId, dispute: event.dispute },
      `dispute ${event.dispute.id} was won but the hold cannot be resolved; approve once the hold receipt is confirmed`);
  }
  const reversalId = await reversePaymentForReturn(holdId, orgId, `Dispute ${event.dispute.id} won; hold released`, PSP_AUTOMATION_SYSTEM_ACTOR_ID);
  const purpose = `PSP dispute re-collection ${event.dispute.id}`;
  const reused = await findPostedPurposeReceipt(orgId, purpose);
  const recollected = reused ?? (await postAppliedReceipt(orgId, {
    partyId: ctx.link.party_id,
    bankAccountId: ctx.bankAccountId,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: row.currency,
    invoiceId: row.invoice_document_id ?? ctx.invoice.id,
    invoiceOpenBalance: ctx.invoice.open_balance,
    amount: row.amount,
    feeAmount: "0",
    feeIncomeAccountId: null,
    memo: purpose,
    referenceNumber: `psp-dispute:${event.dispute.id.slice(0, 12)}`,
  })).receiptId;
  const relinked = (await db.execute(sql`
    update payment_attempts set status = 'succeeded', payment_document_id = ${recollected}, updated_at = now()
     where id = ${ctx.attempt.id} and org_id = ${orgId}
  `));
  if ((relinked.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("payment attempt could not be pointed at its re-collected receipt");
  }
  await transitionDisputeRow(orgId, disputeId, "won", [...docs, reversalId, recollected], null);
  return { status: "posted", disputeId, documents: [...docs, reversalId, recollected] };
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
    return parkDisputeForReview(orgId, disputeId, "dispute-lost",
      { providerEventId: event.providerEventId, dispute: event.dispute },
      `dispute ${event.dispute.id} was lost with no receipt context; approve once confirmed`);
  }
  let holdId = docs.length > 0 ? docs[docs.length - 1]! : null;
  let documents = [...docs];
  if (compressed || !holdId) {
    // Lost with no hold on file: run the hold first so the write-off below
    // sees the same shape as a normally aged dispute.
    let held: { documents: string[]; holdId: string; gated: boolean };
    try {
      held = await openDisputeHold(orgId, ctx, row.amount, event.dispute.id);
    } catch (error) {
      if (error instanceof PspAutomationError) {
        return parkDisputeForReview(orgId, disputeId, "dispute-lost",
          { providerEventId: event.providerEventId, dispute: event.dispute }, error.message);
      }
      throw error;
    }
    if (held.gated) {
      return parkDisputeForReview(orgId, disputeId, "dispute-lost",
        { providerEventId: event.providerEventId, dispute: event.dispute },
        `replacement receipt for the undisputed remainder needs approval before the loss can post`);
    }
    holdId = held.holdId;
    documents = [...documents, ...held.documents];
    await transitionDisputeRow(orgId, disputeId, "opened", documents, compressed ? "hold compressed from the lost event" : null);
  }
  const lossAccount = ctx.disputeAccounts.chargebackLossAccountId;
  if (!lossAccount) {
    return parkDisputeForReview(orgId, disputeId, "dispute-lost",
      { providerEventId: event.providerEventId, dispute: event.dispute },
      `chargeback loss account is not configured; set it in Company Settings → Payment Providers for ${ctx.attempt.provider}`);
  }
  if (ctx.disputeAccounts.disputeFeeAccountId === null && cmp(eventFee(event), "0") > 0) {
    return parkDisputeForReview(orgId, disputeId, "dispute-lost",
      { providerEventId: event.providerEventId, dispute: event.dispute },
      `dispute fee account is not configured; set it in Company Settings → Payment Providers for ${ctx.attempt.provider}`);
  }
  // Apply the held credit to the invoice: the customer owes nothing — the
  // provider took the money — so the invoice settles from the hold.
  const invoice = (await db.execute<{ id: string; open_balance: string }>(sql`
    select id, open_balance::text from documents where id = ${row.invoice_document_id ?? ctx.invoice.id} and org_id = ${orgId}
  `)).rows[0];
  if (!invoice) throw new PspAutomationError("invoice is not in this organization");
  const holdLine = (await db.execute<{ id: string }>(sql`
    select jl.id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where jl.org_id = ${orgId} and je.source_document_id = ${holdId} and jl.is_open_item
     limit 1
  `)).rows[0];
  if (!holdLine) throw new PspAutomationError("dispute hold posted without an open item");
  const invoiceItems = await openItemsForParty(ctx.link.party_id, "ar", orgId);
  const invoiceItem = invoiceItems.find((i) => i.documentId === invoice.id);
  const applied = cmp(row.amount, invoice.open_balance) < 0 ? row.amount : invoice.open_balance;
  if (cmp(applied, "0") > 0 && invoiceItem) {
    // Convergent retry: an existing application for these endpoints settles
    // the run without a second write.
    const settled = (await db.execute<{ id: string }>(sql`
      select id from applications
       where org_id = ${orgId} and from_line_id = ${holdLine.id} and to_line_id = ${invoiceItem.lineId}
         and unapplied_at is null
    `)).rows[0];
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
  const periodId = await periodForDate(orgId, postingDate);
  if (!periodId) throw new PspAutomationError(`no open accounting period for ${postingDate}`);
  await assertPeriodModulesOpen(db, {
    orgId,
    periodId,
    bookId,
    subsidiaryIds: [ctx.link.subsidiary_id],
    modules: ["banking"],
  });
  const fee = eventFee(event);
  // A dispute in a currency other than the subsidiary's functional currency
  // clears its hold at the rate the hold receipt posted at (the posting
  // kernel stamps that rate on the hold document). Converting at that one
  // rate clears the disputed-funds balance to exactly zero in both
  // currencies, and the rate and its source travel on the entry as evidence.
  const holdBasis = (await db.execute<{ currency: string; fx_rate: string; functional: string }>(sql`
    select d.currency, d.fx_rate::text as fx_rate, s.base_currency as functional
      from documents d
      join subsidiaries s on s.id = ${ctx.link.subsidiary_id} and s.org_id = d.org_id
     where d.id = ${holdId} and d.org_id = ${orgId}
  `)).rows[0];
  if (!holdBasis) throw new PspAutomationError("dispute hold receipt is not in this organization");
  if (holdBasis.currency.toUpperCase() !== row.currency.toUpperCase()) {
    throw new PspAutomationError(
      `dispute ${event.dispute.id} is in ${row.currency} but its hold receipt is in ${holdBasis.currency}; review the hold before recording the loss`,
    );
  }
  const foreign = row.currency.toUpperCase() !== holdBasis.functional.toUpperCase();
  const holdRate = holdBasis.fx_rate;
  const leg = (accountId: string, txn: string, credit: boolean, memo: string) => {
    if (!foreign) return { accountId, amount: credit ? neg(txn) : txn, currency: row.currency, memo };
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
      ? { custom: { fxEvidence: { rate: holdRate, source: "dispute_hold_receipt", sourceDocumentId: holdId, currency: row.currency, functionalCurrency: holdBasis.functional } } }
      : {}),
    lines: [
      leg(lossAccount, applied, false, "Chargeback loss"),
      ...(cmp(fee, "0") > 0 ? [leg(ctx.disputeAccounts.disputeFeeAccountId!, fee, false, "Provider dispute fee")] : []),
      leg(ctx.disputeAccounts.disputedFundsAccountId!, applied, true, "Clear dispute hold"),
      ...(cmp(fee, "0") > 0 ? [leg(ctx.bankAccountId, fee, true, "Dispute fee taken")] : []),
    ],
  });
  await transitionDisputeRow(
    orgId,
    disputeId,
    "lost",
    [...documents, posted.entryId],
    cmp(applied, row.amount) < 0
      ? `invoice owed ${invoice.open_balance}; ${fromUnits(toUnits(row.amount) - toUnits(applied))} of the hold stays open for the operator`
      : null,
  );
  return { status: "posted", disputeId, documents: [...documents, posted.entryId] };
}

function eventFee(event: ProviderDisputeEvent): string {
  const raw = event.raw as Record<string, unknown> | undefined;
  const fee = raw?.feeAmount ?? raw?.fee_amount;
  if (typeof fee === "string" && /^\d+(\.\d{1,4})?$/.test(fee.trim())) return fromUnits(toUnits(fee.trim()));
  return "0";
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
