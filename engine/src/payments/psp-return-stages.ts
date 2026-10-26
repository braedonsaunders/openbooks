import { sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { db, withTransactionSavepoint } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { businessToday } from "../platform/business-date.ts";
import { add, cmp, neg, toUnits } from "../money/money.ts";
import { submitAndReleaseIfUngated, withdrawDocumentSubmission } from "../flows/submit.ts";
import { withProviderReturnPosting } from "../payments-core/provider-return-posting.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentDocument } from "./payment-documents.ts";
import { paymentControlDeps } from "./payment-accounts.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { completePaymentPostingEffectsForReturn } from "./payment-return.ts";
import {
  persistPaymentMoney,
  sameCurrencyAllocation,
  type AllocationInput,
} from "./settlement-policy.ts";
import { disputeRow } from "./psp-automation-disputes.ts";
import { PspAutomationError, lockReturnReceiptAuthority } from "./psp-automation-context.ts";

export interface ReturnReceiptPlan {
  disputeId: string;
  phase: "refund" | "dispute-opened" | "dispute-won";
  role: "remainder" | "hold" | "credit-refund" | "recollection";
  sourceReceiptId: string;
  partyId: string;
  bankAccountId: string;
  controlAccountId: string;
  subsidiaryId: string;
  currency: string;
  amount: string;
  feeAmount?: string;
  feeIncomeAccountId?: string | null;
  applyInvoiceId?: string;
  memo: string;
}

type Stage = {
  plan: ReturnReceiptPlan;
  documentId: string;
  documentDate: string;
  allocations: AllocationInput[];
  onAccountAmount: string;
};
const financialReceiptEffects = new AsyncLocalStorage<Map<string, string>>();

function stages(history: unknown): Stage[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const stage = (entry as { returnStage?: Stage }).returnStage;
    return stage && isUuid(stage.documentId) && stage.plan && Array.isArray(stage.allocations)
      ? [stage]
      : [];
  });
}

export async function returnStageDocument(
  orgId: string,
  disputeId: string,
  phase: ReturnReceiptPlan["phase"],
  role: ReturnReceiptPlan["role"],
): Promise<string | null> {
  const row = await disputeRow(orgId, disputeId);
  return (
    stages(row.status_history).find(
      (stage) => stage.plan.phase === phase && stage.plan.role === role,
    )?.documentId ?? null
  );
}

/** Freeze the receipt's future allocation before approval. Only applications
 * owned by the receipt being reversed contribute to the restored balance. */
async function futureAllocation(
  orgId: string,
  plan: ReturnReceiptPlan,
): Promise<{ allocations: AllocationInput[]; onAccountAmount: string }> {
  const available = add(plan.amount, neg(plan.feeAmount ?? "0"));
  if (!plan.applyInvoiceId || cmp(available, "0") <= 0)
    return { allocations: [], onAccountAmount: available };
  const invoice = (
    await db.execute<{
      id: string;
      currency: string;
      party_id: string | null;
      subsidiary_id: string | null;
      open_balance: string;
      line_id: string;
      restored: string;
    }>(
      sql`
    select d.id, d.currency, d.party_id, coalesce(d.subsidiary_id, invoice_entry.subsidiary_id) as subsidiary_id, d.open_balance::text as open_balance,
           jl.id as line_id,
           coalesce((select sum(a.target_transaction_amount) from applications a
             join journal_lines source on source.id = a.from_line_id and source.org_id = a.org_id
             join journal_entries entry on entry.id = source.entry_id and entry.org_id = source.org_id
            where a.org_id = d.org_id and a.to_line_id = jl.id and a.unapplied_at is null
              and entry.source_document_id = ${plan.sourceReceiptId}), 0)::text as restored
      from documents d join journal_entries invoice_entry on invoice_entry.org_id = d.org_id and invoice_entry.id = d.posted_entry_id
      join journal_lines jl on jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
     where d.org_id = ${orgId} and d.id = ${plan.applyInvoiceId} and d.status = 'posted'
     order by jl.line_number limit 1 for share of d
  `,
      "objects",
    )
  )[0];
  if (
    !invoice ||
    invoice.currency !== plan.currency ||
    invoice.party_id !== plan.partyId ||
    invoice.subsidiary_id !== plan.subsidiaryId
  ) {
    throw new PspAutomationError(
      "The return's invoice no longer matches its customer, currency and legal entity; review the provider return before resuming.",
    );
  }
  const restoredOpen = add(invoice.open_balance, invoice.restored);
  const amount = cmp(available, restoredOpen) < 0 ? available : restoredOpen;
  return {
    allocations: cmp(amount, "0") > 0 ? [sameCurrencyAllocation(invoice.line_id, amount)] : [],
    onAccountAmount: add(available, neg(amount)),
  };
}

/** Persist approval subjects before the financial savepoint. A gate preserves
 * the same receipt identity while the original payment remains posted. */
