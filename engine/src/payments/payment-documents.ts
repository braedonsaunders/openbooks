import { and, eq, sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { businessToday } from "../platform/business-date.ts";
import { cmp, fromUnits, isZero, sum, toUnits } from "../money/money.ts";
import { PaymentError, PaymentRevisionConflictError } from "./payment-errors.ts";
import { persistPaymentFxRate, persistPaymentMoney, sameCurrencyAllocation, validateAllocationInputs, validateSettlementEvidence, type AllocationInput } from "./settlement-policy.ts";
import { type PaymentKind, PAYMENT_KIND_SIDE, type CreditAllocationInput } from "./payment-contracts.ts";
import { paymentBookId } from "./payment-accounts.ts";
import { openItemsForParty, loadPaymentDocument } from "./payment-queries.ts";
import { validateCreditAllocations } from "./credit-allocation.ts";
const NUMBER_PREFIX: Record<PaymentKind, string> = {
  vendor_payment: "PAY-",
  customer_payment: "RCPT-",
};

export function isPaymentKind(kind: string): kind is PaymentKind {
  return kind === "vendor_payment" || kind === "customer_payment";
}

export async function nextNumber(orgId: string, kind: string, prefix: string): Promise<string> {
  return allocateDocumentNumber(db, orgId, kind, prefix);
}

// ---------------------------------------------------------------------------
// Draft payment documents
// ---------------------------------------------------------------------------

export async function createPaymentDocument(opts: {
  orgId: string;
  kind: PaymentKind;
  /** Null for scheduler-created runs: system provenance, never a fabricated user. */
  createdBy: string | null;
  partyId?: string | null;
  bankAccountId?: string | null;
  documentDate?: string;
  memo?: string | null;
  subsidiaryId?: string | null;
  currency?: string;
  fxRate?: string;
}): Promise<{ id: string; documentNumber: string }> {
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, opts.orgId));
  if (!org) throw new PaymentError("org not found");
  const sub = (await db.execute<{ id: string }>(sql`
    select coalesce(
      (select subsidiary_id from parties where id = ${opts.partyId ?? null} and org_id = ${opts.orgId}),
      (select id from subsidiaries where org_id = ${opts.orgId} and parent_id is null)
    ) as id`));
  const subsidiaryId = opts.subsidiaryId !== undefined ? opts.subsidiaryId : (sub.rows[0]?.id ?? null);
  const documentNumber = await nextNumber(opts.orgId, opts.kind, NUMBER_PREFIX[opts.kind]);
  const fxRate = persistPaymentFxRate(opts.fxRate ?? "1");
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: opts.orgId,
      kind: opts.kind,
      documentNumber,
      partyId: opts.partyId ?? null,
      subsidiaryId,
      documentDate: opts.documentDate ?? await businessToday(opts.orgId),
      currency: opts.currency ?? org.baseCurrency,
      fxRate,
      memo: opts.memo ?? null,
      subtotal: "0",
      taxTotal: "0",
      total: "0",
      custom: opts.bankAccountId ? { bankAccountId: opts.bankAccountId, allocations: [] } : { allocations: [] },
      createdBy: opts.createdBy,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber });
  return doc!;
}

/**
 * Autosave surface for draft payments. Replaces header fields, the stored
 * allocations, and the single bank-account document line; the payment total
 * is always the sum of the allocations.
 *
 * Saves are fenced by the document's exact revision: the caller echoes the
 * canonical `updated_at` token it loaded (the same wire form every document
 * GET exposes), and the write happens only when that token still matches the
 * row locked FOR UPDATE first inside this transaction — two concurrent saves
 * can never silently overwrite one another.
 */
