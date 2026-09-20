import { and, eq, inArray, sql } from "drizzle-orm";
import { db, orgContext, schema, withOrg, withOrgTransaction } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { businessToday } from "../platform/business-date.ts";
import { roundCurrencyMoney } from "../fx/currencies.ts";
import { add, cmp, divRate, fromUnits, isZero, mulRate, neg, sum, toUnits } from "../money/money.ts";
import { postDocument, runPostDocumentEffects, type PostingDeps } from "../ledger/posting.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import {
  evaluateBillsForRelease,
  recordReleaseCheck,
  type BillReleaseDecision,
} from "../compliance/compliance.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { assertSubcontractPaymentCleared } from "../projects/subcontracts.ts";

import { PaymentError, PaymentRevisionConflictError, PaymentRunPostingClaimFencedError } from "./payment-errors.ts";
import {
  allocationsMatchApprovedSnapshot, canonicalSettlementRate, carryingAmountForSettlement,
  persistPaymentFxRate, persistPaymentMoney, realizedFxControlAdjustment,
  sameCurrencyAllocation, validateAllocationInputs, validateSettlementEvidence,
  type AllocationInput, type SettlementRateSource,
} from "./settlement-policy.ts";
import {
  decryptAccountNumber, loadEftSettings, loadNachaSettings, loadSepaSettings,
  type EftSettings, type EftSettingsResult,
} from "./rail-settings.ts";
import {
  buildCpa005File, buildNachaFile, buildSepaFile, nachaCheckDigit,
  type Cpa005Payment, type NachaEntry,
} from "./rail-formatters.ts";

// Preserve the public payments entry point; extracted modules never import this facade.
export { PaymentError, PaymentRevisionConflictError, PaymentRunPostingClaimFencedError } from "./payment-errors.ts";
export { carryingAmountForSettlement, realizedFxControlAdjustment, sameCurrencyAllocation } from "./settlement-policy.ts";
export type { AllocationInput, SettlementRateSource } from "./settlement-policy.ts";
export { decryptAccountNumber, encryptAccountNumber, loadEftSettings, loadNachaSettings, loadSepaSettings, validateNachaSettings, validateSepaSettings } from "./rail-settings.ts";
export type { EftSettings, EftSettingsResult, NachaSettings, SepaSettings } from "./rail-settings.ts";
export { buildCpa005File, buildNachaFile, buildSepaFile } from "./rail-formatters.ts";
export type { Cpa005Payment, Cpa005Run, NachaEntry } from "./rail-formatters.ts";

/**
 * Payments: vendor payments and customer receipts with open-item application,
 * payment runs, and CPA Standard 005 EFT file generation.
 *
 * A payment is an ordinary document (kind vendor_payment / customer_payment)
 * posted through the kernel: DR AP / CR bank (vendor) or DR bank / CR AR
 * (customer). What it settles is recorded in `applications` rows linking the
 * payment entry's AP/AR line (from) to each open-item journal line (to); the
 * deferred `app_check_open` trigger is the final authority on caps.
 *
 * Draft payments carry their working state on documents.custom:
 *   { bankAccountId: uuid, allocations: [{ openLineId,
 *       sourceTransactionAmount, targetTransactionAmount, settlementRate, … }] }
 * plus a single document line (the bank account, amount = payment total) so
 * the existing posting rules pick up the right bank account.
 */

export type PaymentKind = "vendor_payment" | "customer_payment";
export type OpenItemSide = "ap" | "ar";

export const PAYMENT_KIND_SIDE: Record<PaymentKind, OpenItemSide> = {
  vendor_payment: "ap",
  customer_payment: "ar",
};

const NUMBER_PREFIX: Record<PaymentKind, string> = {
  vendor_payment: "PAY-",
  customer_payment: "RCPT-",
};

export interface CreditAllocationInput {
  fromLineId: string;
  toLineId: string;
  amount: string;
  sourceDocumentId: string;
}

function isPaymentKind(kind: string): kind is PaymentKind {
  return kind === "vendor_payment" || kind === "customer_payment";
}

export async function nextNumber(orgId: string, kind: string, prefix: string): Promise<string> {
  return allocateDocumentNumber(db, orgId, kind, prefix);
}

// ---------------------------------------------------------------------------
// Control accounts
// ---------------------------------------------------------------------------

export async function paymentControlDeps(orgId: string): Promise<PostingDeps> {
  const r = (await db.execute<{ c: Record<string, string> | null }>(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  ));
  const c = r.rows[0]?.c ?? {};
  if (!c.ap || !c.ar || !c.bank) {
    throw new PaymentError(
      "org control accounts are not configured (orgs.settings.controlAccounts.ap/ar/bank)",
    );
  }
  return {
    control: {
      ap: c.ap,
      ar: c.ar,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
      fxRealizedGainLoss: c.fxRealizedGainLoss,
    },
  };
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

// ---------------------------------------------------------------------------
// Open items
// ---------------------------------------------------------------------------

export interface OpenItem {
  lineId: string;
  entryId: string;
  entryNumber: string;
  postingDate: string;
  dueDate: string | null;
  documentId: string | null;
  documentNumber: string | null;
  documentKind: string | null;
  referenceNumber: string | null;
  memo: string | null;
  /** Absolute original amount of the open-item line. */
  amount: string;
  /** Sum of live applications against this line. */
  applied: string;
  /** amount − applied. Only items with open > 0 are returned. */
  open: string;
  currency: string;
  fxRate: string;
  transactionAmount: string;
  transactionApplied: string;
  transactionOpen: string;
}

export interface SuggestedApplication {
  allocations: AllocationInput[];
  /** Total allocated across the open items. */
  applied: string;
  /** amount − applied: unapplied overpayment / on-account credit. */
  remaining: string;
  /** How the suggestion was reached. */
  strategy: "reference" | "exact" | "fifo" | "none";
}

/**
 * Automated cash application: propose how an incoming amount settles a party's
 * open items. Prefers a reference-number hit, then an exact single-item match,
 * then oldest-first (FIFO) allocation. Pure over `openItemsForParty`, so the
 * caller confirms and posts via `postPaymentWithApplications`.
 */
export async function suggestApplications(
  partyId: string,
  amount: string,
  side: OpenItemSide = "ar",
  opts?: { reference?: string | null; sourceCurrency: string; orgId?: string; allowedSubsidiaryIds?: ReadonlySet<string> | null },
): Promise<SuggestedApplication> {
  if (!opts?.sourceCurrency) throw new PaymentError("payment currency is required for automatic application");
  // Automated allocation is intentionally limited to open items already in the
  // payment currency. Cross-currency rows require explicit rate evidence and
  // source/target amounts from the accountant or bank advice.
  const items = (await openItemsForParty(partyId, side, opts.orgId, opts.allowedSubsidiaryIds)).filter((item) => item.currency === opts.sourceCurrency);
  const target = toUnits(amount);
  if (target <= 0n || items.length === 0) {
    return { allocations: [], applied: "0", remaining: fromUnits(target < 0n ? 0n : target), strategy: "none" };
  }

  // 1) reference match — the payment memo/ref names a specific invoice
  const ref = opts?.reference?.trim().toLowerCase();
  if (ref) {
    const m = items.find(
      (i) => (i.documentNumber ?? "").toLowerCase() === ref || (i.referenceNumber ?? "").toLowerCase() === ref,
    );
    if (m) {
      const take = toUnits(m.transactionOpen) <= target ? toUnits(m.transactionOpen) : target;
      return { allocations: [sameCurrencyAllocation(m.lineId, fromUnits(take))], applied: fromUnits(take), remaining: fromUnits(target - take), strategy: "reference" };
    }
  }

  // 2) exact single-item match — paid one invoice to the cent
  const exact = items.find((i) => toUnits(i.transactionOpen) === target);
  if (exact) {
    return { allocations: [sameCurrencyAllocation(exact.lineId, amount)], applied: amount, remaining: "0", strategy: "exact" };
  }

  // 3) FIFO oldest-first (openItemsForParty is ordered by due/posting date)
  const allocations: AllocationInput[] = [];
  let remaining = target;
  for (const i of items) {
    if (remaining <= 0n) break;
    const take = toUnits(i.transactionOpen) <= remaining ? toUnits(i.transactionOpen) : remaining;
    if (take > 0n) {
      allocations.push(sameCurrencyAllocation(i.lineId, fromUnits(take)));
      remaining -= take;
    }
  }
  return { allocations, applied: fromUnits(target - remaining), remaining: fromUnits(remaining), strategy: allocations.length ? "fifo" : "none" };
}

/**
 * Open AP (credit) or AR (debit) journal lines for a party: is_open_item
 * lines on posted entries, with applied-to-date sums and remaining balance.
 */
function paymentSubsidiaryScope(column: ReturnType<typeof sql>, allowed?: ReadonlySet<string> | null) {
  if (allowed == null) return sql``;
  if (allowed.size === 0) return sql` and false`;
  return sql` and ${column} = any(${`{${[...allowed].join(',')}}`}::uuid[])`;
}

/** Keep selectable settlements on the same authoritative book used by posting.
 * The setup writer takes the exclusive advisory lock; writes retain this shared
 * lock and the selected book row through commit. */
async function paymentBookId(orgId: string): Promise<string> {
  await db.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`accounting-books:${orgId}`}, 0))`);
  const books = (await db.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(sql`
    select id, is_active, posts_gl from accounting_books
     where org_id = ${orgId} and is_primary order by id for share
  `)).rows;
  if (books.length !== 1 || !books[0]!.is_active || !books[0]!.posts_gl) {
    throw new PaymentError("payments require exactly one active primary posting book");
  }
  return books[0]!.id;
}

/** Validate credit workpapers against the payment, not merely against each
 * other. Endpoint locks serialize cash and credit capacity checks together. */
async function validateCreditAllocations(
  credits: CreditAllocationInput[], allocations: AllocationInput[],
  scope: { orgId: string; partyId: string | null; subsidiaryId: string | null; bookId: string; side: OpenItemSide; controlAccountId: string | null },
): Promise<void> {
  if (!credits.length) return;
  if (!scope.partyId || !scope.subsidiaryId) throw new PaymentError("credit applications require a payment party and subsidiary");
  validateAllocationInputs(credits.map(a => sameCurrencyAllocation(`${a.fromLineId}:${a.toLineId}`, a.amount)));
  const ids = [...new Set([...allocations.map(a => a.openLineId), ...credits.flatMap(a => [a.fromLineId, a.toLineId])])];
  await db.execute(sql`select id from journal_lines where org_id = ${scope.orgId} and id in ${ids} order by id for update`);
  const rows = (await db.execute<{
    id: string; account_id: string; party_id: string | null; subsidiary_id: string;
    book_id: string; status: string; is_open_item: boolean; amount: string; source_document_id: string | null;
    currency: string; base_currency: string; txn_amount: string;
    source_used: string; target_used: string; source_txn_used: string; target_txn_used: string;
  }>(sql`
    select jl.id, jl.account_id, jl.party_id, jl.subsidiary_id, je.book_id, je.status,
           jl.is_open_item, jl.amount, jl.currency, jl.txn_amount, s.base_currency, d.id as source_document_id,
           coalesce(ap.source_used,0) as source_used, coalesce(ap.target_used,0) as target_used,
           coalesce(ap.source_txn_used,0) as source_txn_used, coalesce(ap.target_txn_used,0) as target_txn_used
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
      left join documents d on d.id = je.source_document_id and d.org_id = jl.org_id
      left join lateral (
        select sum(a.source_amount) filter(where a.from_line_id=jl.id) as source_used,
               sum(a.amount) filter(where a.to_line_id=jl.id) as target_used,
               sum(a.source_transaction_amount) filter(where a.from_line_id=jl.id) as source_txn_used,
               sum(a.target_transaction_amount) filter(where a.to_line_id=jl.id) as target_txn_used
          from applications a where a.org_id=jl.org_id and a.unapplied_at is null
           and (a.from_line_id=jl.id or a.to_line_id=jl.id)
      ) ap on true
     where jl.org_id=${scope.orgId} and jl.id in ${ids}
  `)).rows;
  const byId = new Map(rows.map(row => [row.id, row]));
  const targetAccounts = new Set(allocations.map(a => byId.get(a.openLineId)?.account_id));
  const deps = scope.controlAccountId ? null : await paymentControlDeps(scope.orgId);
  const account = scope.controlAccountId ?? (targetAccounts.size === 1 ? [...targetAccounts][0] : null)
    ?? (scope.side === "ap" ? deps!.control.ap : deps!.control.ar);
  const sourceAmounts = new Map<string, bigint>();
  const targetAmounts = new Map<string, bigint>();
  for (const allocation of allocations) targetAmounts.set(allocation.openLineId,
    (targetAmounts.get(allocation.openLineId) ?? 0n) + toUnits(allocation.targetTransactionAmount));
  for (const credit of credits) {
    if (!credit.sourceDocumentId || byId.get(credit.fromLineId)?.source_document_id !== credit.sourceDocumentId) {
      throw new PaymentError("credit source document must match the tenant-owned posted credit entry");
    }
    for (const [id, source] of [[credit.fromLineId, true], [credit.toLineId, false]] as const) {
      const row = byId.get(id);
      if (!row || row.party_id !== scope.partyId || row.subsidiary_id !== scope.subsidiaryId ||
          row.book_id !== scope.bookId || row.account_id !== account || row.status !== "posted" || !row.is_open_item) {
        throw new PaymentError("credit applications must use posted open items in the payment's party, control account, subsidiary, and book");
      }
      const positive = scope.side === "ap" ? source : !source;
      if ((positive ? cmp(row.amount, "0") <= 0 : cmp(row.amount, "0") >= 0)) {
        throw new PaymentError("credit application endpoints have the wrong payment side or sign");
      }
      if (row.currency !== row.base_currency || cmp(row.amount, row.txn_amount) !== 0) {
        throw new PaymentError("foreign-currency credit applications require explicit transaction amounts");
      }
    }
    const units = toUnits(credit.amount);
    sourceAmounts.set(credit.fromLineId, (sourceAmounts.get(credit.fromLineId) ?? 0n) + units);
    targetAmounts.set(credit.toLineId, (targetAmounts.get(credit.toLineId) ?? 0n) + units);
  }
  for (const [amounts, source] of [[sourceAmounts, true], [targetAmounts, false]] as const) {
    for (const [id, amount] of amounts) {
      const row = byId.get(id);
      // Cash-only foreign targets already undergo dual-currency validation.
      if (!row || (!source && !credits.some(a => a.toLineId === id))) continue;
      const abs = (v: string) => { const n = toUnits(v); return n < 0n ? -n : n; };
      if (amount > abs(row.amount) - toUnits(source ? row.source_used : row.target_used) ||
          amount > abs(row.txn_amount) - toUnits(source ? row.source_txn_used : row.target_txn_used)) {
        throw new PaymentError("credit and cash applications exceed an endpoint's open balance");
      }
    }
  }
}

export async function openItemsForParty(partyId: string, side: OpenItemSide, orgId?: string, allowedSubsidiaryIds?: ReadonlySet<string> | null): Promise<OpenItem[]> {
  const tenantId = orgId ?? orgContext.getStore()?.orgId;
  if (!tenantId) throw new PaymentError("organization is required to select payment open items");
  const bookId = await paymentBookId(tenantId);
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const orgFilter = sql`jl.org_id = ${tenantId} and je.book_id = ${bookId} and`;
  const r = (await db.execute<{
      line_id: string;
      amount: string;
      due_date: string | null;
      memo: string | null;
      entry_id: string;
      entry_number: string;
      posting_date: string;
      document_id: string | null;
      document_number: string | null;
      document_kind: string | null;
      reference_number: string | null;
      applied: string;
      currency: string;
      fx_rate: string;
      transaction_amount: string;
      transaction_applied: string;
    }>(sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
      left join lateral (
        select sum(a.amount) as applied, sum(a.target_transaction_amount) as transaction_applied
          from applications a
         where a.to_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
     where ${orgFilter} jl.party_id = ${partyId} and jl.is_open_item and ${signFilter}
       ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, allowedSubsidiaryIds)}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `));
  return r.rows
    .map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      referenceNumber: row.reference_number,
      memo: row.memo,
      amount: row.amount,
      applied: row.applied,
      open: sum([row.amount, negStr(String(row.applied))]),
      currency: row.currency,
      fxRate: row.fx_rate,
      transactionAmount: row.transaction_amount,
      transactionApplied: row.transaction_applied,
      transactionOpen: sum([row.transaction_amount, negStr(String(row.transaction_applied))]),
    }))
    .filter((i) => cmp(i.open, "0") > 0);
}

