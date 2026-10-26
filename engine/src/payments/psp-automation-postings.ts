import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, neg, toUnits } from "../money/money.ts";
import {
  carryingAmountForSettlement,
  realizedFxControlAdjustment,
  sameCurrencyAllocation,
  validateAllocationInputs,
  validateSettlementEvidence,
} from "./settlement-policy.ts";
import { writePaymentApplications } from "./payment-application-writes.ts";
import { paymentBookId, paymentControlDeps } from "./payment-accounts.ts";
import { assertNoForeignRunReservation } from "./payment-queries.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import {
  stageReturnReceipt,
  postReturnReceipt,
  returnFinancialStage,
} from "./psp-return-stages.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import { applyStandaloneCredits } from "./credit-settlement.ts";
import { lockApplicationEvidence } from "../records/application-lock.ts";
import {
  PSP_AUTOMATION_SYSTEM_ACTOR_ID,
  PspAutomationError,
  type AutomationContext,
} from "./psp-automation-context.ts";

/** Ledger effects of provider refunds and disputes: unapplied and applied receipts, credit-based refunds, remainder reissue and open-item holds. */

/** The receivable account an open item sits on: by its journal line, or by
 *  a posted document's own open-item leg. Fails closed when none exists. */
async function openItemAccount(
  orgId: string,
  target: { lineId: string } | { documentId: string },
): Promise<string> {
  const row = (
    await db.execute<{ account_id: string }>(
      "lineId" in target
        ? sql`select account_id from journal_lines where org_id = ${orgId} and id = ${target.lineId} and is_open_item`
        : sql`
      select jl.account_id
        from documents d
        join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id and jl.is_open_item
       where d.org_id = ${orgId} and d.id = ${target.documentId}
       order by jl.line_number
       limit 1`,
      "objects",
    )
  )[0];
  if (!row) throw new PspAutomationError("the settled document has no posted receivable open item");
  return row.account_id;
}

/** Stage the unrefunded receipt before reversing the original payment. */
export async function voidAndReissueRemainder(
  orgId: string,
  ctx: AutomationContext,
  receiptTotal: string,
  refundedAmount: string,
  reason: string,
  disputeId: string,
): Promise<
  | { reversalId: string; remainderId: string | null; gated: false }
  | { reversalId: null; remainderId: string; gated: true }