export async function updateDraftPayment(
  id: string,
  patch: {
    partyId?: string | null;
    bankAccountId?: string | null;
    documentDate?: string;
    referenceNumber?: string | null;
    memo?: string | null;
    allocations?: AllocationInput[];
    creditAllocations?: CreditAllocationInput[];
    discountAmount?: string;
    discountAccountId?: string | null;
    controlAccountId?: string | null;
    /** Payment-acceptance surcharge: charged on top of the applications and
     *  credited to a fee-income account (customer payments only). */
    feeAmount?: string;
    feeIncomeAccountId?: string | null;
    /** Collected cash above the applications, held as an on-account AR credit
     *  on the receipt (customer receipts only). */
    onAccountAmount?: string;
  },
  userId: string | null,
  orgId: string,
  options: { expectedRevision?: string } = {},
): Promise<Awaited<ReturnType<typeof loadPaymentDocument>>> {
  return withOrgTransaction(orgId, async () => {
    const [doc] = await db.select().from(schema.documents).where(and(eq(schema.documents.id, id), eq(schema.documents.orgId, orgId))).for("update");
    if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
    if (doc.status !== "draft") throw new PaymentError("only draft payments can be edited");

    const custom = (doc.custom ?? {}) as {
      bankAccountId?: string;
      allocations?: AllocationInput[];
      creditAllocations?: CreditAllocationInput[];
      discountAmount?: string;
      discountAccountId?: string;
      controlAccountId?: string;
      feeAmount?: string;
      feeIncomeAccountId?: string;
      onAccountAmount?: string;
    };
    const partyId = patch.partyId !== undefined ? patch.partyId : doc.partyId;
    const bankAccountId =
      patch.bankAccountId !== undefined ? patch.bankAccountId : (custom.bankAccountId ?? null);
    const allocations = patch.allocations ?? custom.allocations ?? [];
    // Read the PATCH first, exactly like `allocations` above. Reading only the
    // stored value silently discarded every credit a caller supplied: a payment
    // run computes vendor credits, passes them here, and they never reached the
    // document — the run item and the remittance advice both claimed a credit the
    // bill was never actually reduced by.
    const creditAllocations = patch.creditAllocations ?? custom.creditAllocations ?? [];
    const discountAmount = patch.discountAmount ?? custom.discountAmount ?? "0";
    const discountAccountId = patch.discountAccountId !== undefined ? patch.discountAccountId : (custom.discountAccountId ?? null);
    const controlAccountId = patch.controlAccountId !== undefined ? patch.controlAccountId : (custom.controlAccountId ?? null);
    const feeAmount = patch.feeAmount ?? custom.feeAmount ?? "0";
    const feeIncomeAccountId = patch.feeIncomeAccountId !== undefined ? patch.feeIncomeAccountId : (custom.feeIncomeAccountId ?? null);
    const onAccountAmount = patch.onAccountAmount ?? custom.onAccountAmount ?? "0";

    const paymentReferenceIds = [
      bankAccountId,
      discountAccountId,
      controlAccountId,
      feeIncomeAccountId,
    ].filter((value): value is string => value !== null && value !== undefined);
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (paymentReferenceIds.some((value) => !uuidPattern.test(value))) {
      throw new PaymentError("payment accounting account must be a valid UUID");
    }

    validateAllocationInputs(allocations);
    validateAllocationInputs(creditAllocations.map((a) => sameCurrencyAllocation(`${a.fromLineId}:${a.toLineId}`, a.amount)));
    const discountUnits = persistPaymentMoney(discountAmount, "discount amount");
    if (discountUnits < 0n) throw new PaymentError("discount amount cannot be negative");
    // Early-payment discounts settle against the payable: the vendor_payment
    // kernel rule carries the discount leg, while customer_payment has none —
    // accepting one here would post a short AR credit against full
    // applications (caught only later at the posting cross-foot).
    if (discountUnits > 0n && doc.kind !== "vendor_payment") throw new PaymentError("discounts only apply to vendor payments");
    if (discountUnits > 0n && !discountAccountId) throw new PaymentError("select a discount account before applying a discount");
    const feeUnits = persistPaymentMoney(feeAmount, "fee amount");
    if (feeUnits < 0n) throw new PaymentError("fee amount cannot be negative");
    if (feeUnits > 0n && doc.kind !== "customer_payment") throw new PaymentError("fees only apply to customer receipts");
    if (feeUnits > 0n && !feeIncomeAccountId) throw new PaymentError("a fee income account is required for a surcharge");
    // Collected cash above the applications stays on the receipt as an
    // on-account AR credit instead of being dropped: the bank line carries
    // the full collected amount while the applications settle only what is
    // still open. Vendor overpayments have no such representation and are
    // refused here, like surcharges on the vendor side.
    const onAccountUnits = persistPaymentMoney(onAccountAmount, "on-account amount");
    if (onAccountUnits < 0n) throw new PaymentError("on-account amount cannot be negative");
    if (onAccountUnits > 0n && doc.kind !== "customer_payment") throw new PaymentError("on-account residuals only apply to customer receipts");

    if (bankAccountId) {
      const bank = (await db.execute<{ id: string }>(sql`
        select id from accounts
         where id = ${bankAccountId} and org_id = ${doc.orgId}
           and type = 'asset_bank' and is_active and not is_summary
      `));
      if (!bank.rows[0]) throw new PaymentError("bank account must be an active bank-type account");
    }
    if (discountAccountId || controlAccountId || feeIncomeAccountId) {
      const refs = [discountAccountId, controlAccountId, feeIncomeAccountId].filter(Boolean) as string[];
      const uniqueRefs = [...new Set(refs)];
      const validRefs = (await db.execute<{ id: string; type: string }>(sql`
        select id, type from accounts where org_id = ${doc.orgId} and id in ${uniqueRefs} and is_active and not is_summary
      `));
      if (validRefs.rows.length !== uniqueRefs.length) throw new PaymentError("payment accounting account is invalid or inactive");
      if (feeIncomeAccountId) {
        const feeAccount = validRefs.rows.find((row) => row.id === feeIncomeAccountId);
        if (!feeAccount || !["income", "income_other"].includes(feeAccount.type)) {
          throw new PaymentError("fee income account must be an active income account");
        }
      }
    }
    if (partyId && partyId !== doc.partyId) {
      const party = (await db.execute<{ id: string }>(
        sql`select id from parties where id = ${partyId} and org_id = ${doc.orgId} and is_active`,
      ));
      if (!party.rows[0]) throw new PaymentError("party not found");
    }

    // Allocations must target real open items of this party, within open balance.
    if (allocations.length > 0) {
      if (!partyId) throw new PaymentError("select a party before applying open items");
      const openItems = await openItemsForParty(partyId, PAYMENT_KIND_SIDE[doc.kind], doc.orgId, new Set(doc.subsidiaryId ? [doc.subsidiaryId] : []));
      const byLine = new Map(openItems.map((i) => [i.lineId, i]));
      for (const a of allocations) {
        const item = byLine.get(a.openLineId);
        if (!item) throw new PaymentError("an allocated item is not an open item for this party");
        validateSettlementEvidence(a, doc.currency, item.currency);
        if (cmp(a.targetTransactionAmount, item.transactionOpen) > 0) {
          throw new PaymentError(
            `applying ${a.targetTransactionAmount} ${item.currency} exceeds the open transaction balance ${item.transactionOpen} on ${item.documentNumber ?? item.entryNumber}`,
          );
        }
      }
    }

    if (creditAllocations.length) await validateCreditAllocations(creditAllocations, allocations, {
      orgId: doc.orgId, partyId, subsidiaryId: doc.subsidiaryId,
      bookId: await paymentBookId(doc.orgId), side: PAYMENT_KIND_SIDE[doc.kind], controlAccountId,
    });
    const grossApplied = sum(allocations.map((a) => a.sourceTransactionAmount));
    if (cmp(discountAmount, grossApplied) > 0) throw new PaymentError("discount cannot exceed the payment applications");
    // Collected = applications − discount + surcharge fee + on-account
    // remainder; the bank line carries the full collected amount, AR settles
    // the applications plus the on-account credit, fee income clears the
    // surcharge leg (see the customer_payment posting rule).
    //
    // documents.total on a payment is the CASH frame by contract: the bank
    // line (this `total`), never the AP/AR relieved. A vendor payment with
    // an early-payment discount posts total = cash (90) while its AP leg
    // relieves the gross applications (100) — the relieved amount lives in
    // the journal legs and the settlement evidence (applications), not the
    // header. Every total-reader is cash-frame (module-home collected/paid
    // tiles, 1099 bank-side legs, remittance instruction amounts, bank
    // matching on journal lines); every settlement reader uses open items
    // and applications. Do not "fix" total to the gross: cash forecasting
    // depends on it.
    const total = fromUnits(toUnits(grossApplied) - discountUnits + feeUnits + onAccountUnits);

    await db.transaction(async (tx) => {
      // The header was locked before reading the fields merged above. Check
      // the exact revision before writing; concurrent savers either committed
      // before that lock or wait for this whole save to commit.
      // The strictly increasing revision_seq counter (migration 0167), not
      // the editable updated_at display timestamp, is the revision token.
      const locked = (await tx.execute<{ status: string; updatedAt: string }>(sql`
        select status,
               ${documentRevisionCounterSql(sql`revision_seq`)} as "updatedAt"
          from documents
         where id = ${id} and org_id = ${orgId}
         for update
      `)).rows[0];
      if (!locked) throw new PaymentError("payment document not found");
      if (locked.status !== "draft") throw new PaymentError("only draft payments can be edited");
      if (options.expectedRevision !== undefined && options.expectedRevision !== locked.updatedAt) {
        throw new PaymentRevisionConflictError();
      }
      await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${orgId}`);
      if (bankAccountId && !isZero(total)) {
        await tx.insert(schema.documentLines).values({
          orgId: doc.orgId,
          documentId: id,
          lineNumber: 1,
          accountId: bankAccountId,
          quantity: "1",
          unitPrice: total,
          amount: total,
          taxAmount: "0",
        });
      }
      await tx.execute(sql`
        update documents set
          party_id = ${partyId ?? null},
          document_date = coalesce(${patch.documentDate ?? null}, document_date),
          reference_number = ${patch.referenceNumber !== undefined ? patch.referenceNumber : sql`reference_number`},
          memo = ${patch.memo !== undefined ? patch.memo : sql`memo`},
          custom = ${JSON.stringify({ ...custom, bankAccountId, allocations, creditAllocations, discountAmount, discountAccountId, controlAccountId, feeAmount, feeIncomeAccountId, onAccountAmount })}::jsonb,
          subtotal = ${total}, tax_total = '0', total = ${total},
          updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${userId}
        where id = ${id} and org_id = ${orgId}
      `);
    });
    return loadPaymentDocument(id, doc.kind, orgId);
  });
}