function negStr(a: string): string {
  return toUnits(a) === 0n ? "0" : a.startsWith("-") ? a.slice(1) : `-${a}`;
}

/**
 * Posted, still-open credit-memo lines available as application sources for a
 * party: the mirror of openItemsForParty, which lists only debit items a
 * payment can extinguish. Credits carry the opposite sign (AR: amount < 0,
 * AP: amount > 0) and are consumed from the from_line side of applications.
 * Only lines with remaining open balance are returned.
 */
export async function creditItemsForParty(
  partyId: string,
  side: OpenItemSide = "ar",
  orgId?: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<OpenItem[]> {
  const tenantId = orgId ?? orgContext.getStore()?.orgId;
  if (!tenantId) throw new PaymentError("organization is required to select credit open items");
  const bookId = await paymentBookId(tenantId);
  const creditKind = side === "ap" ? "vendor_credit" : "customer_credit";
  const signFilter = side === "ap" ? sql`jl.amount > 0` : sql`jl.amount < 0`;
  const r = (await db.execute<{
    line_id: string;
    amount: string;
    due_date: string | null;
    memo: string | null;
    entry_id: string;
    entry_number: string;
    posting_date: string;
    document_id: string | null;
    document_number: string | null;
    document_kind: string | null;
    reference_number: string | null;
    applied: string;
    currency: string;
    fx_rate: string;
    transaction_amount: string;
    transaction_applied: string;
  }>(sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      join documents d on d.id = je.source_document_id and d.org_id = je.org_id and d.kind = ${creditKind}
      left join lateral (
        select sum(a.source_amount) as applied, sum(a.source_transaction_amount) as transaction_applied
          from applications a
         where a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
      ) ap on true
     where jl.org_id = ${tenantId} and je.book_id = ${bookId} and jl.party_id = ${partyId}
       and jl.is_open_item and ${signFilter}
       ${paymentSubsidiaryScope(sql`jl.subsidiary_id`, allowedSubsidiaryIds)}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `));
  return r.rows
    .map((row) => ({
      lineId: row.line_id,
      entryId: row.entry_id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
      dueDate: row.due_date,
      documentId: row.document_id,
      documentNumber: row.document_number,
      documentKind: row.document_kind,
      referenceNumber: row.reference_number,
      memo: row.memo,
      amount: row.amount,
      applied: row.applied,
      open: sum([row.amount, negStr(String(row.applied))]),
      currency: row.currency,
      fxRate: row.fx_rate,
      transactionAmount: row.transaction_amount,
      transactionApplied: row.transaction_applied,
      transactionOpen: sum([row.transaction_amount, negStr(String(row.transaction_applied))]),
    }))
    .filter((i) => cmp(i.open, "0") > 0);
}

/**
 * Full drawer payload for a payment document: header, stored draft
 * allocations, and (once posted) the live applications with their targets.
 */
export async function loadPaymentDocument(id: string, kind: PaymentKind, orgId: string, allowedSubsidiaryIds?: ReadonlySet<string> | null) {
  const doc = (await db.execute<Record<string, unknown>>(sql`
    select d.*, (d.revision_seq)::text as updated_at,
           p.display_name as party_name, e.id as entry_id, e.entry_number,
           ba.id as bank_account_id_line, ba.number as bank_account_number, ba.name as bank_account_name
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id and dl.line_number = 1
      left join accounts ba on ba.id = coalesce((d.custom->>'bankAccountId')::uuid, dl.account_id) and ba.org_id = d.org_id
     where d.id = ${id} and d.kind = ${kind} and d.org_id = ${orgId}
       ${paymentSubsidiaryScope(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `));
  const row = doc.rows[0];
  if (!row) return null;

  const custom = (row.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const applied =
    row.status === "posted" && row.posted_entry_id
      ? ((await db.execute<Record<string, unknown>>(sql`
          select a.id, a.amount, a.source_amount,
                 a.source_transaction_amount, a.source_transaction_currency,
                 a.target_transaction_amount, a.target_transaction_currency,
                 a.settlement_rate, a.settlement_rate_source,
                 a.settlement_rate_reference, a.settlement_fx_rate_id,
                 a.fx_gain_loss_entry_id, a.applied_on,
                 te.entry_number as target_entry_number, te.posting_date as target_posting_date,
                 tl.due_date as target_due_date, abs(tl.amount) as target_amount,
                 abs(tl.txn_amount) as target_transaction_original,
                 td.id as target_document_id, td.document_number as target_document_number,
                 td.kind as target_document_kind, td.reference_number as target_reference_number
            from journal_lines jl
            join applications a on a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
            join journal_lines tl on tl.id = a.to_line_id and tl.org_id = jl.org_id
            join journal_entries te on te.id = tl.entry_id and te.org_id = tl.org_id
            left join documents td on td.id = te.source_document_id and td.org_id = te.org_id
           where jl.entry_id = ${row.posted_entry_id} and jl.org_id = ${orgId}
           order by te.posting_date, te.entry_number
        `))).rows
      : [];

  return {
    doc: row,
    bankAccountId: custom.bankAccountId ?? null,
    allocations: custom.allocations ?? [],
    applied,
  };
}

// ---------------------------------------------------------------------------
// Post + apply
// ---------------------------------------------------------------------------

type SettlementApplication = {
  fromLineId: string;
  toLineId: string;
  amount: string;
  sourceAmount: string;
  sourceTransactionAmount: string;
  sourceTransactionCurrency: string;
  targetTransactionAmount: string;
  targetTransactionCurrency: string;
  settlementRate: string;
  settlementRateSource: SettlementRateSource;
  settlementRateReference: string;
  settlementFxRateId: string | null;
  appliedOn: string;
  controlAdjustment: string;
};

/** Post the payment, applications, realized FX, and links as one atomic unit. */
export async function postPaymentWithApplications(
  paymentDocId: string,
  allocations?: AllocationInput[],
  userId?: string,
  auditSource: "ui" | "api" | "mcp" | "assistant" | "flows" = "ui",
  options: { deferEffects?: boolean } = {},
): Promise<{ entryId: string }> {
  const [preflight] = await db.select().from(schema.documents).where(eq(schema.documents.id, paymentDocId));
  if (!preflight || !isPaymentKind(preflight.kind)) throw new PaymentError("payment document not found");

  const result = await withOrg(preflight.orgId, async () => {
    // Match the kernel's organization -> book lock order. Holding a shared
    // book/advisory lock before upgrading the organization lock can deadlock
    // with setup's feature fence followed by an exclusive book edit.
    await db.execute(sql`select id from orgs where id = ${preflight.orgId} for update`);
    // Serialize both the payment aggregate and every application endpoint.
    await db.execute(sql`select id from documents where id = ${paymentDocId} and org_id = ${preflight.orgId} for update`);
    const [doc] = await db.select().from(schema.documents).where(and(eq(schema.documents.id, paymentDocId), eq(schema.documents.orgId, preflight.orgId)));
    if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
    if (doc.status !== "approved") {
      throw new PaymentError(
        `${doc.documentNumber} is ${doc.status}; it must complete the approval submission lifecycle before posting`,
      );
    }
    if (!doc.partyId) throw new PaymentError("select a party before posting");
    const auditBefore = userId
      ? await captureTransactionAuditSnapshot(db, paymentDocId, doc.orgId)
      : null;
    if (doc.kind === "vendor_payment") {
      const hold = (await db.execute<{ hold_reason: string | null }>(sql`
        select hold_reason
          from vendor_roles
         where org_id = ${doc.orgId} and party_id = ${doc.partyId}
           and is_active and is_on_hold
         limit 1
      `));
      if (hold.rows[0]) {
        throw new PaymentError(
          `vendor is on payment hold${hold.rows[0].hold_reason ? ` — ${hold.rows[0].hold_reason}` : ""}`,
        );
      }
    }

    const custom = (doc.custom ?? {}) as {
      bankAccountId?: string;
      allocations?: AllocationInput[];
      creditAllocations?: CreditAllocationInput[];
      discountAmount?: string;
      controlAccountId?: string;
      onAccountAmount?: string;
    };
    const storedAllocations = custom.allocations ?? [];
    const allocs = allocations ?? storedAllocations;
    const creditAllocs = custom.creditAllocations ?? [];
    if (allocs.length === 0) throw new PaymentError("select at least one open item to apply");
    validateAllocationInputs(allocs);
    if (
      allocations !== undefined &&
      !allocationsMatchApprovedSnapshot(allocations, storedAllocations)
    ) {
      throw new PaymentError(
        "payment allocations differ from the approved document; save the payment and complete approval before posting",
      );
    }

    const endpointIds = [...new Set([
      ...allocs.map((a) => a.openLineId),
      ...creditAllocs.flatMap((a) => [a.fromLineId, a.toLineId]),
    ])];
    await db.execute(sql`select id from journal_lines where id in ${endpointIds} and org_id = ${doc.orgId} order by id for update`);

    const side = PAYMENT_KIND_SIDE[doc.kind];
    const bookId = await paymentBookId(doc.orgId);
    await validateCreditAllocations(creditAllocs, allocs, {
      orgId: doc.orgId, partyId: doc.partyId, subsidiaryId: doc.subsidiaryId,
      bookId, side, controlAccountId: custom.controlAccountId ?? null,
    });
    const openItems = await openItemsForParty(doc.partyId, side, doc.orgId);
    const byLine = new Map(openItems.map((item) => [item.lineId, item]));
    for (const allocation of allocs) {
      const item = byLine.get(allocation.openLineId);
      if (!item) throw new PaymentError("an allocated item is no longer open for this party");
      if (doc.kind === "vendor_payment" && item.documentId) {
        // A joint-check instruction is intentionally incompatible with an
        // ordinary one-payee payment. The control must be released or handled
        // through a dedicated joint-check disbursement before cash can move.
        await assertSubcontractPaymentCleared(doc.orgId, item.documentId, allocation.targetTransactionAmount);
      }
      validateSettlementEvidence(allocation, doc.currency, item.currency);
      if (cmp(allocation.targetTransactionAmount, item.transactionOpen) > 0) {
        throw new PaymentError(`application exceeds ${item.documentNumber ?? item.entryNumber}'s open transaction balance`);
      }
    }
    const evidenceIds = [...new Set(allocs.map((a) => a.settlementFxRateId).filter((id): id is string => !!id))];
    if (evidenceIds.length) {
      const evidenceRows = (await db.execute<{ id: string; from_currency: string; to_currency: string; rate: string; as_of: string }>(sql`
        select id, from_currency, to_currency, rate, as_of::text as as_of
          from fx_rates
         where org_id = ${doc.orgId} and id in ${evidenceIds}
      `));
      const evidenceById = new Map(evidenceRows.rows.map((row) => [row.id, row]));
      for (const allocation of allocs) {
        if (!allocation.settlementFxRateId) continue;
        const evidence = evidenceById.get(allocation.settlementFxRateId);
        const targetCurrency = byLine.get(allocation.openLineId)!.currency;
        if (
          !evidence ||
          evidence.from_currency !== doc.currency ||
          evidence.to_currency !== targetCurrency ||
          canonicalSettlementRate(evidence.rate) !== canonicalSettlementRate(allocation.settlementRate) ||
          evidence.as_of > doc.documentDate
        ) {
          throw new PaymentError("settlement FX observation does not match the payment, open item, rate, and date");
        }
      }
    }

    const totalAlloc = sum(allocs.map((a) => a.sourceTransactionAmount));
    const discountAmount = custom.discountAmount ?? "0";
    const feeAmount = (custom as { feeAmount?: string }).feeAmount ?? "0";
    // Fail closed on a stored on-account remainder the draft boundary never
    // admitted: only a non-negative customer-receipt residual may widen the
    // receipt beyond its applications.
    const onAccountAmount = custom.onAccountAmount ?? "0";
    const onAccountUnits = toUnits(onAccountAmount);
    if (onAccountUnits < 0n) throw new PaymentError("on-account amount cannot be negative");
    if (onAccountUnits > 0n && doc.kind !== "customer_payment") throw new PaymentError("on-account residuals only apply to customer receipts");
    // Applications settle the invoice portion: cash + early-payment discount
    // (vendor side) − acceptance surcharge fee (customer side) = applications
    // + on-account remainder (a customer receipt may collect more than is
    // still open; the excess stays on the receipt as an AR credit).
    if (cmp(add(totalAlloc, onAccountAmount), fromUnits(toUnits(doc.total) + toUnits(discountAmount) - toUnits(feeAmount))) !== 0) {
      throw new PaymentError(`cash ${doc.total} plus discount ${discountAmount} less fee ${feeAmount} must equal applications ${totalAlloc} plus on-account ${onAccountAmount}`);
    }

    // Final compliance gate (mirrors the run-posting final gate): a
    // block_payment policy stops payment on EVERY path — evaluateBillRelease's
    // contract names pay-run creation, run readiness, and posting, and this
    // ad-hoc post is posting. Without it a compliance-blocked bill is payable
    // by skipping the run entirely. Vendor bills only: credits and non-bill
    // open items carry no release decision.
    if (doc.kind === "vendor_payment") {
      const targetDocIds = [...new Set(
        allocs
          .map((allocation) => byLine.get(allocation.openLineId)?.documentId)
          .filter((id): id is string => Boolean(id)),
      )];
      if (targetDocIds.length > 0) {
        const bills = (await db.execute<{
          documentId: string; documentNumber: string; partyId: string; vendorName: string;
          projectId: string | null; documentDate: string; amount: string; currency: string;
        }>(sql`
          select d.id as "documentId", d.document_number as "documentNumber", d.party_id as "partyId",
                 p.display_name as "vendorName", d.project_id as "projectId",
                 d.document_date::text as "documentDate", d.total::text as amount, d.currency
            from documents d
            join parties p on p.id = d.party_id and p.org_id = d.org_id
           where d.org_id = ${doc.orgId} and d.kind = 'vendor_bill'
             and d.id in (${sql.join(targetDocIds.map((id) => sql`${id}`), sql`, `)})`));
        if (bills.rows.length > 0) {
          const releaseDecisions = await evaluateBillsForRelease({
            orgId: doc.orgId,
            bills: bills.rows,
            asOf: await businessToday(doc.orgId),
          });
          const blockedBills = releaseDecisions.filter((decision) => decision.decision === "blocked");
          for (const decision of blockedBills) {
            await recordReleaseCheck({
              orgId: doc.orgId,
              partyId: decision.partyId,
              documentId: decision.documentId,
              stage: "manual",
              decision: "blocked",
              snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
              checkedBy: userId ?? null,
            });
          }
          if (blockedBills.length > 0) {
            throw new PaymentError(
              `subcontractor compliance blocks payment: ${blockedBills
                .map((d) => `${d.documentNumber} (${d.vendorName}) — ${d.reasons.join("; ")}`)
                .join(" | ")}`,
            );
          }
        }
      }
    }

    const deps = await paymentControlDeps(doc.orgId);
    let controlAccountId = custom.controlAccountId ?? (side === "ap" ? deps.control.ap : deps.control.ar);
    if (!custom.controlAccountId) {
      // Derive the control account from the allocation targets when they all
      // sit on ONE account that differs from the side default — e.g. employee
      // reimbursements settling expense reports on the configured
      // employee-payable control. The application writer already requires the
      // source and every target to share a control account, so deriving the
      // targets' account is the only way such a payment can post at all;
      // mixed-account allocations keep the default and fail loudly below.
      const targetAccounts = (await db.execute<{ account_id: string }>(sql`
        select distinct account_id from journal_lines where org_id = ${doc.orgId} and id in ${allocs.map((a) => a.openLineId)}
      `));
      const derived = targetAccounts.rows.length === 1 ? targetAccounts.rows[0]!.account_id : null;
      if (derived && derived !== controlAccountId) {
        controlAccountId = derived;
        // Persist the derived control so the posting rule (controlOverride)
        // and any later GL regeneration reproduce the same projection.
        await db.execute(sql`
          update documents
             set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{controlAccountId}', to_jsonb(${derived}::text), true)
           where id = ${doc.id} and org_id = ${doc.orgId}`);
        doc.custom = { ...(doc.custom as Record<string, unknown> ?? {}), controlAccountId: derived };
      }
    }
    const entryId = await postDocument(doc.id, deps, { deferEffects: true });
    const sourceResult = (await db.execute<{
      id: string; amount: string; currency: string; txn_amount: string; account_id: string;
      party_id: string | null; subsidiary_id: string; posting_date: string; period_id: string;
      book_id: string; functional_currency: string;
    }>(sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id,
             jl.subsidiary_id, je.posting_date, je.period_id, je.book_id,
             s.base_currency as functional_currency
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join subsidiaries s on s.id = jl.subsidiary_id and s.org_id = jl.org_id
       where jl.entry_id = ${entryId} and jl.org_id = ${doc.orgId} and jl.account_id = ${controlAccountId}
       limit 1
    `));
    const source = sourceResult.rows[0];
    if (!source) throw new PaymentError("posted payment entry has no AP/AR control line");
    if (source.book_id !== bookId || source.party_id !== doc.partyId || source.subsidiary_id !== doc.subsidiaryId) {
      throw new PaymentError("posted payment source must preserve its party, subsidiary, and accounting book");
    }
    if (source.currency !== doc.currency || cmp(fromUnits(toUnits(source.txn_amount) < 0n ? -toUnits(source.txn_amount) : toUnits(source.txn_amount)), add(totalAlloc, onAccountAmount)) !== 0) {
      throw new PaymentError("payment control line does not cross-foot to the transaction-currency applications");
    }

    const targetsResult = (await db.execute<{
      id: string; amount: string; currency: string; txn_amount: string; account_id: string;
      party_id: string | null; subsidiary_id: string; book_id: string; open_base: string; open_transaction: string;
    }>(sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id, jl.subsidiary_id, je.book_id,
             abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0) as open_base,
             abs(jl.txn_amount) - coalesce(sum(a.target_transaction_amount) filter (where a.unapplied_at is null), 0) as open_transaction
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
        left join applications a on a.to_line_id = jl.id and a.org_id = jl.org_id
       where jl.org_id = ${doc.orgId} and jl.id in ${allocs.map((a) => a.openLineId)}
       group by jl.id, je.book_id
    `));
    const targetById = new Map(targetsResult.rows.map((row) => [row.id, row]));

    let sourceBaseRemaining = fromUnits(toUnits(source.amount) < 0n ? -toUnits(source.amount) : toUnits(source.amount));
    // The source leg carries the applications plus any on-account remainder,
    // so the proportional base split must consume from that same wider pool —
    // otherwise the final application would absorb the remainder into its own
    // source leg and the on-account credit could never be spent.
    let sourceTransactionRemaining = add(totalAlloc, onAccountAmount);
    const applicationsToWrite: SettlementApplication[] = [];
    for (const allocation of allocs) {
      const target = targetById.get(allocation.openLineId);
      if (!target) throw new PaymentError("an application target disappeared while posting");
      if (target.account_id !== source.account_id || target.party_id !== source.party_id || target.subsidiary_id !== source.subsidiary_id || target.book_id !== source.book_id) {
        throw new PaymentError("applications must settle the same control account, party, subsidiary, and book as the payment");
      }
      const targetBase = carryingAmountForSettlement(target.open_base, target.open_transaction, allocation.targetTransactionAmount);
      if (allocation.targetBaseAmount !== undefined && cmp(allocation.targetBaseAmount, targetBase) !== 0) {
        throw new PaymentError(`saved target base amount ${allocation.targetBaseAmount} no longer matches carrying amount ${targetBase}`);
      }
      const sourceBase = carryingAmountForSettlement(sourceBaseRemaining, sourceTransactionRemaining, allocation.sourceTransactionAmount);
      const sourceSigned = cmp(source.amount, "0") > 0 ? sourceBase : neg(sourceBase);
      const targetSigned = cmp(target.amount, "0") > 0 ? targetBase : neg(targetBase);
      applicationsToWrite.push({
        fromLineId: source.id,
        toLineId: target.id,
        amount: targetBase,
        sourceAmount: sourceBase,
        sourceTransactionAmount: allocation.sourceTransactionAmount,
        sourceTransactionCurrency: doc.currency,
        targetTransactionAmount: allocation.targetTransactionAmount,
        targetTransactionCurrency: target.currency,
        settlementRate: allocation.settlementRate,
        settlementRateSource: allocation.settlementRateSource,
        settlementRateReference: allocation.settlementRateReference.trim(),
        settlementFxRateId: allocation.settlementFxRateId ?? null,
        appliedOn: source.posting_date,
        controlAdjustment: realizedFxControlAdjustment(sourceSigned, targetSigned),
      });
      sourceBaseRemaining = fromUnits(toUnits(sourceBaseRemaining) - toUnits(sourceBase));
      sourceTransactionRemaining = fromUnits(toUnits(sourceTransactionRemaining) - toUnits(allocation.sourceTransactionAmount));
    }

    const fxAdjustment = sum(applicationsToWrite.map((a) => a.controlAdjustment));
    let fxEntryId: string | null = null;
    if (!isZero(fxAdjustment)) {
      const gainLossAccountId = deps.control.fxRealizedGainLoss;
      if (!gainLossAccountId) {
        throw new PaymentError("realized FX gain/loss account is not configured");
      }
      const [fxEntry] = await db
        .insert(schema.journalEntries)
        .values({
          orgId: doc.orgId,
          bookId: source.book_id,
          subsidiaryId: source.subsidiary_id,
          entryNumber: `${doc.documentNumber}-FX`,
          postingDate: source.posting_date,
          periodId: source.period_id,
          memo: `Realized FX settlement — ${doc.documentNumber}`,
          status: "draft",
          sourceDocumentId: doc.id,
          origin: "fx_settlement",
          createdBy: userId ?? doc.createdBy,
        })
        .returning({ id: schema.journalEntries.id });
      fxEntryId = fxEntry!.id;
      await db.insert(schema.journalLines).values([
        {
          orgId: doc.orgId, entryId: fxEntryId!, lineNumber: 1, accountId: source.account_id,
          subsidiaryId: source.subsidiary_id, amount: fxAdjustment, currency: source.functional_currency,
          txnAmount: fxAdjustment, fxRate: "1", partyId: doc.partyId, isOpenItem: false,
          memo: `Realized FX settlement — ${doc.documentNumber}`,
        },
        {
          orgId: doc.orgId, entryId: fxEntryId!, lineNumber: 2, accountId: gainLossAccountId,
          subsidiaryId: source.subsidiary_id, amount: neg(fxAdjustment), currency: source.functional_currency,
          txnAmount: neg(fxAdjustment), fxRate: "1", isOpenItem: false,
          memo: `Realized FX settlement — ${doc.documentNumber}`,
        },
      ]);
      await db.update(schema.journalEntries).set({ status: "posted", postedAt: new Date(), postedBy: userId ?? doc.createdBy }).where(and(eq(schema.journalEntries.id, fxEntryId!), eq(schema.journalEntries.orgId, doc.orgId)));
    }

    // `controlAdjustment` clears in the FX entry above; the applications table
    // has no such column, so the insert lists the persisted fields explicitly.
    await db.insert(schema.applications).values(applicationsToWrite.map((a) => ({
      orgId: doc.orgId,
      fromLineId: a.fromLineId,
      toLineId: a.toLineId,
      amount: a.amount,
      sourceAmount: a.sourceAmount,
      sourceTransactionAmount: a.sourceTransactionAmount,
      sourceTransactionCurrency: a.sourceTransactionCurrency,
      targetTransactionAmount: a.targetTransactionAmount,
      targetTransactionCurrency: a.targetTransactionCurrency,
      settlementRate: a.settlementRate,
      settlementRateSource: a.settlementRateSource,
      settlementRateReference: a.settlementRateReference,
      settlementFxRateId: a.settlementFxRateId,
      appliedOn: a.appliedOn,
      fxGainLossEntryId: fxEntryId,
      createdBy: userId ?? doc.createdBy,
    })));

    if (creditAllocs.length > 0) {
      await db.insert(schema.applications).values(creditAllocs.map((application) => ({
        orgId: doc.orgId,
        fromLineId: application.fromLineId,
        toLineId: application.toLineId,
        amount: application.amount,
        sourceAmount: application.amount,
        sourceTransactionAmount: application.amount,
        sourceTransactionCurrency: source.functional_currency,
        targetTransactionAmount: application.amount,
        targetTransactionCurrency: source.functional_currency,
        settlementRate: "1",
        settlementRateSource: "same_currency" as const,
        settlementRateReference: "same transaction currency",
        appliedOn: source.posting_date,
        createdBy: userId ?? doc.createdBy,
      })));
    }

    const targetIds = [...allocs.map((a) => a.openLineId), ...creditAllocs.map((a) => a.toLineId)];
    const targets = (await db.execute<{ doc_id: string }>(sql`
      select distinct je.source_document_id as doc_id
        from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${doc.orgId} and jl.id in ${targetIds} and je.source_document_id is not null
    `));
    if (targets.rows.length > 0) {
      await db.insert(schema.documentLinks).values(targets.rows.map((target) => ({
        orgId: doc.orgId,
        fromDocumentId: doc.id,
        toDocumentId: target.doc_id,
        linkType: "pays" as const,
        createdBy: userId ?? doc.createdBy,
      })));
    }
    if (userId && auditBefore) {
      const auditAfter = await captureTransactionAuditSnapshot(db, paymentDocId, doc.orgId);
      if (!auditAfter) throw new PaymentError("payment disappeared while posting");
      await recordTransactionAudit(db, {
        orgId: doc.orgId,
        documentId: doc.id,
        action: "post",
        actorId: userId,
        source: auditSource,
        before: auditBefore,
        after: auditAfter,
      });
    }
    return { entryId };
  });

  if (!options.deferEffects) {
    await runPostDocumentEffects(paymentDocId, preflight.status);
  }
  return result;
}

/** Reverse a posted payment after a bank return and reopen its applications. */
export async function reversePaymentForReturn(
  paymentDocumentId: string,
  orgId: string,
  reason: string,
  actorId: string,
  reversalDate?: string,
): Promise<string> {
  const reversalId = await withOrg(orgId, async () => {
    const row = (await db.execute<{ id: string; posted_entry_id: string; document_number: string }>(sql`
      select d.id, d.posted_entry_id, d.document_number
        from documents d
       where d.id = ${paymentDocumentId} and d.org_id = ${orgId}
         and d.kind in ('vendor_payment', 'customer_payment') and d.status = 'posted'
       for update
    `));
    const payment = row.rows[0];
    if (!payment?.posted_entry_id) throw new PaymentError("returned payment is not posted");
    // The void-evidence CHECK caps void_reason at 500 chars, but bank return
    // reasons arrive unbounded (route text, file memos): a pasted reason
    // longer than the prefix leaves room for died at storage as a raw 500.
    // Fail closed here, naming the caller's limit, before any write.
    const reasonText = reason.trim() || payment.document_number;
    if (reasonText.length > 500 - "Bank return: ".length) {
      throw new PaymentError("bank return reason must fit the void evidence (at most 487 characters)");
    }
    const voidReason = `Bank return: ${reasonText}`;
    const reversalDay = reversalDate ?? (await businessToday(orgId));
    const stamped = await db.execute(sql`
      update documents
         set void_reason = ${voidReason},
             void_requested_at = now(),
             void_requested_by = ${actorId},
             void_reversal_date = ${reversalDay},
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${payment.id} and org_id = ${orgId}
         and status = 'posted' and void_requested_at is null
    `);
    if ((stamped.rowCount ?? 0) !== 1) {
      // The conditional stamp above is the only writer of bank-return
      // evidence, so a zero row count means a pending manual void request
      // already holds the evidence columns. The bank return supersedes it
      // with its own evidence: the opening SELECT ... FOR UPDATE runs in
      // this same transaction, so the displaced request is re-read under the
      // row lock, overwritten, preserved alongside the bank evidence in the
      // audit trail, and its requester notified — never silently adopted.
      const pending = (
        await db.execute<{
          void_reason: string | null;
          void_requested_by: string | null;
          void_reversal_date: string | null;
          status: string;
        }>(sql`
        select void_reason, void_requested_by, void_reversal_date, status
          from documents where id = ${payment.id} and org_id = ${orgId}
      `)
      ).rows[0];
      if (!pending || pending.status !== "posted") {
        // Not a supersedeable pending request (already voided, or the
        // document moved on): completion returns the existing reversal for
        // an already-voided document and throws the precise state error
        // otherwise.
        const { completeRequestedDocumentVoid } = await import("../ledger/document-void.ts");
        const existing = await completeRequestedDocumentVoid(payment.id, orgId);
        if (!existing) throw new PaymentError("payment reversal could not be created");
        return existing;
      }
      await db.execute(sql`
        update documents
           set void_reason = ${voidReason},
               void_requested_at = now(),
               void_requested_by = ${actorId},
               void_reversal_date = ${reversalDay},
               updated_at = now(),
               updated_by = ${actorId}
         where id = ${payment.id} and org_id = ${orgId}
           and status = 'posted'
      `);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${orgId}, 'documents', ${payment.id}, 'update',
                ${JSON.stringify({
                  mode: "void_evidence_superseded",
                  source: "bank_return",
                  superseded: {
                    reason: pending.void_reason,
                    requestedBy: pending.void_requested_by,
                    reversalDate: pending.void_reversal_date,
                  },
                  after: { reason: voidReason, requestedBy: actorId, reversalDate: reversalDay },
                })}::jsonb, ${actorId}, 'bank_return')
      `);
      if (pending.void_requested_by && pending.void_requested_by !== actorId) {
        await db.execute(sql`
          insert into notifications (org_id, user_id, kind, title, body, href, created_by, updated_by)
          values (${orgId}, ${pending.void_requested_by}, 'void_superseded',
                  'Void request superseded by bank return',
                  ${`Your void request for ${payment.document_number} (${pending.void_reason ?? "no reason recorded"}) was superseded by a bank return; the reversal now carries the bank evidence: ${voidReason}.`},
                  '/approvals', ${actorId}, ${actorId})
        `);
      }
    }
    const { completeRequestedDocumentVoid } = await import("../ledger/document-void.ts");
    return completeRequestedDocumentVoid(payment.id, orgId);
  });
  if (!reversalId) throw new PaymentError("payment reversal could not be created");
  return reversalId;
}

// ---------------------------------------------------------------------------
// Payment runs
// ---------------------------------------------------------------------------

interface CreatePaymentRunOptions {
  orgId: string;
  /**
   * Null for scheduler-created runs: system provenance. The historical
   * schedule author must never be recorded as performing a future automated
   * selection, and an org UUID may never enter a user actor column.
   */
  createdBy: string | null;
  paymentBankProfileId: string;
  billDocumentIds: string[];
  scheduledFor?: string | null;
  sourceScheduleId?: string | null;
  selectionCriteria?: Record<string, unknown>;
  /**
   * Durable per-occurrence claim for scheduled runs. The occurrence row is
   * inserted (or adopted) inside the creation transaction BEFORE any run
   * artifacts are written, and linked to the run in the same transaction: a
   * crash can never lose the occurrence or strand an unlinked run, and a
   * concurrent creator of the same occurrence adopts the winner's run instead
   * of duplicating it.
   */
  sourceOccurrence?: {
    scheduleId: string;
    occurrenceAt: Date;
    /** Occurrence status once this run commits: terminal draft, or awaiting scheduled submission. */
    status: "draft_created" | "awaiting_submit";
  } | null;
}

/** The storage-enforced race when another live run claims the same open item. */
export function isPaymentRunSourceClaimConflict(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code === "23505" && candidate.constraint === "payment_run_items_live_source") {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

async function recordPaymentRunCreationChecks(
  opts: CreatePaymentRunOptions,
  decisions: BillReleaseDecision[],
): Promise<void> {
  for (const decision of decisions) {
    if (!decision.compliance.tracked && decision.reasons.length === 0) continue;
    await recordReleaseCheck({
      orgId: opts.orgId,
      partyId: decision.partyId,
      documentId: decision.documentId,
      stage: "run_created",
      decision: decision.decision,
      snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
      checkedBy: opts.createdBy,
    });
  }
}

/**
 * Create an EFT payment run from selected posted vendor bills: one draft
 * vendor_payment per vendor (allocating each bill's current open balance) and
 * one payment_instruction per vendor. Nothing posts until the explicit
 * post step; the CPA-005 file is generated from the instructions.
 */
export async function createPaymentRun(opts: CreatePaymentRunOptions): Promise<{ id: string; runNumber: string }> {
  // This command deliberately owns its transaction: on a rejected selection,
  // the draft artifacts roll back before compliance evidence is committed in
  // a separate transaction. Nesting would either erase that evidence with the
  // caller or try to write it through an already-aborted transaction.
  if (orgContext.getStore()?.txDb) {
    throw new PaymentError("payment run creation cannot be nested in another database transaction");
  }
  let releaseEvaluationCompleted = false;
  let evaluatedReleaseDecisions: BillReleaseDecision[] = [];
  try {
    return await withOrgTransaction(opts.orgId, () =>
      createPaymentRunWithinTransaction(opts, (decisions) => {
        releaseEvaluationCompleted = true;
        evaluatedReleaseDecisions = decisions;
      }));
  } catch (error) {
    // Compliance checks are evidence that the control ran, including when the
    // selection is blocked or a concurrent run wins the reservation. The run
    // transaction must roll back its draft artifacts, so freeze that evidence
    // in a fresh tenant transaction before returning the creation failure.
    if (releaseEvaluationCompleted) {
      await withOrgTransaction(opts.orgId, () =>
        recordPaymentRunCreationChecks(opts, evaluatedReleaseDecisions));
    }
    if (isPaymentRunSourceClaimConflict(error)) {
      throw new PaymentError(
        "a selected bill or credit is already reserved by another live payment run",
      );
    }
    throw error;
  }
}

async function createPaymentRunWithinTransaction(
  opts: CreatePaymentRunOptions,
  onReleaseEvaluated: (decisions: BillReleaseDecision[]) => void,
): Promise<{ id: string; runNumber: string }> {
  if (opts.billDocumentIds.length === 0) throw new PaymentError("select at least one bill to pay");

  // Durable occurrence claim, before any side effect: the ledger row and the
  // run artifacts below commit atomically in this transaction. Concurrent
  // creators of the same occurrence serialize on the unique index — the loser
  // waits at the insert, then either claims a rolled-back occurrence (the
  // winner aborted, so this insert wins) or adopts the winner's committed run.
  let occurrenceId: string | null = null;
  if (opts.sourceOccurrence) {
    const claim = (await db.execute<{ id: string }>(sql`
      insert into payment_schedule_occurrences (org_id, schedule_id, occurrence_at, status)
      values (${opts.orgId}, ${opts.sourceOccurrence.scheduleId}, ${opts.sourceOccurrence.occurrenceAt}, ${opts.sourceOccurrence.status})
      on conflict (org_id, schedule_id, occurrence_at) do nothing
      returning id
    `));
    const claimedRow = claim.rows[0];
    if (claimedRow) {
      occurrenceId = claimedRow.id;
    } else {
      const existing = (await db.execute<{ id: string; paymentRunId: string | null }>(sql`
        select id::text as id, payment_run_id::text as "paymentRunId"
          from payment_schedule_occurrences
         where org_id = ${opts.orgId} and schedule_id = ${opts.sourceOccurrence.scheduleId}
           and occurrence_at = ${opts.sourceOccurrence.occurrenceAt}
         for update
      `)).rows[0];
      if (!existing) {
        throw new PaymentError("payment schedule occurrence disappeared while being claimed");
      }
      if (existing.paymentRunId) {
        const prior = (await db.execute<{ id: string; runNumber: string }>(sql`
          select id::text as id, run_number as "runNumber"
            from payment_runs
           where id = ${existing.paymentRunId} and org_id = ${opts.orgId}
        `)).rows[0];
        if (!prior) throw new PaymentError("a claimed payment schedule occurrence names a missing run");
        return prior;
      }
      // An unlinked occurrence (for example a raced empty tick): this
      // transaction now owns it and links the run below.
      occurrenceId = existing.id;
    }
  }

  const profiles = (await db.execute<{
    id: string;
    bank_account_id: string;
    subsidiary_id: string | null;
    currency: string;
    require_run_approval: boolean;
    settings: Record<string, unknown>;
    rail: string;
    direction: string;
  }>(sql`
    select p.id, p.bank_account_id, p.subsidiary_id, p.currency, p.require_run_approval, p.settings,
           f.rail, f.direction
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id and f.is_active
      join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
                        and a.type = 'asset_bank' and a.is_active and not a.is_summary
     where p.id = ${opts.paymentBankProfileId} and p.org_id = ${opts.orgId} and p.is_active
  `));
  const profile = profiles.rows[0];
  if (!profile) throw new PaymentError("payment bank profile was not found or is inactive");
  if (profile.direction === "debit") throw new PaymentError("a debit-only bank profile cannot pay vendor bills");
  const method = profile.rail === "cpa005_credit" ? "eft"
    : profile.rail === "nacha_credit" ? "ach"
    : profile.rail === "sepa_credit" ? "sepa"
    : profile.rail === "positive_pay" ? "positive_pay"
    : profile.rail === "custom" ? "custom"
    : profile.rail === "cheque" ? "cheque"
    : "wire";

  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, opts.orgId));
  if (!org) throw new PaymentError("org not found");

  // Selected bills → their open AP lines with current open balances.
  const bills = (await db.execute<{ document_id: string; document_number: string; document_kind: string; document_date: string; party_id: string; vendor: string; project_id: string | null; currency: string; fx_rate: string; subsidiary_id: string | null; control_account_id: string; open_line_id: string; open_base: string; open: string; discount_days: number | null; discount_percent: string | null }>(sql`
    select d.id as document_id, d.document_number, d.kind as document_kind, d.document_date, d.party_id, p.display_name as vendor,
           d.project_id, d.currency, d.fx_rate, d.subsidiary_id, jl.account_id as control_account_id,
           jl.id as open_line_id, abs(jl.amount) - coalesce(ap.applied, 0) as open_base,
           abs(jl.txn_amount) - coalesce(ap.transaction_applied, 0) as open,
           pt.discount_days, pt.discount_percent
      from documents d
      join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join vendor_roles vr on vr.party_id = d.party_id and vr.org_id = d.org_id
      left join payment_terms pt on pt.id = vr.payment_terms_id and pt.org_id = d.org_id and pt.is_active
      join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and jl.amount < 0
      left join lateral (
        select sum(a.amount) as applied, sum(a.target_transaction_amount) as transaction_applied from applications a
         where a.to_line_id = jl.id and a.org_id = ${opts.orgId} and a.unapplied_at is null
      ) ap on true
     where d.id in ${opts.billDocumentIds}
       and d.org_id = ${opts.orgId} and d.kind in ('vendor_bill', 'expense_report') and d.status = 'posted'
       and d.payment_hold_reason is null
       and d.currency = ${profile.currency}
       and (${profile.subsidiary_id}::uuid is null or d.subsidiary_id = ${profile.subsidiary_id})
       and not exists (
         select 1
           from payment_run_items selected
          where selected.org_id = d.org_id
            and selected.source_open_line_id = jl.id
            and selected.status = 'selected'
       )
  `));

  const found = new Set(bills.rows.map((b) => b.document_id));
  const missing = opts.billDocumentIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    // Name the bills held by another live run (bill + holding run number)
    // instead of failing the whole selection behind the generic guard
    // (F-t04-005): the operator can see exactly which selection to drop.
    const reserved = (await db.execute<{ billId: string; billNumber: string; runNumber: string }>(sql`
      select distinct i.source_document_id as "billId", d.document_number as "billNumber", r.run_number as "runNumber"
        from payment_run_items i
        join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
        join documents d on d.id = i.source_document_id and d.org_id = i.org_id
       where i.org_id = ${opts.orgId}
         and i.source_document_id = any(${`{${missing.join(',')}}`}::uuid[])
         and i.status = 'selected'
    `)).rows;
    if (reserved.length > 0) {
      const pairs = reserved.map((row) => `${row.billNumber} (${row.runNumber})`);
      const rest = missing.length - new Set(reserved.map((row) => row.billId)).size;
      throw new PaymentError(
        `${pairs.join(", ")} ${pairs.length === 1 ? "is" : "are"} already selected in another live payment run` +
        (rest > 0 ? "; other selected bills are held, closed, or do not match the profile currency and subsidiary" : ""),
      );
    }
    throw new PaymentError(
      "some selected bills are held, closed, already selected in another live payment run, or do not match the profile currency and subsidiary",
    );
  }
  const payable = bills.rows.filter((b) => cmp(b.open, "0") > 0);
  if (payable.length === 0) throw new PaymentError("all selected bills are already fully paid");

  // Apply subcontract holds and joint-check instructions before creating any
  // payment documents or instructions. A later control is caught again by the
  // final postPaymentWithApplications gate above.
  for (const bill of payable) {
    await assertSubcontractPaymentCleared(opts.orgId, bill.document_id, bill.open);
  }

  // --- subcontractor compliance -------------------------------------------
  // A bill whose vendor fails a blocking requirement (lapsed insurance, missing
  // lien waiver) never enters the run. Refusing the whole selection is
  // deliberate: silently dropping bills would leave the operator believing a
  // subcontractor had been paid. Every evaluated decision is frozen into
  // compliance_release_checks whether it cleared or not.
  const releaseDecisions = await evaluateBillsForRelease({
    orgId: opts.orgId,
    asOf: opts.scheduledFor ?? undefined,
    bills: payable.map((b) => ({
      documentId: b.document_id,
      documentNumber: b.document_number,
      partyId: b.party_id,
      vendorName: b.vendor,
      projectId: b.project_id,
      documentDate: b.document_date,
      amount: b.open,
      currency: b.currency,
    })),
  });
  onReleaseEvaluated(releaseDecisions);
  await recordPaymentRunCreationChecks(opts, releaseDecisions);
  const blockedBills = releaseDecisions.filter((d) => d.decision === "blocked");
  if (blockedBills.length > 0) {
    throw new PaymentError(
      `subcontractor compliance blocks payment: ${blockedBills
        .map((d) => `${d.documentNumber} (${d.vendorName}) — ${d.reasons.join("; ")}`)
        .join(" | ")}`,
    );
  }

  const byVendor = new Map<string, typeof payable>();
  for (const b of payable) {
    const groupKey = `${b.party_id}:${b.subsidiary_id ?? ""}:${b.control_account_id}:${b.fx_rate}`;
    const list = byVendor.get(groupKey) ?? [];
    list.push(b);
    byVendor.set(groupKey, list);
  }

  const runNumber = await nextNumber(opts.orgId, "payment_run", "RUN-");

  const run = (await db
    .insert(schema.paymentRuns)
    .values({
      orgId: opts.orgId,
      runNumber,
      bankAccountId: profile.bank_account_id,
      paymentBankProfileId: profile.id,
      subsidiaryId: profile.subsidiary_id,
      sourceScheduleId: opts.sourceScheduleId ?? null,
      method: method as "eft" | "ach" | "sepa" | "wire" | "cheque" | "positive_pay" | "custom",
      direction: "outbound",
      purpose: "vendor_payments",
      currency: profile.currency,
      selectionCriteria: opts.selectionCriteria ?? {},
      status: "draft",
      scheduledFor: opts.scheduledFor ?? null,
      createdBy: opts.createdBy,
    })
    .returning({ id: schema.paymentRuns.id, runNumber: schema.paymentRuns.runNumber }))[0]!;

  if (occurrenceId) {
    // Link the run to its occurrence inside the same transaction: the claim
    // and the run (with every payment and instruction below) commit or roll
    // back together, so the occurrence can never outlive an unlinked draft.
    await db.execute(sql`
      update payment_schedule_occurrences
         set payment_run_id = ${run.id}, status = ${opts.sourceOccurrence!.status},
             updated_at = now()
       where id = ${occurrenceId} and payment_run_id is null
    `);
  }

  const criteria = opts.selectionCriteria ?? {};
  const captureDiscounts = criteria.captureDiscounts !== false;
  const applyCredits = criteria.applyCredits !== false;
  const discountAccountId = typeof profile.settings?.discountAccountId === "string"
    ? profile.settings.discountAccountId
    : null;
  const paymentDate = opts.scheduledFor ?? await businessToday(opts.orgId);
  // Discount legs are currency money: round them to the bill currency's own
  // minor units (whole yen, whole fils), never whole cents by default — the
  // same roundCurrencyMoney project billing already applies. Resolved from
  // the tenant currencies table, like billing; an unknown currency refuses
  // the discount rather than posting sub-unit dust.
  const minorUnitsByCurrency = new Map<string, number>();
  const minorUnitsFor = async (currency: string): Promise<number> => {
    const cached = minorUnitsByCurrency.get(currency);
    if (cached !== undefined) return cached;
    const row = (await db.execute<{ minor_units: number }>(sql`
      select minor_units from currencies where code = ${currency}`)).rows[0];
    const minorUnits = row?.minor_units;
    if (minorUnits == null || !Number.isInteger(minorUnits) || minorUnits < 0 || minorUnits > 4) {
      throw new PaymentError(`the ${currency} currency has unsupported minor-unit precision`);
    }
    minorUnitsByCurrency.set(currency, minorUnits);
    return minorUnits;
  };

  for (const vendorBills of byVendor.values()) {
    const first = vendorBills[0]!;
    const partyId = first.party_id;
    const availableCredits = applyCredits ? (await db.execute<{ document_id: string; open_line_id: string; open_base: string }>(sql`
      select d.id as document_id, jl.id as open_line_id,
             abs(jl.amount) - coalesce(ap.applied, 0) as open_base
        from documents d
        join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
        join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id and jl.is_open_item and jl.amount > 0
        join subsidiaries credit_sub on credit_sub.id = jl.subsidiary_id and credit_sub.org_id = jl.org_id
        left join lateral (
          select sum(a.source_amount) as applied from applications a
           where a.from_line_id = jl.id and a.org_id = ${opts.orgId} and a.unapplied_at is null
        ) ap on true
       where d.org_id = ${opts.orgId} and d.party_id = ${partyId}
         and d.kind = 'vendor_credit' and d.status = 'posted'
         and d.currency = ${profile.currency} and jl.account_id = ${first.control_account_id}
         and jl.currency = credit_sub.base_currency
         and d.subsidiary_id is not distinct from ${first.subsidiary_id}::uuid
         and abs(jl.amount) - coalesce(ap.applied, 0) > 0
         and not exists (
           select 1
             from payment_run_items selected
            where selected.org_id = d.org_id
              and selected.source_open_line_id = jl.id
              and selected.status = 'selected'
         )
       order by d.document_date, d.document_number
    `)) : { rows: [] };
    const groupBase = vendorBills.reduce((n, b) => n + toUnits(b.open_base), 0n);
    const creditBase = availableCredits.rows.reduce((n, c) => n + toUnits(c.open_base), 0n);
    // A bank run must still move cash. If credits cover the entire group they
    // belong in a credit-application operation, not a zero-value bank file.
    const credits = creditBase > 0n && creditBase < groupBase ? availableCredits.rows : [];
    const creditRemaining = new Map(credits.map((c) => [c.open_line_id, toUnits(c.open_base)]));
    const creditAllocations: CreditAllocationInput[] = [];
    const billComposition: Array<{ bill: (typeof vendorBills)[number]; allocation: AllocationInput; creditAmount: string; discountAmount: string; paymentAmount: string }> = [];
    let discountTotal = 0n;

    for (const bill of vendorBills) {
      let remainingBase = toUnits(bill.open_base);
      let remainingTransaction = toUnits(bill.open);
      for (const credit of credits) {
        const left = creditRemaining.get(credit.open_line_id) ?? 0n;
        if (left <= 0n || remainingBase <= 0n) continue;
        const applied = left < remainingBase ? left : remainingBase;
        creditAllocations.push({
          fromLineId: credit.open_line_id,
          toLineId: bill.open_line_id,
          amount: fromUnits(applied),
          sourceDocumentId: credit.document_id,
        });
        creditRemaining.set(credit.open_line_id, left - applied);
        remainingBase -= applied;
        // This credit path only accepts functional-currency endpoints, so its
        // explicit source/target transaction amount equals the applied amount.
        remainingTransaction -= applied;
      }
      if (remainingBase <= 0n) continue;
      const remainingTxn = fromUnits(remainingTransaction);
      let discountTxn = "0";
      if (captureDiscounts && bill.discount_days != null && bill.discount_percent && cmp(bill.discount_percent, "0") > 0) {
        const deadline = new Date(`${bill.document_date}T00:00:00Z`);
        deadline.setUTCDate(deadline.getUTCDate() + bill.discount_days);
        if (paymentDate <= deadline.toISOString().slice(0, 10)) {
          const numerator = toUnits(remainingTxn) * toUnits(bill.discount_percent);
          const rawDiscount = (numerator + 500_000n) / 1_000_000n;
          discountTxn = roundCurrencyMoney(fromUnits(rawDiscount), await minorUnitsFor(bill.currency));
          if (!isZero(discountTxn) && !discountAccountId) {
            throw new PaymentError("an early-payment discount is available but the bank profile has no discount account");
          }
        }
      }
      const paymentAmount = fromUnits(toUnits(remainingTxn) - toUnits(discountTxn));
      if (cmp(paymentAmount, "0") <= 0) throw new PaymentError("discount leaves a non-positive payment amount");
      discountTotal += toUnits(discountTxn);
      billComposition.push({
        bill,
        allocation: sameCurrencyAllocation(bill.open_line_id, remainingTxn, fromUnits(remainingBase)),
        creditAmount: divRate(fromUnits(toUnits(bill.open_base) - remainingBase), bill.fx_rate),
        discountAmount: discountTxn,
        paymentAmount,
      });
    }
    const allocations = billComposition.map((c) => c.allocation);
    if (allocations.length === 0) continue;
    const total = fromUnits(allocations.reduce((n, a) => n + toUnits(a.sourceTransactionAmount), 0n) - discountTotal);

    const payment = await createPaymentDocument({
      orgId: opts.orgId,
      kind: "vendor_payment",
      createdBy: opts.createdBy,
      partyId,
      bankAccountId: profile.bank_account_id,
      // An order-converted bill carries no subsidiary (single-entity orders
      // never set one). Pass undefined so the payment inherits the payee's
      // subsidiary or the org root — the same books the bill's lines posted
      // to — instead of an explicit null whose empty scope matches no open
      // item and fails every such run with "not an open item for this party".
      subsidiaryId: first.subsidiary_id ?? undefined,
      currency: profile.currency,
      documentDate: paymentDate,
      fxRate: first.fx_rate,
      memo: `Payment run ${runNumber}`,
    });
    await updateDraftPayment(
      payment.id,
      {
        partyId,
        bankAccountId: profile.bank_account_id,
        allocations,
        creditAllocations,
        discountAmount: fromUnits(discountTotal),
        discountAccountId,
        controlAccountId: first.control_account_id,
      },
      opts.createdBy,
      opts.orgId,
    );

    // Latest approved, active bank account for the payee (may be none — the
    // file export blocks on it with a clear error, never silently).
    const payeeBank = (await db.execute<{ id: string }>(sql`
      select id from party_bank_accounts
       where party_id = ${partyId} and org_id = ${opts.orgId} and is_active and approved_at is not null
       order by approved_at desc, created_at desc limit 1
    `));

    const instruction = (await db.insert(schema.paymentInstructions).values({
      orgId: opts.orgId,
      paymentRunId: run.id,
      payeePartyId: partyId,
      payeeBankAccountId: payeeBank.rows[0]?.id ?? null,
      amount: total,
      currency: profile.currency,
      paymentDocumentId: payment.id,
      status: "pending",
      createdBy: opts.createdBy,
    }).returning({ id: schema.paymentInstructions.id }))[0]!;

    await db.insert(schema.paymentRunItems).values(billComposition.map(({ bill, creditAmount, discountAmount, paymentAmount }) => ({
      orgId: opts.orgId,
      paymentRunId: run.id,
      paymentInstructionId: instruction.id,
      sourceDocumentId: bill.document_id,
      sourceOpenLineId: bill.open_line_id,
      kind: (bill.document_kind === "expense_report" ? "expense" : "bill") as "expense" | "bill",
      grossAmount: bill.open,
      discountAmount,
      creditAmount,
      paymentAmount,
      currency: bill.currency,
      fxRate: bill.fx_rate,
      status: "selected" as const,
      createdBy: opts.createdBy,
    })));
    const creditsUsed = new Map<string, { sourceDocumentId: string; amount: bigint }>();
    for (const credit of creditAllocations) {
      const current = creditsUsed.get(credit.fromLineId);
      creditsUsed.set(credit.fromLineId, {
        sourceDocumentId: credit.sourceDocumentId,
        amount: (current?.amount ?? 0n) + toUnits(credit.amount),
      });
    }
    if (creditsUsed.size > 0) {
      await db.insert(schema.paymentRunItems).values([...creditsUsed].map(([sourceOpenLineId, used]) => ({
        orgId: opts.orgId,
        paymentRunId: run.id,
        paymentInstructionId: instruction.id,
        sourceDocumentId: used.sourceDocumentId,
        sourceOpenLineId,
        kind: "credit" as const,
        grossAmount: divRate(fromUnits(used.amount), first.fx_rate),
        discountAmount: "0",
        creditAmount: divRate(fromUnits(used.amount), first.fx_rate),
        paymentAmount: "0",
        currency: profile.currency,
        fxRate: first.fx_rate,
        status: "selected" as const,
        createdBy: opts.createdBy,
      })));
    }
  }

  await db.execute(sql`
    update payment_runs r set
      payment_count = x.payment_count,
      total_amount = x.total_amount,
      updated_at = now(), updated_by = ${opts.createdBy}
    from (
      select payment_run_id, count(*)::integer as payment_count, coalesce(sum(amount), 0) as total_amount
        from payment_instructions where org_id = ${opts.orgId} and payment_run_id = ${run.id} and status <> 'cancelled'
       group by payment_run_id
    ) x
    where r.id = x.payment_run_id and r.org_id = ${opts.orgId}
  `);
  await db.insert(schema.paymentEvents).values({
    orgId: opts.orgId,
    paymentRunId: run.id,
    eventType: "run_created",
    toStatus: "draft",
    details: {
      paymentBankProfileId: profile.id,
      sourceCount: payable.length,
      // Durable source marker: a scheduled run names its occurrence so the
      // automated selection is auditable without impersonating any user.
      ...(opts.sourceOccurrence
        ? {
            source: "payment_schedule",
            scheduleId: opts.sourceOccurrence.scheduleId,
            occurrenceAt: opts.sourceOccurrence.occurrenceAt.toISOString(),
          }
        : {}),
    },
    actorId: opts.createdBy,
  });

  return run;
}

/** The only run statuses a cancellation may consume. */
const CANCELLABLE_RUN_STATUSES = ["draft", "rejected", "rolled_back"];

/**
 * Actor identity for lifecycle writes the engine performs itself instead of an
 * operator — today, direct-debit cleanup after a failed run creation. The nil
 * UUID is the established system sentinel for actor columns without a users
 * foreign key (`payment_runs.updated_by`), so a system-initiated
 * cancellation is stamped on the mutated row itself.
 */
export const PAYMENT_RUN_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

/** Internal reason codes for engine-initiated cancellations (never user prose). */
export const PAYMENT_RUN_INTERNAL_CANCEL_REASONS = {
  /** A direct-debit collection run claimed its invoices, then creation failed. */
  directDebitCreationFailed: "direct_debit_creation_failed",
} as const;

/**
 * Cancel a draft run: void nothing — drafts are deleted, instructions cancelled.
 *
 * Cancellation evidence names who ordered it and why, and is written inside
 * the same transaction as the instruction/run mutation, so the canonical
 * `run_cancelled` payment_event and the append-only audit_log row commit or
 * roll back together with the mutation — never before it, never after it.
 *
 * Both paths are attributable by contract. A user-initiated cancellation takes
 * the permission gate's authenticated user id as `actorId` plus the
 * client-supplied validated reason, and records that user on every evidence
 * surface. An engine-initiated cancellation passes
 * {@link PAYMENT_RUN_SYSTEM_ACTOR_ID} plus an internal reason code from
 * {@link PAYMENT_RUN_INTERNAL_CANCEL_REASONS}; because payment_events and
 * audit_log key actors to users, the sentinel maps to a null evidence actor —
 * the repository-wide "system" identity — while the mutated run row still
 * carries the sentinel in `updated_by`, and `details.source` distinguishes
 * `"system"` from `"user"` in both evidence payloads.
 *
 * Cancellability is judged twice: the caller-facing preflight refuses obvious
 * non-candidates fast, and the transaction re-judges under the run row lock
 * before any child row moves. A run that leaves the cancellable set after the
 * preflight (submitted, approved, its file regenerated, or posted by a
 * concurrent operator) can therefore never be stamped `cancelled` over the
 * state another lifecycle path installed — the predicated final write proves
 * the predicate held at write time or the whole cancellation rolls back.
 */
export async function cancelPaymentRun(
  runId: string,
  orgId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  if (!actorId.trim()) throw new PaymentError("a cancellation actor is required");
  const trimmedReason = reason.trim();
  if (!trimmedReason) throw new PaymentError("a cancellation reason is required");
  const systemInitiated = actorId === PAYMENT_RUN_SYSTEM_ACTOR_ID;
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (!CANCELLABLE_RUN_STATUSES.includes(run.status)) {
    throw new PaymentError(`a ${run.status} run cannot be cancelled`);
  }

  await db.transaction(async (tx) => {
    // The run row is the cancellation claim: lock it before judging or
    // mutating anything, serializing against posters, generators, and
    // settlement writers in their shared lock order.
    const locked = (await tx.execute<{ status: string }>(sql`
      select status
        from payment_runs
       where id = ${runId} and org_id = ${orgId}
        for update
    `)).rows[0];
    if (!locked) throw new PaymentError("payment run not found");
    if (!CANCELLABLE_RUN_STATUSES.includes(locked.status)) {
      throw new PaymentError(`a ${locked.status} run cannot be cancelled`);
    }
    const instructions = await tx
      .select()
      .from(schema.paymentInstructions)
      .where(and(eq(schema.paymentInstructions.paymentRunId, runId), eq(schema.paymentInstructions.orgId, orgId)));

    for (const ins of instructions) {
      // Release the FK to the draft payment before deleting it.
      await tx
        .update(schema.paymentInstructions)
        .set({ status: "cancelled", paymentDocumentId: null, updatedAt: new Date() })
        .where(and(eq(schema.paymentInstructions.id, ins.id), eq(schema.paymentInstructions.orgId, orgId)));
      if (ins.paymentDocumentId) {
        const [doc] = await tx
          .select({ status: schema.documents.status })
          .from(schema.documents)
          .where(and(eq(schema.documents.id, ins.paymentDocumentId), eq(schema.documents.orgId, orgId)));
        if (doc && doc.status !== "draft") {
          throw new PaymentError("run has payments that are no longer drafts — it cannot be cancelled");
        }
        await tx.execute(sql`delete from document_lines where document_id = ${ins.paymentDocumentId} and org_id = ${orgId}`);
        await tx.execute(sql`delete from documents where id = ${ins.paymentDocumentId} and org_id = ${orgId}`);
      }
    }
    // Predicated on the same statuses judged under the lock above: a run that
    // changed state while this transaction worked cannot become `cancelled`.
    const cancelled = await tx.execute<{ id: string }>(sql`
      update payment_runs
         set status = 'cancelled', updated_at = now(), updated_by = ${actorId}
        where id = ${runId} and org_id = ${orgId}
          and status in ('draft', 'rejected', 'rolled_back')
        returning id
    `);
    if (!cancelled.rows[0]) {
      throw new PaymentError("the run changed state while it was being cancelled");
    }
    // Canonical lifecycle evidence, only after the mutation proved its own
    // predicate: the event feeds the run activity feed, the append-only audit
    // row is the auditor's before/after proof. Both sit inside this
    // transaction, so a refusal anywhere above leaves no trace of a
    // cancellation that never happened. A system-initiated cancellation
    // carries the null actor (the repository-wide "system" identity on these
    // user-keyed evidence tables); the sentinel itself is already stamped on
    // the run row above.
    await tx.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: "run_cancelled",
      fromStatus: locked.status,
      toStatus: "cancelled",
      details: { reason: trimmedReason, source: systemInitiated ? "system" : "user" },
      actorId: systemInitiated ? null : actorId,
    });
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'payment_runs', ${runId}, 'void',
              ${JSON.stringify({ before: { status: locked.status }, after: { status: "cancelled" }, reason: trimmedReason, source: systemInitiated ? "system" : "user" })}::jsonb,
              ${systemInitiated ? null : actorId})
    `);
  });
}