> {
  const remainder = fromUnits(toUnits(receiptTotal) - toUnits(refundedAmount));
  if (cmp(remainder, "0") <= 0) {
    const reversalId = await returnFinancialStage(() =>
      reversePaymentForReturn(ctx.receipt!.id, orgId, reason, PSP_AUTOMATION_SYSTEM_ACTOR_ID),
    );
    return { reversalId, remainderId: null, gated: false };
  }
  const custom = ctx.receipt!.custom as { feeAmount?: string; feeIncomeAccountId?: string };
  const issued = await stageReturnReceipt(orgId, {
    disputeId,
    phase: "refund",
    role: "remainder",
    sourceReceiptId: ctx.receipt!.id,
    partyId: ctx.link.party_id,
    bankAccountId: ctx.bankAccountId,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: ctx.receipt!.currency,
    amount: remainder,
    feeAmount: custom.feeAmount ?? "0",
    feeIncomeAccountId: custom.feeIncomeAccountId ?? null,
    controlAccountId: await openItemAccount(orgId, { documentId: ctx.invoice.id }),
    applyInvoiceId: ctx.invoice.id,
    memo: `Provider refund remainder ${disputeId}`,
  });
  if (!issued.ready) return { reversalId: null, remainderId: issued.receiptId, gated: true };
  return returnFinancialStage(async () => {
    const reversalId = await reversePaymentForReturn(
      ctx.receipt!.id,
      orgId,
      reason,
      PSP_AUTOMATION_SYSTEM_ACTOR_ID,
    );
    await postReturnReceipt(orgId, issued.receiptId);
    return { reversalId, remainderId: issued.receiptId, gated: false as const };
  });
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
  disputeId: string,
): Promise<{ refundId: string; gated: boolean }> {
  const issued = await stageReturnReceipt(orgId, {
    disputeId,
    phase: "refund",
    role: "credit-refund",
    sourceReceiptId: ctx.receipt!.id,
    partyId: ctx.link.party_id,
    bankAccountId: ctx.bankAccountId,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: ctx.receipt!.currency,
    amount: neg(refundedAmount),
    memo: `Provider refund against credit ${disputeId}`,
    controlAccountId: await openItemAccount(orgId, { lineId: creditLineId }),
  });
  if (!issued.ready) return { refundId: issued.receiptId, gated: true };
  return returnFinancialStage(async () => {
    const refundId = issued.receiptId;
    await postReturnReceipt(orgId, refundId);
    const refundLine = (
      await db.execute<{ id: string }>(
        sql`
      select jl.id
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${orgId} and je.source_document_id = ${refundId} and jl.is_open_item
       limit 1
    `,
        "objects",
      )
    )[0];
    if (!refundLine) throw new PspAutomationError("refund receipt posted without an open item");
    // Convergent retry: an existing application for these endpoints settles the
    // run without a second write.
    const settled = (
      await db.execute<{ id: string }>(
        sql`
      select id from applications
       where org_id = ${orgId} and from_line_id = ${creditLineId} and to_line_id = ${refundLine.id}
         and unapplied_at is null
    `,
        "objects",
      )
    )[0];
    if (!settled) {
      await applyStandaloneCredits(
        orgId,
        PSP_AUTOMATION_SYSTEM_ACTOR_ID,
        {
          partyId: ctx.link.party_id,
          side: "ar",
          appliedOn: await businessToday(orgId),
          credits: [
            {
              fromLineId: creditLineId,
              toLineId: refundLine.id,
              amount: refundedAmount,
              sourceDocumentId: creditDocumentId,
            },
          ],
          idempotencyKey: randomUUID(),
        },
        null,
      );
    }
    return { refundId, gated: false };
  });
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
  const endpoints = await db.execute<{
    id: string;
    currency: string;
    amount: string;
    txn_amount: string;
    account_id: string;
    party_id: string | null;
    subsidiary_id: string;
    book_id: string;
    status: string;
    is_open_item: boolean;
    functional_currency: string;
    source_document_id: string | null;
    document_number: string;
    document_kind: string;
    open_base: string;
    open_transaction: string;
  }>(
    sql`
    select jl.id, jl.currency, jl.amount::text, jl.txn_amount::text, jl.account_id, jl.party_id, jl.subsidiary_id,
           je.book_id, je.status, jl.is_open_item, s.base_currency as functional_currency,
           je.source_document_id, d.document_number, d.kind as document_kind,
           (abs(jl.amount) - coalesce(ap.used_base, 0))::text as open_base,
           (abs(jl.txn_amount) - coalesce(ap.used_transaction, 0))::text as open_transaction
      from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      join documents d on d.id = je.source_document_id and d.org_id = je.org_id
      join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
      left join lateral (
        select sum(case when a.from_line_id = jl.id then a.source_amount else a.amount end) as used_base,
               sum(case when a.from_line_id = jl.id then a.source_transaction_amount else a.target_transaction_amount end) as used_transaction
          from applications a where a.org_id = jl.org_id and a.unapplied_at is null
           and (a.from_line_id = jl.id or a.to_line_id = jl.id)
      ) ap on true
     where jl.org_id = ${orgId} and (jl.id = ${opts.fromLineId} or jl.id = ${opts.toLineId})
  `,
    "objects",
  );
  const from = endpoints.find((row) => row.id === opts.fromLineId);
  const to = endpoints.find((row) => row.id === opts.toLineId);
  if (!from || !to) {
    throw new PspAutomationError(
      "a receipt or invoice line disappeared while settling; retry the event",
    );
  }
  if (
    from.currency.toUpperCase() !== opts.currency.toUpperCase() ||
    to.currency.toUpperCase() !== opts.currency.toUpperCase()
  ) {
    throw new PspAutomationError(
      `settlement needs both lines in ${opts.currency}; re-check the receipt and invoice currencies`,
    );
  }
  const bookId = await paymentBookId(orgId);
  if (
    !from.party_id ||
    !from.source_document_id ||
    from.status !== "posted" ||
    to.status !== "posted" ||
    !from.is_open_item ||
    !to.is_open_item ||
    cmp(from.amount, "0") >= 0 ||
    cmp(to.amount, "0") <= 0 ||
    from.document_kind !== "customer_payment" ||
    to.document_kind !== "customer_invoice" ||
    from.account_id !== to.account_id ||
    from.party_id !== to.party_id ||
    from.subsidiary_id !== to.subsidiary_id ||
    from.book_id !== to.book_id ||
    from.book_id !== bookId
  ) {
    throw new PspAutomationError(
      "Dispute settlement requires a posted receipt and invoice on the same customer, control account, legal entity and primary book.",
    );
  }
  await assertNoForeignRunReservation(orgId, [from.id, to.id], from.source_document_id);
  const allocation = sameCurrencyAllocation(to.id, opts.amount);
  validateAllocationInputs([allocation]);
  validateSettlementEvidence(allocation, from.currency, to.currency);
  const sourceBase = carryingAmountForSettlement(
    from.open_base,
    from.open_transaction,
    allocation.sourceTransactionAmount,
  );
  const targetBase = carryingAmountForSettlement(
    to.open_base,
    to.open_transaction,
    allocation.targetTransactionAmount,
  );
  const period = await resolveCoveringPeriod(db, orgId, appliedOn);
  if (!period)
    throw new PspAutomationError(`No accounting period covers dispute settlement on ${appliedOn}.`);
  await assertPeriodModulesOpen(db, {
    orgId,
    periodId: period.id,
    bookId,
    subsidiaryIds: [from.subsidiary_id],
    modules: ["banking"],
  });
  const deps = await paymentControlDeps(orgId);
  const [applicationId] = await writePaymentApplications({
    orgId,
    sourceDocumentId: from.source_document_id,
    documentNumber: `${from.document_number}-DISPUTE`,
    bookId,
    subsidiaryId: from.subsidiary_id,
    controlAccountId: from.account_id,
    partyId: from.party_id,
    functionalCurrency: from.functional_currency,
    postingDate: appliedOn,
    periodId: period.id,
    actorId: PSP_AUTOMATION_SYSTEM_ACTOR_ID,
    gainLossAccountId: deps.control.fxRealizedGainLoss,
    fxIdempotencyKey: `psp-dispute-application:${orgId}:${from.id}:${to.id}`,
    applications: [
      {
        fromLineId: from.id,
        toLineId: to.id,
        amount: targetBase,
        sourceAmount: sourceBase,
        sourceTransactionAmount: opts.amount,
        sourceTransactionCurrency: from.currency,
        targetTransactionAmount: opts.amount,
        targetTransactionCurrency: to.currency,
        settlementRate: allocation.settlementRate,
        settlementRateSource: allocation.settlementRateSource,
        settlementRateReference: opts.reference,
        settlementFxRateId: null,
        appliedOn,
        controlAdjustment: realizedFxControlAdjustment(neg(sourceBase), targetBase),
      },
    ],
  });
  if (!applicationId) throw new PspAutomationError("The dispute settlement could not be recorded.");
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'applications', ${applicationId}, 'insert',
            ${JSON.stringify({ mode: "payment_applied_without_cash", source: "payments.psp-refund-automation", after: { fromLineId: opts.fromLineId, toLineId: opts.toLineId, amount: targetBase, sourceAmount: sourceBase, transactionAmount: opts.amount, currency: opts.currency, appliedOn } })}::jsonb,
            ${PSP_AUTOMATION_SYSTEM_ACTOR_ID})
  `);
  return applicationId;
}

/** An open customer credit memo covering the refunded amount, if the
 *  operator issued one before the provider refund arrived. */
export async function openCreditCovering(
  orgId: string,
  partyId: string,
  subsidiaryId: string,
  currency: string,
  refundedAmount: string,
): Promise<{ documentId: string; lineId: string; open: string } | null> {
  const credits = await db.execute<{ id: string; open_balance: string }>(
    sql`
    select id, open_balance::text
      from documents
     where org_id = ${orgId} and kind = 'customer_credit' and status = 'posted'
       and party_id = ${partyId} and currency = ${currency}
       and subsidiary_id = ${subsidiaryId}
       and open_balance::numeric >= ${refundedAmount}::numeric
     order by document_date asc limit 1
  `,
    "objects",
  );
  const credit = credits[0];
  if (!credit) return null;
  const line = (
    await db.execute<{ id: string; open: string }>(
      sql`
    select jl.id, (abs(jl.amount) - coalesce(sum(a.source_amount), 0))::text as open
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      left join applications a on a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
     where jl.org_id = ${orgId} and je.source_document_id = ${credit.id} and jl.is_open_item
     group by jl.id having (abs(jl.amount) - coalesce(sum(a.source_amount), 0)) >= ${refundedAmount}::numeric
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!line) return null;
  return { documentId: credit.id, lineId: line.id, open: line.open };
}

