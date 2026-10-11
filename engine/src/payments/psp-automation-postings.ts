import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, neg, toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { paymentControlDeps } from "./payment-accounts.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { applyStandaloneCredits } from "./credit-settlement.ts";
import { sameCurrencyAllocation, type AllocationInput } from "./settlement-policy.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { finalizePaymentAcceptanceForDocument } from "../payments-core/acceptance-effect.ts";
import { PSP_AUTOMATION_SYSTEM_ACTOR_ID, PspAutomationError, type AutomationContext } from "./psp-automation-context.ts";

/** Ledger effects of provider refunds and disputes: unapplied and applied receipts, credit-based refunds, remainder reissue and open-item holds. */

/** Total already refunded or held against one receipt through posted automation rows. */
export async function postedAgainstReceipt(orgId: string, receiptId: string): Promise<bigint> {
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
export async function findPostedPurposeReceipt(orgId: string, memo: string): Promise<string | null> {
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
export async function postAppliedReceipt(
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
export async function voidAndReissueRemainder(
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
export async function refundAgainstCredit(
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
export async function applyPaymentToOpenItem(
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
export async function openCreditCovering(
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
export async function setAttemptRefunded(orgId: string, attemptId: string, receiptId: string | null): Promise<void> {
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

/** Post the dispute hold: the receipt reverses (the invoice reopens) and the
 *  disputed funds re-post unapplied into the clearing account, so the hold
 *  is a visible balance while the outcome is unknown. */
export async function openDisputeHold(
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