export interface RunBlocker {
  instructionId: string;
  payee: string;
  reason: string;
  /** 'bank' = payee bank details; 'compliance' = subcontractor compliance. */
  source?: "bank" | "compliance";
}

/**
 * Re-evaluate subcontractor compliance for every bill still in a run.
 *
 * A run created on Monday can be released on Friday, by which time a
 * certificate may have lapsed. The control therefore runs again at readiness
 * and at posting — a release is never authorised by a stale evaluation.
 */
export async function paymentRunComplianceDecisions(
  runId: string,
  orgId: string,
): Promise<Array<BillReleaseDecision & { instructionId: string; payee: string }>> {
  const rows = (await db.execute<{
      instruction_id: string;
      payee_party_id: string;
      payee: string;
      document_id: string;
      document_number: string;
      project_id: string | null;
      document_date: string;
      payment_amount: string;
      currency: string;
    }>(sql`
    select i.id as instruction_id, i.payee_party_id, p.display_name as payee,
           d.id as document_id, d.document_number, d.project_id, d.document_date,
           ri.payment_amount, ri.currency
      from payment_run_items ri
      join payment_instructions i on i.id = ri.payment_instruction_id and i.org_id = ri.org_id
      join documents d on d.id = ri.source_document_id and d.org_id = ri.org_id
      join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
     where ri.payment_run_id = ${runId} and ri.org_id = ${orgId}
       and i.status <> 'cancelled' and ri.kind <> 'credit'
  `));
  if (rows.rows.length === 0) return [];
  const decisions = await evaluateBillsForRelease({
    orgId,
    bills: rows.rows.map((r) => ({
      documentId: r.document_id,
      documentNumber: r.document_number,
      partyId: r.payee_party_id,
      vendorName: r.payee,
      projectId: r.project_id,
      documentDate: r.document_date,
      amount: r.payment_amount,
      currency: r.currency,
    })),
  });
  return decisions.map((d, i) => ({
    ...d,
    instructionId: rows.rows[i]!.instruction_id,
    payee: rows.rows[i]!.payee,
  }));
}

