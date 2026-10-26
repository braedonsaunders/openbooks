/** Settlement of a completed acceptance attempt into a posted customer
 *  payment applied to the open item it collected. */
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { add, cmp, fromUnits, toUnits } from "../money/money.ts";
import { finalizePaymentAcceptanceForDocument } from "../payments-core/acceptance-effect.ts";
import { businessToday } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import {
  validateAcceptanceBankAccount,
  validateSurchargeIncomeAccount,
} from "./acceptance-surcharge.ts";
import {
  type AcceptanceProvider,
  PaymentAcceptanceError,
  type SettlementDiscrepancyEvidence,
} from "./acceptance-types.ts";
import { paymentControlDeps } from "./payment-accounts.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { type AllocationInput, sameCurrencyAllocation } from "./settlement-policy.ts";
import { sql } from "drizzle-orm";

/**
 * Persist normalized provider-vs-checkout evidence without advancing the
 * attempt. The caller returns the error through the tenant transaction so
 * both writes commit, then throws it at the outer webhook boundary.
 */
export async function recordSettlementDiscrepancy(
  orgId: string,
  attemptId: string,
  evidence: SettlementDiscrepancyEvidence,
  message: string,
): Promise<{ discrepancy: PaymentAcceptanceError }> {
  await db.execute(sql`
    update payment_attempts
       set event_payload = coalesce(event_payload, '{}'::jsonb)
                           || ${JSON.stringify({ settlementDiscrepancy: evidence })}::jsonb,
           updated_at = now()
     where id = ${attemptId} and org_id = ${orgId}
  `);
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${orgId}, 'payment_attempts', ${attemptId}, 'update',
      ${JSON.stringify({ after: { settlementDiscrepancy: evidence } })}::jsonb,
      null
    )
  `);
  return { discrepancy: new PaymentAcceptanceError(message) };
}

/**
 * Convert a paid attempt into a posted customer receipt: create the payment
 * document, auto-apply it to the link's invoice (capped at the current open
 * balance; any remainder stays on-account), attach the surcharge fee leg,
 * and post through the kernel. Idempotent via the attempt claim above plus
 * document-level resume: an interrupted settle reuses the reserved receipt
 * draft instead of minting another one.
 *
 * Returns "gated" when a tenant approval flow owns the receipt — the attempt
 * stays in its claimed non-initiated state and finalize completes the
 * bookkeeping when the approval flow eventually posts it.
 */
export async function settleAttempt(
  orgId: string,
  attemptId: string,
): Promise<"posted" | "gated" | { discrepancy: PaymentAcceptanceError }> {
  const rows = await db.execute<{
    id: string;
    provider: AcceptanceProvider;
    external_ref: string;
    amount: string | null;
    surcharge_amount: string | null;
    payment_document_id: string | null;
    event_payload: { feeIncomeAccountId?: string } | null;
    link_id: string;
    document_id: string;
    party_id: string;
    subsidiary_id: string;
    bank_account_id: string;
    currency: string;
    link_created_by: string | null;
  }>(
    sql`
    select a.id, a.provider, a.external_ref, coalesce(a.amount, l.amount) as amount,
           coalesce(a.surcharge_amount, l.surcharge_amount) as surcharge_amount,
           a.payment_document_id, a.event_payload,
           l.id as link_id, l.document_id, l.party_id, l.subsidiary_id, l.bank_account_id, l.currency, l.created_by as link_created_by
      from payment_attempts a
      join payment_links l on l.id = a.link_id and l.org_id = a.org_id
     where a.org_id = ${orgId} and a.id = ${attemptId}
  `,
    "objects",
  );
  const a = rows[0];
  if (!a) throw new PaymentAcceptanceError("attempt not found");
  // Validate every accounting reference before reserving a receipt document.
  // A provider webhook can arrive after an administrator deactivates an
  // account; that must retry without leaving a draft, journal, or audit trail.
  await validateAcceptanceBankAccount(orgId, a.bank_account_id);
  const configuredFeeAccountId = a.event_payload?.feeIncomeAccountId ?? null;
  if (configuredFeeAccountId !== null) {
    await validateSurchargeIncomeAccount(orgId, configuredFeeAccountId);
  }

  const doc = await db.execute<{ id: string; document_number: string; open_balance: string }>(
    sql`
    select id, document_number, open_balance from documents where id = ${a.document_id} and org_id = ${orgId}
     for update
  `,
    "objects",
  );
  const invoice = doc[0];
  if (!invoice) throw new PaymentAcceptanceError("invoice not found");
  // If another channel cleared the invoice after checkout, the provider's
  // collection is still real money. Continue by posting the full receipt as
  // an unapplied AR credit instead of marking the attempt settled without a
  // bank/AR journal entry.
  const collectedPrincipal = a.amount ?? invoice.open_balance;
  if (cmp(collectedPrincipal, invoice.open_balance) > 0) {
    const quotedFee = a.surcharge_amount ?? "0";
    const expectedCollectible = add(invoice.open_balance, quotedFee);
    return recordSettlementDiscrepancy(
      orgId,
      a.id,
      {
        reason: "collection_exceeds_open_balance",
        provider: a.provider,
        externalRef: a.external_ref,
        reportedAmount: add(collectedPrincipal, quotedFee),
        reportedCurrency: a.currency.toUpperCase(),
        expectedAmount: expectedCollectible,
        expectedCurrency: a.currency.toUpperCase(),
      },
      `provider collected ${add(collectedPrincipal, quotedFee)} ${a.currency.toUpperCase()} but the invoice now owes ${invoice.open_balance}; refund review is required`,
    );
  }
  const invoiceAlreadySettled = cmp(invoice.open_balance, "0") <= 0;

  let allocations: AllocationInput[] = [];
  // The provider collected the full quoted amount even when another channel
  // has since narrowed the invoice's open balance. The receipt books every
  // unit of that collection: the still-open portion applies to the invoice
  // and the excess rides the receipt as an on-account AR credit (never
  // dropped, never forced onto an invoice that no longer owes it).
  let onAccountAmount = "0.0000";
  if (!invoiceAlreadySettled) {
    // Auto-apply to the invoice's open-item line, capped at its open balance.
    const openItems = await openItemsForParty(a.party_id, "ar", orgId);
    const item = openItems.find((i) => i.documentId === invoice.id);
    if (!item) throw new PaymentAcceptanceError("invoice open item not found");
    const collected = a.amount ?? invoice.open_balance;
    const invoicePortion =
      cmp(collected, invoice.open_balance) < 0 ? collected : invoice.open_balance;
    onAccountAmount = fromUnits(toUnits(collected) - toUnits(invoicePortion));
    allocations = [sameCurrencyAllocation(item.lineId, invoicePortion)];
  }

  const actorId = a.link_created_by as string; // receipts attribute to the link creator

  let paymentId = a.payment_document_id;
  let resumedApproved = false;
  if (paymentId) {
    const existing = await db.execute<{ status: string }>(
      sql`
      select status from documents where id = ${paymentId} and org_id = ${orgId}
    `,
      "objects",
    );
    const reservedStatus = existing[0]?.status;
    if (reservedStatus === "posted") {
      // Posted earlier but the closing bookkeeping never ran (interrupted
      // settle) — finish it; finalize is journal-keyed and once-only.
      await finalizePaymentAcceptanceForDocument(paymentId);
      return "posted";
    }
    if (reservedStatus === "pending_approval") return "gated";
    if (reservedStatus !== "draft" && reservedStatus !== "approved") {
      throw new PaymentAcceptanceError(
        `reserved receipt is ${reservedStatus}; refusing to settle over it`,
      );
    }
    resumedApproved = reservedStatus === "approved";
  } else {
    const payment = await createPaymentDocument({
      orgId,
      kind: "customer_payment",
      createdBy: actorId,
      // Bearer payment-link provenance: no actor scope to inherit; the receipt
      // carries the invoiced subsidiary explicitly.
      allowedSubsidiaryIds: null,
      partyId: a.party_id,
      bankAccountId: a.bank_account_id,
      documentDate: await businessToday(orgId),
      memo: `Online payment — ${invoice.document_number}`,
      subsidiaryId: a.subsidiary_id,
      currency: a.currency,
    });
    paymentId = payment.id;
    // Reserve the document on the attempt BEFORE building it out: any retry
    // or redelivery resumes onto this exact draft rather than minting a
    // duplicate receipt per delivery.
    await db.execute(sql`
      update payment_attempts set payment_document_id = ${paymentId}, updated_at = now() where id = ${attemptId} and org_id = ${orgId}
    `);
  }

  if (!resumedApproved) {
    const feeAmount = a.surcharge_amount ?? "0";
    const feeIncomeAccountId = a.event_payload?.feeIncomeAccountId ?? null;
    if (invoiceAlreadySettled) {
      // updateDraftPayment intentionally requires at least one allocation at
      // posting time. An invoice already paid elsewhere has no open item to
      // allocate, so construct the same validated draft shape directly: the
      // customer_payment posting rule will create an open AR credit for the
      // collected invoice amount (plus its surcharge fee leg).
      const receiptAmount = a.amount ?? invoice.open_balance;
      const total = add(receiptAmount, feeAmount);
      if (cmp(total, "0") <= 0)
        throw new PaymentAcceptanceError("provider receipt amount must be positive");
      await db.execute(
        sql`delete from document_lines where document_id = ${paymentId} and org_id = ${orgId}`,
      );
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${orgId}, ${paymentId}, 1, ${a.bank_account_id}, '1', ${total}, ${total}, '0')
      `);
      await db.execute(sql`
        update documents
           set reference_number = ${`link:${a.link_id.slice(0, 8)}`},
               custom = coalesce(custom, '{}'::jsonb) || ${JSON.stringify({
                 allocations: [],
                 feeAmount,
                 feeIncomeAccountId,
               })}::jsonb,
               subtotal = ${total}, tax_total = '0', total = ${total},
               updated_at = now(), updated_by = ${actorId}
         where id = ${paymentId} and org_id = ${orgId} and status = 'draft'
      `);
    } else {
      // Applying replaces the stored allocations and fee leg (update
      // semantics, not append), so resuming a half-built draft cannot double
      // either.
      await updateDraftPayment(
        paymentId,
        {
          allocations,
          referenceNumber: `link:${a.link_id.slice(0, 8)}`,
          feeAmount,
          feeIncomeAccountId,
          onAccountAmount,
        },
        actorId,
        orgId,
        // Payment-link completion on the link's own draft: the link — not an
        // actor entity set — is the authority, named here as unrestricted.
        { allowedSubsidiaryIds: null },
      );
    }
    const submission = await submitAndReleaseIfUngated("customer_payment", paymentId, actorId);
    if (submission.flowError) {
      throw new PaymentAcceptanceError(
        `receipt approval could not be routed: ${submission.flowError}`,
      );
    }
    if (submission.gated) {
      return "gated";
    }
  }

  if (invoiceAlreadySettled) {
    await postDocument(paymentId, await paymentControlDeps(orgId));
  } else {
    await postPaymentWithApplications(paymentId, allocations, actorId);
  }
  await finalizePaymentAcceptanceForDocument(paymentId);
  return "posted";
}