/** Mark the attempt's collection state after automation posts. The zero-row
 *  check fails the run instead of reporting a posted refund the attempt
 *  never reflects. */
export async function setAttemptRefunded(
  orgId: string,
  attemptId: string,
  receiptId: string | null,
): Promise<void> {
  const updated = await db.execute<never>(sql`
    update payment_attempts set status = 'refunded', updated_at = now()
     where id = ${attemptId} and org_id = ${orgId} and status in ('succeeded', 'initiated', 'refunded')
  `);
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PspAutomationError("payment attempt left the refundable state while posting");
  }
  if (receiptId !== null) {
    const relinked = await db.execute<never>(sql`
      update payment_attempts set payment_document_id = ${receiptId}, updated_at = now()
       where id = ${attemptId} and org_id = ${orgId}
    `);
    if ((relinked.rowCount ?? 0) !== 1) {
      throw new PspAutomationError(
        "payment attempt could not be relinked to its replacement receipt",
      );
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
  disputeId: string,
): Promise<{ documents: string[]; holdId: string; gated: boolean }> {
  const disputedFunds = ctx.disputeAccounts.disputedFundsAccountId;
  if (!disputedFunds)
    throw new PspAutomationError(
      `Disputed-funds clearing account is not configured; set it in Company Settings → Payment Providers for ${ctx.attempt.provider}.`,
    );
  const controlAccountId = await openItemAccount(orgId, { documentId: ctx.invoice.id });
  const shared = {
    disputeId,
    phase: "dispute-opened" as const,
    sourceReceiptId: ctx.receipt!.id,
    partyId: ctx.link.party_id,
    subsidiaryId: ctx.link.subsidiary_id,
    currency: ctx.receipt!.currency,
    controlAccountId,
  };
  const remainder = fromUnits(toUnits(ctx.receipt!.total) - toUnits(disputeAmount));
  const custom = ctx.receipt!.custom as { feeAmount?: string; feeIncomeAccountId?: string };
  const remaining =
    cmp(remainder, "0") > 0
      ? await stageReturnReceipt(orgId, {
          ...shared,
          role: "remainder",
          bankAccountId: ctx.bankAccountId,
          amount: remainder,
          feeAmount: custom.feeAmount ?? "0",
          feeIncomeAccountId: custom.feeIncomeAccountId ?? null,
          applyInvoiceId: ctx.invoice.id,
          memo: `Provider dispute remainder ${disputeId}`,
        })
      : null;
  const held = await stageReturnReceipt(orgId, {
    ...shared,
    role: "hold",
    bankAccountId: disputedFunds,
    amount: disputeAmount,
    memo: `Provider dispute hold ${providerRef}`,
  });
  if (!held.ready || (remaining && !remaining.ready))
    return { documents: [], holdId: held.receiptId, gated: true };
  return returnFinancialStage(async () => {
    const reversalId = await reversePaymentForReturn(
      ctx.receipt!.id,
      orgId,
      `Provider dispute ${providerRef} for ${ctx.receipt!.document_number}`,
      PSP_AUTOMATION_SYSTEM_ACTOR_ID,
    );
    if (remaining) await postReturnReceipt(orgId, remaining.receiptId);
    await postReturnReceipt(orgId, held.receiptId);
    return {
      documents: [reversalId, ...(remaining ? [remaining.receiptId] : []), held.receiptId],
      holdId: held.receiptId,
      gated: false,
    };
  });
}