/**
 * The bank-file rails that carry payee bank details and therefore gate on the
 * bank-details approval workflow (cheque/positive_pay print no account data).
 */
export type RailBankMethod = "ach" | "sepa" | "eft";

/**
 * The resolved — and control-checked — bank detail one instruction would put
 * on a rail file. `ok:false` carries the exact readiness reason so the run
 * view and every file writer speak the same control language; on success each
 * rail reads its own fields (ach→routingNumber/savings, sepa→iban/bic,
 * eft→institution/transit), all backed by the same decrypted account number.
 */
export type RailBankDetail =
  | { ok: false; reason: string }
  | {
      ok: true;
      routingNumber: string | null;
      iban: string | null;
      bic: string | null;
      institution: string | null;
      transit: string | null;
      accountNumber: string;
      savings: boolean;
    };

type BankDetailRow = {
  approved_at: string | null;
  is_active: boolean | null;
  currency: string;
  routing: Record<string, string> | null;
  account_number_encrypted: string | null;
};

/**
 * Resolve the bank detail a rail export would carry for one instruction, and
 * name the control it fails. This is THE single mechanism behind payee bank
 * evidence: `paymentRunReadiness` shows it as blockers, and every file writer
 * (CPA-005 / NACHA / SEPA) consumes its resolved values — what is displayed,
 * what is blocked, and what is exported can never diverge. An unapproved or
 * inactive revision fails here on every rail.
 */