export async function stageReturnReceipt(
  orgId: string,
  plan: ReturnReceiptPlan,
): Promise<{ receiptId: string; ready: boolean }> {
  const { actorId, allowedSubsidiaryIds } = await lockReturnReceiptAuthority(orgId, plan);
  const row = await disputeRow(orgId, plan.disputeId);
  let stage = stages(row.status_history).find(
    (item) => item.plan.phase === plan.phase && item.plan.role === plan.role,
  );
  if (stage && canonicalJson(stage.plan) !== canonicalJson(plan)) {
    throw new PspAutomationError(
      "The provider return changed after its receipt was submitted. Reject the stale review and reconcile the newer provider event before resuming.",
    );
  }
  if (!stage) {
    const shaped = await futureAllocation(orgId, plan);
    const documentDate = await businessToday(orgId);
    const payment = await createPaymentDocument({
      orgId,
      kind: "customer_payment",
      createdBy: actorId,
      allowedSubsidiaryIds,
      partyId: plan.partyId,
      bankAccountId: plan.bankAccountId,
      subsidiaryId: plan.subsidiaryId,
      currency: plan.currency,
      documentDate,
      memo: plan.memo,
    });
    stage = { plan, documentId: payment.id, documentDate, ...shaped };
    const custom = {
      bankAccountId: plan.bankAccountId,
      controlAccountId: plan.controlAccountId,
      allocations: stage.allocations,
      onAccountAmount: stage.onAccountAmount,
      feeAmount: plan.feeAmount ?? "0",
      feeIncomeAccountId: plan.feeIncomeAccountId ?? null,
      providerReturn: {
        disputeId: plan.disputeId,
        phase: plan.phase,
        role: plan.role,
      },
    };
    const written = (
      await db.execute<{ id: string }>(
        sql`
      update documents set custom = ${JSON.stringify(custom)}::jsonb,
        subtotal = ${plan.amount}, tax_total = '0', total = ${plan.amount}, updated_at = now()
       where id = ${payment.id} and org_id = ${orgId} and status = 'draft' returning id
    `,
        "objects",
      )
    )[0];
    if (!written) throw new PspAutomationError("The return receipt could not be prepared.");
    await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${orgId}, ${payment.id}, 1, ${plan.bankAccountId}, '1', ${plan.amount}, ${plan.amount}, '0')`);
    const saved = await db.execute<never>(sql`update payment_disputes
      set status_history = status_history || ${JSON.stringify({ at: new Date().toISOString(), returnStage: stage })}::jsonb, updated_at = now()
      where org_id = ${orgId} and id = ${plan.disputeId}`);
    if (saved.rowCount !== 1)
      throw new PspAutomationError("The return's receipt identity could not be recorded.");
    await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'documents', ${payment.id}, 'update', ${JSON.stringify({ mode: "provider_return_receipt", after: { ...plan, ...shaped } })}::jsonb, ${actorId})`);
  }
  const receipt = (
    await db.execute<{
      status: string;
      total: string;
      subtotal: string;
      tax_total: string;
      currency: string;
      document_date: string;
      posting_date: string | null;
      posting_period_id: string | null;
      subsidiary_id: string | null;
      party_id: string | null;
      custom: Record<string, unknown> | null;
    }>(
      sql`
    select status, total::text as total, subtotal::text as subtotal, tax_total::text as tax_total, currency,
           document_date::text, posting_date::text, posting_period_id, subsidiary_id, party_id, custom from documents
     where org_id = ${orgId} and id = ${stage.documentId} for update
  `,
      "objects",
    )
  )[0];
  const snapshot = receipt?.custom ?? {};
  if (
    !receipt ||
    toUnits(receipt.total) !== toUnits(plan.amount) ||
    toUnits(receipt.subtotal) !== toUnits(plan.amount) ||
    toUnits(receipt.tax_total) !== 0n ||
    receipt.currency !== plan.currency ||
    receipt.document_date !== stage.documentDate ||
    receipt.posting_date !== null ||
    receipt.posting_period_id !== null ||
    receipt.subsidiary_id !== plan.subsidiaryId ||
    receipt.party_id !== plan.partyId ||
    snapshot.bankAccountId !== plan.bankAccountId ||
    snapshot.controlAccountId !== plan.controlAccountId ||
    canonicalJson(snapshot.allocations ?? []) !== canonicalJson(stage.allocations) ||
    persistPaymentMoney(snapshot.onAccountAmount ?? "0", "return on-account amount") !==
      toUnits(stage.onAccountAmount) ||
    persistPaymentMoney(snapshot.feeAmount ?? "0", "return fee amount") !==
      toUnits(plan.feeAmount ?? "0") ||
    (snapshot.feeIncomeAccountId ?? null) !== (plan.feeIncomeAccountId ?? null) ||
    canonicalJson(snapshot.providerReturn ?? null) !==
      canonicalJson({
        disputeId: plan.disputeId,
        phase: plan.phase,
        role: plan.role,
      })
  ) {
    throw new PspAutomationError(
      "The staged receipt differs from its approved return plan; review its draft and the provider event before resuming.",
    );
  }
  const lines = await db.execute<{
    account_id: string | null;
    amount: string;
    quantity: string;
    unit_price: string;
    tax_amount: string;
  }>(
    sql`
    select account_id, amount::text, quantity::text, unit_price::text, tax_amount::text from document_lines
     where org_id = ${orgId} and document_id = ${stage.documentId} order by line_number for update
  `,
    "objects",
  );
  if (
    lines.length !== 1 ||
    lines[0]!.account_id !== plan.bankAccountId ||
    toUnits(lines[0]!.amount) !== toUnits(plan.amount) ||
    toUnits(lines[0]!.unit_price) !== toUnits(plan.amount) ||
    toUnits(lines[0]!.quantity) !== toUnits("1") ||
    toUnits(lines[0]!.tax_amount) !== 0n
  ) {
    throw new PspAutomationError(
      "The staged receipt's bank line changed; review the return before resuming.",
    );
  }
  if (receipt.status === "draft") {
    const result = await submitAndReleaseIfUngated("customer_payment", stage.documentId, actorId, {
      source: "api",
    });
    if (result.flowError)
      throw new PspAutomationError(
        `Return receipt approval could not be routed: ${result.flowError}`,
      );
    return { receiptId: stage.documentId, ready: !result.gated };
  }
  if (receipt.status !== "approved" && receipt.status !== "pending_approval") {
    throw new PspAutomationError(
      `The staged receipt is ${receipt.status}; reconcile the return before resuming its review.`,
    );
  }
  return { receiptId: stage.documentId, ready: receipt.status === "approved" };
}