function resolveRailBankDetail(
  method: RailBankMethod,
  row: BankDetailRow,
): RailBankDetail {
  if (!row.approved_at) return { ok: false, reason: "bank account is not approved" };
  if (!row.is_active) return { ok: false, reason: "bank account is inactive" };
  const routing = row.routing ?? {};
  if (method === "eft" && !/^\d{3}$/.test(routing.institution ?? "")) {
    return { ok: false, reason: "missing/invalid 3-digit institution number" };
  }
  if (method === "eft" && !/^\d{5}$/.test(routing.transit ?? "")) {
    return { ok: false, reason: "missing/invalid 5-digit transit number" };
  }
  if (!row.account_number_encrypted) {
    return { ok: false, reason: "missing account number" };
  }
  const accountNumber = decryptAccountNumber(row.account_number_encrypted);
  const aba = routing.aba ?? routing.routingNumber ?? routing.routing ?? "";
  const iban = (routing.iban ?? accountNumber).replace(/\s/g, "");
  if (
    method === "ach" &&
    (!/^\d{9}$/.test(aba) || nachaCheckDigit(aba.slice(0, 8)) !== aba[8])
  ) {
    return { ok: false, reason: "missing/invalid 9-digit routing number" };
  }
  if (method === "sepa" && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
    return { ok: false, reason: "missing/invalid IBAN" };
  }
  if (method === "eft" && row.currency !== "CAD") {
    return { ok: false, reason: `CPA-005 CAD file cannot carry ${row.currency}` };
  }
  return {
    ok: true,
    routingNumber: /^\d{9}$/.test(aba) ? aba : null,
    iban: /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban) ? iban : null,
    bic: routing.bic ?? null,
    institution: routing.institution ?? null,
    transit: routing.transit ?? null,
    accountNumber,
    savings: routing.accountType === "savings",
  };
}

/**
 * Read every payable instruction's bank evidence under one transaction that
 * also validates it, closing the read-validate-export gap for all three rails
 * with one mechanism.
 *
 * Each referenced party_bank_accounts row is locked FOR UPDATE inside the same
 * transaction that resolves its detail. Under READ COMMITTED the locking read
 * re-reads the latest committed version once the lock is granted, so exactly
 * one of two outcomes is possible when a maker edit races an export:
 *
 *   - the edit committed first → this call sees `pending` + inactive and
 *     hard-blocks before anything is rendered; or
 *   - the export locked first → the edit waits behind it and the file carries
 *     the APPROVED revision the run was built against.
 *
 * A pending edit can never be what a payment file contains, and because the
 * validation runs here — before any caller renders bytes or writes artifacts —
 * a blocked export leaves no partial file and no partial audit trail.
 */
async function lockRunBankEvidence(
  method: RailBankMethod,
  runId: string,
  orgId: string,
): Promise<Array<{ id: string; amount: string; payee: string; documentNumber: string | null; detail: Extract<RailBankDetail, { ok: true }> }>> {
  return withOrgTransaction(orgId, async () => {
    const instructions = (await db.execute<{
        id: string;
        amount: string;
        currency: string;
        payee: string;
        payee_bank_account_id: string | null;
        document_number: string | null;
      }>(sql`
      select i.id, i.amount, i.currency, p.display_name as payee,
             i.payee_bank_account_id, d.document_number
        from payment_instructions i
        join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
        left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
       where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
       order by p.display_name, i.id
    `));
    if (instructions.rows.length === 0) throw new PaymentError("run has no payable instructions");

    // Deterministic lock acquisition (single statement) keeps concurrent
    // exports of one run from deadlocking each other.
    const bankIds = [
      ...new Set(
        instructions.rows
          .map((r) => r.payee_bank_account_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const banks = bankIds.length > 0
      ? await db
          .select({
            id: schema.partyBankAccounts.id,
            approvedAt: schema.partyBankAccounts.approvedAt,
            isActive: schema.partyBankAccounts.isActive,
            routing: schema.partyBankAccounts.routing,
            accountNumberEncrypted: schema.partyBankAccounts.accountNumberEncrypted,
          })
          .from(schema.partyBankAccounts)
          .where(and(eq(schema.partyBankAccounts.orgId, orgId), inArray(schema.partyBankAccounts.id, bankIds)))
          .for("update")
      : [];
    const byId = new Map(banks.map((b) => [b.id, b]));

    const evidence: Array<{ id: string; amount: string; payee: string; documentNumber: string | null; detail: Extract<RailBankDetail, { ok: true }> }> = [];
    const blockers: string[] = [];
    for (const r of instructions.rows) {
      const bank = r.payee_bank_account_id ? byId.get(r.payee_bank_account_id) : undefined;
      if (!bank) {
        blockers.push(`${r.payee} (no approved bank account on file)`);
        continue;
      }
      // The CPA-005 currency control keys off the INSTRUCTION's currency — the
      // currency the run actually pays in.
      const detail = resolveRailBankDetail(method, {
        approved_at: bank.approvedAt,
        is_active: bank.isActive,
        currency: r.currency,
        routing: bank.routing,
        account_number_encrypted: bank.accountNumberEncrypted,
      });
      if (!detail.ok) {
        blockers.push(`${r.payee} (${detail.reason})`);
        continue;
      }
      evidence.push({ id: r.id, amount: r.amount, payee: r.payee, documentNumber: r.document_number, detail });
    }
    if (blockers.length > 0) {
      throw new PaymentError(`cannot generate the payment file: ${blockers.join("; ")}`);
    }
    return evidence;
  });
}

/**
 * Everything the run detail view and the file export need to agree on:
 * EFT settings state, per-instruction bank-detail blockers, and subcontractor
 * compliance blockers.
 */
export async function paymentRunReadiness(runId: string, orgId: string): Promise<{
  eft: EftSettingsResult;
  blockers: RunBlocker[];
}> {
  const runInfo = (await db.execute<{ method: string; rail: string | null }>(sql`
    select r.method, f.rail
      from payment_runs r
      left join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
      left join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
     where r.id = ${runId} and r.org_id = ${orgId}
  `));
  const method = runInfo.rows[0]?.method;
  let eft: EftSettingsResult;
  if (method === "ach") eft = await loadNachaSettings(orgId, runId) as EftSettingsResult;
  else if (method === "sepa") eft = await loadSepaSettings(orgId, runId) as EftSettingsResult;
  else if (method === "eft") eft = await loadEftSettings(orgId, runId);
  else eft = { ok: true, settings: {} as EftSettings };
  const rows = (await db.execute<{
      id: string;
      payee: string;
      payee_bank_account_id: string | null;
      approved_at: string | null;
      is_active: boolean | null;
      routing: Record<string, string> | null;
      account_number_encrypted: string | null;
      currency: string;
    }>(sql`
    select i.id, p.display_name as payee, i.payee_bank_account_id,
           b.approved_at, b.is_active, b.routing, b.account_number_encrypted, i.currency
      from payment_instructions i
      join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
      left join party_bank_accounts b on b.id = i.payee_bank_account_id and b.org_id = i.org_id
     where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
  `));

  const blockers: RunBlocker[] = [];
  for (const r of rows.rows) {
    if (method === "cheque" || method === "positive_pay") continue;
    if (!r.payee_bank_account_id) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "no approved bank account on file" });
      continue;
    }
    // Only the three bank-detail rails carry account evidence; every other
    // method (and any custom value) is gated elsewhere or not at all.
    if (method !== "ach" && method !== "sepa" && method !== "eft") continue;
    const detail = resolveRailBankDetail(method, r);
    if (!detail.ok) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: detail.reason });
    }
  }
  for (const blocker of blockers) blocker.source = "bank";

  // Compliance is re-evaluated here rather than trusted from run creation, and
  // the outcome is frozen so the run's readiness state is evidenced, not just
  // displayed.
  const compliance = await paymentRunComplianceDecisions(runId, orgId);
  for (const decision of compliance) {
    if (decision.decision === "cleared") continue;
    await recordReleaseCheck({
      orgId,
      partyId: decision.partyId,
      documentId: decision.documentId,
      paymentRunId: runId,
      paymentInstructionId: decision.instructionId,
      stage: "readiness",
      decision: decision.decision,
      snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
    });
    if (decision.decision !== "blocked") continue;
    blockers.push({
      instructionId: decision.instructionId,
      payee: decision.payee,
      reason: `${decision.documentNumber}: ${decision.reasons.join("; ")}`,
      source: "compliance",
    });
  }
  return { eft, blockers };
}