export async function postReturnReceipt(orgId: string, receiptId: string): Promise<string> {
  const receipt = (
    await db.execute<{
      custom: { providerReturn?: { disputeId?: string } };
    }>(
      sql`
    select custom from documents where org_id = ${orgId} and id = ${receiptId}`,
      "objects",
    )
  )[0];
  const disputeId = receipt?.custom?.providerReturn?.disputeId;
  if (!isUuid(disputeId))
    throw new PspAutomationError("The receipt has no valid provider return identity.");
  const row = await disputeRow(orgId, disputeId);
  if (row.status !== "pending_review" && row.status !== "opened")
    throw new PspAutomationError("The provider return no longer admits receipt posting.");
  const stage = stages(row.status_history).find((item) => item.documentId === receiptId);
  if (!stage || !(await stageReturnReceipt(orgId, stage.plan)).ready)
    throw new PspAutomationError("Approve the staged return receipt before resuming its review.");
  const { actorId } = await lockReturnReceiptAuthority(orgId, stage.plan);
  const unit = financialReceiptEffects.getStore();
  if (!unit)
    throw new PspAutomationError(
      "Provider return receipts must post inside their native financial stage.",
    );
  const entryId = await withProviderReturnPosting(orgId, receiptId, async () => {
    // A credit-backed refund is a cash-out receipt with a debit open item.
    // The receipt kernel posts it; the parent command then applies the credit
    // through the native credit settlement service in the same savepoint.
    if (stage.plan.role === "credit-refund") {
      return postDocument(receiptId, await paymentControlDeps(orgId), {
        deferEffects: true,
        audit: { actorId, source: "api" },
      });
    }
    return (
      await postPaymentWithApplications(receiptId, undefined, actorId, "api", {
        deferEffects: true,
      })
    ).entryId;
  });
  unit.set(receiptId, orgId);
  return entryId;
}

/** A refused financial stage rolls back before its review is parked. Effects
 * drain only after the complete return accounting unit has settled its
 * applications and lifecycle. Nested refused stages contribute no receipts. */
export async function returnFinancialStage<T>(work: () => Promise<T>): Promise<T> {
  const parent = financialReceiptEffects.getStore();
  const unit = new Map<string, string>();
  const result = await withTransactionSavepoint(db, () =>
    financialReceiptEffects.run(unit, async () => {
      const result = await work();
      if (!parent) {
        for (const [documentId, orgId] of unit)
          await completePaymentPostingEffectsForReturn(orgId, documentId, {
            requireEvidence: true,
          });
      }
      return result;
    }),
  );
  // Admit nested receipts only after their savepoint has been released.
  if (parent) for (const [documentId, orgId] of unit) parent.set(documentId, orgId);
  return result;
}

export async function withdrawReturnReceipts(
  orgId: string,
  disputeId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const row = await disputeRow(orgId, disputeId);
  for (const stage of stages(row.status_history)) {
    const receipt = (
      await db.execute<{ status: string; subsidiary_id: string }>(
        sql`select status, subsidiary_id from documents where org_id = ${orgId} and id = ${stage.documentId} for update`,
        "objects",
      )
    )[0];
    if (!receipt || receipt.subsidiary_id !== stage.plan.subsidiaryId)
      throw new PspAutomationError(
        "The staged receipt's legal entity changed; reconcile it before rejecting the provider review.",
      );
    if (receipt?.status === "pending_approval") {
      await withdrawDocumentSubmission({
        orgId,
        documentId: stage.documentId,
        actorId,
        actorIsApprover: true,
        allowedSubsidiaryIds: null,
        reason,
      });
    }
  }
}