/**
 * A posting claim that has made no progress for this long is treated as
 * abandoned: a new poster may recover it, fencing the old worker at its next
 * completion write. Mirrors the durable-work lease window.
 */
export const PAYMENT_RUN_POSTING_CLAIM_STALE_MS = 15 * 60_000;

type PostingClaim = { token: string };

/**
 * Take exclusive ownership of a run's posting lifecycle.
 *
 * The run row is the single claim primitive: `processing` plus a random
 * per-claim token. A fresh claim fences every prior worker; a stale claim
 * (no heartbeat within the window) is recovered by replacing its token, so a
 * crashed poster can never wedge the run — and can never double-post either,
 * because instructions already committed as `sent` are not pending anymore.
 * A run parked in a terminal status by an out-of-band settlement writer is
 * claimable only while pending instructions remain (see the gate below).
 */
async function claimPaymentRunForPosting(
  runId: string,
  orgId: string,
  userId: string,
): Promise<PostingClaim> {
  return withOrgTransaction(orgId, async () => {
    const locked = (await db.execute<{
      status: string;
      token: string | null;
    }>(sql`
      select status, posting_claim_token as token
        from payment_runs
       where id = ${runId} and org_id = ${orgId}
       for update
    `)).rows[0];
    if (!locked) throw new PaymentError("payment run not found");

    if (locked.status === "processing") {
      // Recovery path: only an abandoned lease may be taken over. The
      // staleness judgement uses the database clock so app-side skew cannot
      // resurrect a live worker's claim.
      const stale = (await db.execute<{ stale: boolean }>(sql`
        select (posting_claimed_at is null or
                posting_claimed_at <= now() - ${PAYMENT_RUN_POSTING_CLAIM_STALE_MS} * interval '1 millisecond') as stale
          from payment_runs
         where id = ${runId} and org_id = ${orgId} and status = 'processing'
      `)).rows[0]?.stale;
      if (!stale) throw new PaymentError("run is already being posted");
      const recovered = await db.execute<{ token: string }>(sql`
        update payment_runs
           set posting_claim_token = gen_random_uuid(),
               posting_claimed_at = now(),
               posting_claimed_by = ${userId},
               updated_at = now(),
               updated_by = ${userId}
         where id = ${runId} and org_id = ${orgId} and status = 'processing'
         returning posting_claim_token as token
      `);
      const recovery = recovered.rows[0];
      if (!recovery?.token) throw new PaymentRunPostingClaimFencedError(runId);
      await db.insert(schema.paymentEvents).values({
        orgId,
        paymentRunId: runId,
        eventType: "run_posting_recovered",
        fromStatus: "processing",
        toStatus: "processing",
        details: { reason: "the previous posting claim stopped making progress" },
        actorId: userId,
      });
      return { token: recovery.token };
    }

    if (!["generated", "delivered", "partially_failed"].includes(locked.status)) {
      if (!["confirmed", "settled", "returned"].includes(locked.status)) {
        throw new PaymentError("generate and download the EFT file before posting the run");
      }
      // A bank-return settlement stamps the WHOLE run terminal even while
      // sibling instructions are still pending — a return racing a mid-flight
      // poster fences it and leaves the rest unsent behind a status the claim
      // gate used to treat as "already posted" forever. Completion is judged
      // by the actual remainder under this lock, never by the label alone:
      // with nothing pending the refusal stands; with work left, the run is
      // re-claimed and exactly the outstanding instructions are finished.
      const pending = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n
          from payment_instructions
         where payment_run_id = ${runId} and org_id = ${orgId} and status = 'pending'
      `)).rows[0]!.n;
      if (pending === 0) throw new PaymentError("run is already posted");
    }
    const claimed = await db.execute<{ token: string }>(sql`
      update payment_runs
         set status = 'processing',
             posting_claim_token = gen_random_uuid(),
             posting_claimed_at = now(),
             posting_claimed_by = ${userId},
             updated_at = now(),
             updated_by = ${userId}
       where id = ${runId} and org_id = ${orgId} and status = ${locked.status}
       returning posting_claim_token as token
    `);
    const fresh = claimed.rows[0];
    if (!fresh?.token) throw new PaymentRunPostingClaimFencedError(runId);
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: "run_posting_started",
      fromStatus: locked.status,
      toStatus: "processing",
      actorId: userId,
    });
    return { token: fresh.token };
  });
}

type ClaimedPaymentInstructionResult =
  | { status: "sent"; paymentDocumentId: string; runEffects: boolean }
  | { status: "failed"; error: string };

/**
 * Re-assert exclusive ownership of the posting lifecycle (fence + heartbeat).
 *
 * Zero rows means the claim was replaced or retired while we worked: fail
 * closed before touching any child row. When the claim holds, the token is
 * published to the storage layer for the remainder of this transaction — the
 * payment-instruction fence trigger (migration 0015) rejects any instruction
 * mutation on this run from a writer that presents none or a superseded token,
 * so downstream instruction writes cannot outrun the claim that authorizes
 * them even through a future call path that forgets to check.
 */
async function assertPostingClaimLive(
  runId: string,
  orgId: string,
  claim: PostingClaim,
): Promise<void> {
  const fenced = await db.execute<{ id: string }>(sql`
    update payment_runs
       set posting_claimed_at = now()
     where id = ${runId} and org_id = ${orgId}
       and status = 'processing'
       and posting_claim_token = ${claim.token}
     returning id
  `);
  if (!fenced.rows[0]) throw new PaymentRunPostingClaimFencedError(runId);
  await db.execute(sql`
    select set_config('openbooks.payment_run_claim', ${`${runId}:${claim.token}`}, true)
  `);
}

/**
 * Post one instruction of a claimed run as a single atomic unit: the claim
 * fence (+ heartbeat), the document's approval submission, the journal post
 * with applications, the instruction flip to `sent`, and its evidence either
 * all commit or none do. Every later writer on the run takes the run row
 * first in the same order, so settlement chooses one side of this commit:
 * before it (which fences this worker), or after it.
 */
async function postClaimedPaymentInstruction(
  runId: string,
  orgId: string,
  userId: string,
  instructionId: string,
  claim: PostingClaim,
): Promise<ClaimedPaymentInstructionResult> {
  return withOrgTransaction(orgId, async () => {
    await assertPostingClaimLive(runId, orgId, claim);

    const instruction = (await db.execute<{
      id: string;
      payment_document_id: string | null;
      status: string;
      document_status: string | null;
    }>(sql`
      select instruction.id, instruction.payment_document_id, instruction.status,
             document.status as document_status
        from payment_instructions instruction
        left join documents document
          on document.id = instruction.payment_document_id
         and document.org_id = instruction.org_id
       where instruction.id = ${instructionId}
         and instruction.payment_run_id = ${runId}
         and instruction.org_id = ${orgId}
       for update of instruction
    `)).rows[0];
    if (!instruction || instruction.status !== "pending") {
      return { status: "failed", error: "payment instruction changed while its run was being posted" };
    }
    if (!instruction.payment_document_id) {
      return { status: "failed", error: "instruction has no payment document" };
    }

    // A payment posted individually from its own flyout only needs its run
    // instruction advanced. Every other document still passes through the
    // ordinary approval and posting boundaries.
    if (instruction.document_status !== "posted") {
      if (instruction.document_status === "draft") {
        const submission = await submitAndReleaseIfUngated(
          "vendor_payment",
          instruction.payment_document_id,
          userId,
        );
        if (submission.flowError) {
          return { status: "failed", error: `approval could not be routed: ${submission.flowError}` };
        }
        if (submission.gated) {
          return {
            status: "failed",
            error: "the payment was submitted for transaction approval and has not been sent",
          };
        }
      } else if (instruction.document_status !== "approved") {
        return {
          status: "failed",
          error: `the payment document is ${instruction.document_status}; only an approved payment can be sent`,
        };
      }
      await postPaymentWithApplications(
        instruction.payment_document_id,
        undefined,
        userId,
        "ui",
        { deferEffects: true },
      );
    }
    const sent = await db.execute<{ id: string }>(sql`
      update payment_instructions
         set status = 'sent', updated_at = now(), updated_by = ${userId}
       where id = ${instruction.id} and payment_run_id = ${runId}
         and org_id = ${orgId} and status = 'pending'
       returning id
    `);
    if (!sent.rows[0]) {
      throw new PaymentError("payment instruction changed while its run was being posted");
    }
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      paymentInstructionId: instruction.id,
      eventType: "instruction_sent",
      fromStatus: "pending",
      toStatus: "sent",
      actorId: userId,
    });
    return {
      status: "sent",
      paymentDocumentId: instruction.payment_document_id,
      runEffects: instruction.document_status !== "posted",
    };
  });
}

/**
 * Complete a claimed run under its claim. Instruction completeness is judged
 * here rather than trusted from the caller's tally: a confirmed verdict is
 * only available when no instruction is left pending, otherwise the run ends
 * partially failed (and retryable) instead of pretending everything sent.
 * A run whose instructions include bank returns keeps the aggregate
 * `returned` marker the settlement writer installed — completing the leftover
 * work must not quietly rebrand a returned run as fully confirmed.
 */
async function finishPaymentRunPosting(
  runId: string,
  orgId: string,
  userId: string,
  requestedStatus: "confirmed" | "partially_failed",
  details: Record<string, unknown>,
  claim: PostingClaim,
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    await assertPostingClaimLive(runId, orgId, claim);
    // Email delivery is confirmed by the worker after provider acceptance, so
    // reconcile any remittance rows that became sent while this run was
    // posting before the instruction/run terminal transition commits.
    await db.execute(sql`
      update payment_instructions instruction
         set remittance_email_sent_at = coalesce(instruction.remittance_email_sent_at, remittance.sent_at),
             updated_at = now(),
             updated_by = ${userId}
        from payment_remittances remittance
       where remittance.payment_instruction_id = instruction.id
         and remittance.org_id = instruction.org_id
         and remittance.status = 'sent'
         and instruction.payment_run_id = ${runId}
         and instruction.org_id = ${orgId}
         and instruction.remittance_email_sent_at is null
    `);
    const tally = (await db.execute<{ pending: number; returned: number }>(sql`
      select count(*) filter (where status = 'pending')::int as pending,
             count(*) filter (where status in ('returned', 'rejected'))::int as returned
        from payment_instructions
       where payment_run_id = ${runId} and org_id = ${orgId}
    `)).rows[0]!;
    const status = tally.pending > 0
      ? "partially_failed"
      : tally.returned > 0 && requestedStatus === "confirmed"
        ? "returned"
        : requestedStatus;
    const completed = await db.execute<{ id: string }>(sql`
      update payment_runs
         set status = ${status},
             posting_claim_token = null,
             posting_claimed_at = null,
             posting_claimed_by = null,
             updated_at = now(),
             updated_by = ${userId}
       where id = ${runId} and org_id = ${orgId}
         and status = 'processing'
         and posting_claim_token = ${claim.token}
       returning id
    `);
    if (!completed.rows[0]) throw new PaymentRunPostingClaimFencedError(runId);
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: status === "partially_failed" ? "run_posting_failed" : "run_posting_completed",
      fromStatus: "processing",
      toStatus: status,
      details: tally.pending > 0 ? { ...details, incompleteInstructions: tally.pending } : details,
      actorId: userId,
    });
  });
}

/**
 * Best-effort release when a claimed run dies unexpectedly between
 * instructions. Returns false — without writing anything — when the claim no
 * longer exists, leaving whatever terminal state another writer installed.
 */
async function releaseFailedPaymentRunPosting(
  runId: string,
  orgId: string,
  userId: string,
  error: unknown,
  claim: PostingClaim,
): Promise<boolean> {
  return withOrgTransaction(orgId, async () => {
    const released = await db.execute<{ id: string }>(sql`
      update payment_runs
         set status = 'partially_failed',
             posting_claim_token = null,
             posting_claimed_at = null,
             posting_claimed_by = null,
             updated_at = now(),
             updated_by = ${userId}
       where id = ${runId} and org_id = ${orgId}
         and status = 'processing'
         and posting_claim_token = ${claim.token}
       returning id
    `);
    if (!released.rows[0]) return false;
    await db.insert(schema.paymentEvents).values({
      orgId,
      paymentRunId: runId,
      eventType: "run_posting_failed",
      fromStatus: "processing",
      toStatus: "partially_failed",
      details: { error: error instanceof Error ? error.message : String(error) },
      actorId: userId,
    });
    return true;
  });
}

/**
 * Post every pending instruction's payment document (+ applications).
 *
 * The run's explicit `processing` state plus its per-claim token is the sole
 * posting claim: each instruction commits only while that claim is still
 * owned (fencing terminal transitions and recovered claims), effects drain
 * after the instruction commits with the outbox row written in-transaction as
 * the durable retry, and final status plus its evidence commit together under
 * the same claim. A crashed poster leaves the run resumable — the next
 * attempt recovers the stale claim and completes exactly the still-pending
 * instructions; the same holds for a run a bank-return settlement drove to a
 * terminal label while instructions were still pending.
 */
export async function postPaymentRun(
  runId: string,
  orgId: string,
  userId: string,
): Promise<{ posted: number; failures: { payee: string; error: string }[] }> {
  // This command owns a lifecycle that spans several separate transactions:
  // the claim must commit durably before any instruction work begins, every
  // instruction commits under the still-live claim, and completion (or
  // release) commits last. Joined to an ambient transaction, the claim would
  // stay invisible to other workers until that outer unit ended — inviting a
  // second poster through the claim gate — the per-step fencing would collapse
  // into one transaction, and an outer rollback would erase instruction sends
  // whose post-commit effects already ran. Fail closed instead.
  if (orgContext.getStore()?.txDb) {
    throw new PaymentError("payment run posting cannot be nested in another database transaction");
  }
  const claim = await claimPaymentRunForPosting(runId, orgId, userId);
  try {
    const instructions = await db.execute<{ id: string; payee: string }>(sql`
      select instruction.id, party.display_name as payee
        from payment_instructions instruction
        join parties party
          on party.id = instruction.payee_party_id
         and party.org_id = instruction.org_id
       where instruction.payment_run_id = ${runId}
         and instruction.org_id = ${orgId}
         and instruction.status = 'pending'
       order by party.display_name, instruction.id
    `);

    // Final compliance gate. Posting is the irreversible step, so the control
    // runs once more against today's evidence and blocks one instruction rather
    // than stranding every other payee in the run.
    const complianceByInstruction = new Map<string, (BillReleaseDecision & { instructionId: string })[]>();
    for (const decision of await paymentRunComplianceDecisions(runId, orgId)) {
      const list = complianceByInstruction.get(decision.instructionId) ?? [];
      list.push(decision);
      complianceByInstruction.set(decision.instructionId, list);
    }

    let posted = 0;
    const failures: { payee: string; error: string }[] = [];
    for (const instruction of instructions.rows) {
      try {
        const decisions = complianceByInstruction.get(instruction.id) ?? [];
        for (const decision of decisions) {
          if (decision.decision === "cleared") continue;
          await recordReleaseCheck({
            orgId,
            partyId: decision.partyId,
            documentId: decision.documentId,
            paymentRunId: runId,
            paymentInstructionId: instruction.id,
            stage: "run_posted",
            decision: decision.decision,
            snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
            checkedBy: userId,
          });
        }
        const blocked = decisions.filter((decision) => decision.decision === "blocked");
        if (blocked.length > 0) {
          failures.push({
            payee: instruction.payee,
            error: `subcontractor compliance blocks release: ${blocked
              .map((decision) => `${decision.documentNumber} — ${decision.reasons.join("; ")}`)
              .join(" | ")}`,
          });
          continue;
        }

        const result = await postClaimedPaymentInstruction(
          runId,
          orgId,
          userId,
          instruction.id,
          claim,
        );
        if (result.status === "failed") {
          failures.push({ payee: instruction.payee, error: result.error });
          continue;
        }
        if (result.runEffects) {
          try {
            await runPostDocumentEffects(result.paymentDocumentId, "approved");
          } catch (error) {
            // Effects are at-least-once: enqueuePostingEffects wrote the
            // outbox row inside the posting transaction, so processDuePostingEffects
            // redrives anything this best-effort drain could not finish.
            console.error(
              `[payments] post-commit effects failed for payment ${result.paymentDocumentId}:`,
              error,
            );
          }
        }
        try {
          await queueAutomaticRemittance(runId, instruction.id, orgId, userId, claim);
        } catch (error) {
          if (error instanceof PaymentRunPostingClaimFencedError) throw error;
          console.error(`[payments] automatic remittance failed for instruction ${instruction.id}:`, error);
        }
        posted += 1;
      } catch (error) {
        if (error instanceof PaymentRunPostingClaimFencedError) throw error;
        failures.push({
          payee: instruction.payee,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const finalStatus = failures.length === 0 ? "confirmed" : "partially_failed";
    // The per-instruction reasons persist on the run event — not just in the
    // POST response — so the activity feed can name them after the toast
    // dismisses and the clerk can fix and retry (F-t03-005). Counts alone
    // left "0 sent · N failed" with no reason anywhere.
    await finishPaymentRunPosting(runId, orgId, userId, finalStatus, {
      posted,
      failureCount: failures.length,
      failures,
    }, claim);
    return { posted, failures };
  } catch (error) {
    if (error instanceof PaymentRunPostingClaimFencedError) throw error;
    if (!(await releaseFailedPaymentRunPosting(runId, orgId, userId, error, claim))) {
      throw new PaymentRunPostingClaimFencedError(runId);
    }
    throw error;
  }
}

/**
 * Queue the payee's automatic remittance advice for one instruction the
 * worker just posted under its posting claim.
 *
 * Authority is re-proven at every step that writes: staging (the durable
 * remittance row) happens in one fenced transaction whose insert is
 * conditioned on the claim still being live. Enqueueing is outside that
 * transaction, and the email worker later records provider acceptance on the
 * remittance row; payment-run completion reconciles the resulting instruction
 * stamp under its own live claim. A worker superseded during staging therefore
 * leaves no evidence row behind, while a crash between staging and enqueue can
 * safely retry the same pending row and deterministic queue job. Network I/O
 * never holds payment row locks.
 */
async function queueAutomaticRemittance(
  runId: string,
  instructionId: string,
  orgId: string,
  userId: string,
  claim: PostingClaim,
): Promise<void> {
  const staged = await withOrgTransaction(orgId, async () => {
    await assertPostingClaimLive(runId, orgId, claim);
    const row = (await db.execute<{ id: string; amount: string; currency: string; payment_reference: string | null; document_number: string | null; payment_date: string; payee: string; email: string | null; auto_remittance: boolean; direction: string; org_name: string }>(sql`
      select i.id, i.amount, i.currency, i.payment_reference, d.document_number,
             coalesce(r.scheduled_for, d.document_date) as payment_date,
             p.display_name as payee, vr.eft_notification_email as email,
             bp.auto_remittance, r.direction, o.name as org_name
        from payment_instructions i
        join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
        join payment_bank_profiles bp on bp.id = r.payment_bank_profile_id and bp.org_id = i.org_id
        join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
        left join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id
        left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
        join orgs o on o.id = i.org_id
       where i.id = ${instructionId} and i.org_id = ${orgId}
    `)).rows[0];
    if (!row?.auto_remittance || row.direction !== "outbound") return null;
    const already = (await db.execute<{
      id: string;
      status: "pending" | "sent";
      recipients: string[] | null;
    }>(sql`
      select id, status, recipients
        from payment_remittances
       where payment_instruction_id = ${instructionId}
         and org_id = ${orgId}
         and status in ('pending', 'sent')
       order by created_at desc, id desc
       limit 1
    `)).rows[0];
    if (already?.status === "sent") return null;
    // A pending row is the durable outbox identity. Reuse its original
    // recipients on recovery rather than creating a second advice for the
    // same instruction after a crash between staging and Redis enqueue.
    const recipients = already?.status === "pending"
      ? (Array.isArray(already.recipients) ? already.recipients : [])
      : row.email ? [row.email] : [];
    // The durable remittance row is staged only while this worker still owns
    // the run: the conditional insert proves the claim at write time, so a
    // superseded worker leaves no evidence rows behind either.
    if (already?.status === "pending") {
      return { remittanceId: already.id, recipients, instruction: row };
    }
    const remittance = (await db.execute<{ id: string }>(sql`
      insert into payment_remittances
        (org_id, payment_instruction_id, recipients, status, attempt_count, error, created_by, updated_by)
      select ${orgId}, ${instructionId}, ${JSON.stringify(recipients)}::jsonb,
             ${recipients.length ? "pending" : "failed"}, 0,
             ${recipients.length ? null : "counterparty has no remittance email address"},
             ${userId}, ${userId}
       where exists (
         select 1 from payment_runs r
          where r.id = ${runId} and r.org_id = ${orgId}
            and r.status = 'processing'
            and r.posting_claim_token = ${claim.token}
       )
      returning id
    `)).rows[0];
    if (!remittance) throw new PaymentRunPostingClaimFencedError(runId);
    return { remittanceId: remittance.id, recipients, instruction: row };
  });
  if (!staged) return;
  const { instruction } = staged;
  if (!staged.recipients.length) return;

  let enqueueError: unknown = null;
  try {
    const [{ enqueueEmail }, { paymentRemittanceEmail }] = await Promise.all([
      import("@openbooks/jobs"),
      import("@openbooks/emails"),
    ]);
    const documents = (await db.execute<{ number: string; amount: string; discount: string; credit: string }>(sql`
      select d.document_number as number, ri.payment_amount as amount,
             ri.discount_amount as discount, ri.credit_amount as credit
        from payment_run_items ri join documents d on d.id = ri.source_document_id and d.org_id = ri.org_id
       where ri.payment_instruction_id = ${instructionId} and ri.org_id = ${orgId} and ri.kind in ('bill', 'expense', 'refund', 'receivable')
       order by d.document_number
    `));
    const message = paymentRemittanceEmail({
      orgName: instruction.org_name,
      payeeName: instruction.payee,
      paymentReference: instruction.payment_reference ?? instruction.document_number ?? instruction.id,
      paymentDate: instruction.payment_date,
      amount: instruction.amount,
      currency: instruction.currency,
      documents: documents.rows,
    });
    await enqueueEmail({
      orgId,
      to: staged.recipients,
      subject: message.subject,
      html: message.html,
      text: message.text,
      meta: {
        category: "payment_remittance",
        paymentRemittanceId: staged.remittanceId,
      },
    }, { jobId: `payment-remittance|${staged.remittanceId}` });
  } catch (error) {
    enqueueError = error;
  }
  if (enqueueError) {
    await db.execute(sql`
      update payment_remittances set status = 'failed', attempt_count = 1, last_attempt_at = now(), error = ${enqueueError instanceof Error ? enqueueError.message : String(enqueueError)}, updated_at = now(), updated_by = ${userId} where id = ${staged.remittanceId} and org_id = ${orgId}
    `);
    console.error(`[payments] automatic remittance failed for instruction ${instructionId}:`, enqueueError);
    return;
  }

  // Enqueueing is not delivery confirmation. Leave the remittance pending;
  // the email worker owns the sent/failed transition after provider outcome.
}

// ---------------------------------------------------------------------------
// CPA Standard 005 file
// ---------------------------------------------------------------------------

/**
 * Assemble and build the CPA-005 file for a payment run. Throws PaymentError
 * with every blocking problem (settings or payee bank details) — no partial
 * or fake files. The file creation number derives from the run number
 * sequence, so re-downloading the same run reproduces the same number.
 */
export async function loadCpa005RunFile(
  runId: string,
  orgId: string,
): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate EFT payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "eft") throw new PaymentError(`CPA-005 export applies to EFT runs, not ${run.method}`);

  const { eft, blockers } = await paymentRunReadiness(runId, orgId);
  if (!eft.ok) {
    throw new PaymentError(
      `EFT origination is not configured on the payment bank profile: ${eft.missing.join(", ")}.`,
    );
  }
  if (blockers.length > 0) {
    throw new PaymentError(
      `cannot generate the EFT file: ${blockers.map((b) => `${b.payee} (${b.reason})`).join("; ")}`,
    );
  }

  // The readiness pass above is advisory display state re-checked for its side
  // effects (compliance release checks); the file itself is built ONLY from
  // evidence locked and re-validated atomically here, so an edit landing
  // between the two stages can never steer the file.
  const evidence = await lockRunBankEvidence("eft", runId, orgId);

  const today = await businessToday(orgId);
  const fundsDate = new Date(`${run.scheduledFor ?? today}T00:00:00`);
  const payments: Cpa005Payment[] = evidence.map((e) => {
    const units = toUnits(e.amount);
    if (units % 100n !== 0n) {
      throw new PaymentError(`instruction for ${e.payee} has sub-cent precision (${e.amount})`);
    }
    return {
      amountCents: units / 100n,
      fundsDate,
      institution: e.detail.institution!,
      transit: e.detail.transit!,
      accountNumber: e.detail.accountNumber,
      payeeName: e.payee,
      crossReference: e.documentNumber ?? e.id.slice(0, 19),
    };
  });

  const numeric = run.runNumber.replace(/\D/g, "");
  const fileCreationNumber = ((Number(numeric || "1") - 1) % 9999) + 1;

  const content = buildCpa005File({
    settings: eft.settings,
    fileCreationNumber,
    fileCreationDate: new Date(`${today}T00:00:00`),
    payments,
  });
  return { filename: `CPA005-${run.runNumber}.txt`, content, runNumber: run.runNumber };
}

// ---------------------------------------------------------------------------
// NACHA (US ACH) — orgs.settings.nacha
// ---------------------------------------------------------------------------

export async function loadNachaRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate ACH payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "ach") throw new PaymentError(`NACHA export applies to ACH runs, not ${run.method}`);
  const settings = await loadNachaSettings(orgId, runId);
  if (!settings.ok) throw new PaymentError(`ACH origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`);

  // Bank evidence is locked and approval-checked in the same transaction that
  // feeds the file: a concurrent maker edit either waits behind this snapshot
  // (the file carries the approved revision) or committed first (this
  // hard-blocks on its unapproved state). It can never steer the entry data.
  const evidence = await lockRunBankEvidence("ach", runId, orgId);

  const entries: NachaEntry[] = evidence.map((e) => {
    const units = toUnits(e.amount);
    if (units % 100n !== 0n) throw new PaymentError(`instruction for ${e.payee} has sub-cent precision (${e.amount})`);
    return {
      transactionCode: e.detail.savings ? "32" : "22",
      routingNumber: e.detail.routingNumber!,
      accountNumber: e.detail.accountNumber,
      amountCents: units / 100n,
      individualId: (e.documentNumber ?? e.id).slice(0, 15),
      individualName: e.payee,
    };
  });
  const today = await businessToday(orgId);
  const effectiveDate = new Date(`${run.scheduledFor ?? today}T00:00:00`);
  const content = buildNachaFile({ settings: settings.settings, effectiveDate, creationDate: new Date(`${today}T00:00:00`), entries });
  return { filename: `NACHA-${run.runNumber}.ach`, content, runNumber: run.runNumber };
}

// ---------------------------------------------------------------------------
// SEPA — pain.001.001.03 credit transfer, orgs.settings.sepa
// ---------------------------------------------------------------------------

export async function loadSepaRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate SEPA payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "sepa") throw new PaymentError(`SEPA export applies to SEPA runs, not ${run.method}`);
  const settings = await loadSepaSettings(orgId, runId);
  if (!settings.ok) throw new PaymentError(`SEPA origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`);

  // Same locked-evidence mechanism as the ACH and EFT writers: the creditor
  // IBAN/BIC are resolved from bank rows that were approved and active at the
  // instant of export, or the export fails outright.
  const evidence = await lockRunBankEvidence("sepa", runId, orgId);

  const payments = evidence.map((e) => ({
    endToEndId: e.documentNumber ?? e.id,
    amount: e.amount,
    creditorName: e.payee,
    creditorIban: e.detail.iban!,
    creditorBic: e.detail.bic,
    remittance: e.documentNumber,
  }));
  const today = await businessToday(orgId);
  const content = buildSepaFile({
    settings: settings.settings,
    messageId: `MSG-${run.runNumber}`,
    creationDateTime: `${today}T00:00:00`,
    executionDate: run.scheduledFor ?? today,
    payments,
  });
  return { filename: `SEPA-${run.runNumber}.xml`, content, runNumber: run.runNumber };
}

/** Dispatch a payment run to its bank file by method (eft→CPA-005, ach→NACHA, sepa→pain.001). */
export async function loadRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string; contentType: string }> {
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.method === "ach") return { ...(await loadNachaRunFile(runId, orgId)), contentType: "text/plain; charset=us-ascii" };
  if (run.method === "sepa") return { ...(await loadSepaRunFile(runId, orgId)), contentType: "application/xml" };
  return { ...(await loadCpa005RunFile(runId, orgId)), contentType: "text/plain; charset=us-ascii" };
}
