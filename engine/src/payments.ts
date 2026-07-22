import { eq, sql } from "drizzle-orm";
import { db, inDbTransaction, schema, withOrg } from "./db.ts";
import { add, cmp, divRate, formatMoney, fromUnits, isZero, mulRate, mulRatio, neg, sum, toUnits } from "./money.ts";
import { postDocument, runPostDocumentEffects, type PostingDeps } from "./posting.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";
import { runTriggerScripts, type ScriptContext } from "./scripting.ts";
import { emitStatusChange, runRecordFlows } from "./flows/run.ts";
import { sealSecret, unsealJson, unsealSecret } from "./secrets.ts";

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

export class PaymentError extends Error {}

export type PaymentKind = "vendor_payment" | "customer_payment";
export type OpenItemSide = "ap" | "ar";
export type SettlementRateSource = "same_currency" | "provider" | "manual" | "contractual" | "imported";

export const PAYMENT_KIND_SIDE: Record<PaymentKind, OpenItemSide> = {
  vendor_payment: "ap",
  customer_payment: "ar",
};

const NUMBER_PREFIX: Record<PaymentKind, string> = {
  vendor_payment: "PAY-",
  customer_payment: "RCPT-",
};

export interface AllocationInput {
  openLineId: string;
  /** Amount consumed from the payment/credit source, in the payment currency. */
  sourceTransactionAmount: string;
  /** Amount extinguished on the invoice/bill, in the target open-item currency. */
  targetTransactionAmount: string;
  /** Optional independently saved target carrying value, revalidated at posting. */
  targetBaseAmount?: string;
  /** Target-currency units for one source-currency unit. Required cross-currency. */
  settlementRate: string;
  settlementRateSource: SettlementRateSource;
  /** Bank advice, contract, provider observation, or import evidence reference. */
  settlementRateReference: string;
  /** Tenant-owned fx_rates observation when settlementRateSource is provider. */
  settlementFxRateId?: string | null;
}

export interface CreditAllocationInput {
  fromLineId: string;
  toLineId: string;
  amount: string;
  sourceDocumentId: string;
}

function isPaymentKind(kind: string): kind is PaymentKind {
  return kind === "vendor_payment" || kind === "customer_payment";
}

export async function nextNumber(orgId: string, kind: string, prefix: string, subsidiaryId?: string | null): Promise<string> {
  const configured = subsidiaryId
    ? ((await db.execute(sql`
        select 1 from number_sequences
         where org_id = ${orgId} and document_kind = ${kind} and subsidiary_id = ${subsidiaryId}
         limit 1`)) as any).rows.length > 0
    : false;
  const sequenceSubsidiaryId = configured ? subsidiaryId : null;
  const seq = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${sequenceSubsidiaryId}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
  const s = seq.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

// ---------------------------------------------------------------------------
// Control accounts
// ---------------------------------------------------------------------------

export async function paymentControlDeps(orgId: string): Promise<PostingDeps> {
  const r = (await db.execute(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { c: Record<string, string> | null }[] };
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
  createdBy: string;
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
  const sub = (await db.execute(sql`
    select coalesce(
      (select subsidiary_id from parties where id = ${opts.partyId ?? null} and org_id = ${opts.orgId}),
      (select id from subsidiaries where org_id = ${opts.orgId} and parent_id is null)
    ) as id`)) as unknown as { rows: { id: string }[] };
  const subsidiaryId = opts.subsidiaryId !== undefined ? opts.subsidiaryId : (sub.rows[0]?.id ?? null);
  const documentNumber = await nextNumber(opts.orgId, opts.kind, NUMBER_PREFIX[opts.kind], subsidiaryId);
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId: opts.orgId,
      kind: opts.kind,
      documentNumber,
      partyId: opts.partyId ?? null,
      subsidiaryId,
      documentDate: opts.documentDate ?? new Date().toISOString().slice(0, 10),
      currency: opts.currency ?? org.baseCurrency,
      fxRate: opts.fxRate ?? "1",
      memo: opts.memo ?? null,
      subtotal: "0",
      taxTotal: "0",
      total: "0",
      custom: opts.bankAccountId ? { bankAccountId: opts.bankAccountId, allocations: [] } : { allocations: [] },
      createdBy: opts.createdBy,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber });
  return doc;
}

export function sameCurrencyAllocation(
  openLineId: string,
  amount: string,
  targetBaseAmount?: string,
): AllocationInput {
  return {
    openLineId,
    sourceTransactionAmount: amount,
    targetTransactionAmount: amount,
    ...(targetBaseAmount === undefined ? {} : { targetBaseAmount }),
    settlementRate: "1",
    settlementRateSource: "same_currency",
    settlementRateReference: "same transaction currency",
  };
}

/** Validate allocation shape: positive exact amounts, rate evidence, distinct lines. */
function validateAllocationInputs(allocations: AllocationInput[]): void {
  const seen = new Set<string>();
  for (const a of allocations) {
    if (!a.openLineId) throw new PaymentError("allocation is missing its open item line");
    if (seen.has(a.openLineId)) throw new PaymentError("the same open item is allocated twice");
    seen.add(a.openLineId);
    try {
      if (toUnits(a.sourceTransactionAmount) <= 0n || toUnits(a.targetTransactionAmount) <= 0n) {
        throw new Error("transaction amounts must be positive");
      }
      if (a.targetBaseAmount !== undefined && toUnits(a.targetBaseAmount) <= 0n) {
        throw new Error("target base amount must be positive");
      }
      // Also validates numeric(19,10) precision and positivity.
      mulRate(a.sourceTransactionAmount, a.settlementRate);
    } catch {
      throw new PaymentError("allocation amounts and settlement rate must be positive exact decimals");
    }
    if (!a.settlementRateReference?.trim()) throw new PaymentError("settlement-rate evidence reference is required");
    if (!["same_currency", "provider", "manual", "contractual", "imported"].includes(a.settlementRateSource)) {
      throw new PaymentError("settlement-rate evidence source is invalid");
    }
  }
}

function canonicalSettlementRate(rate: string): string {
  const raw = String(rate).trim();
  const match = raw.match(/^\+?(\d+)(?:\.(\d*))?$/);
  if (!match || (match[2]?.length ?? 0) > 10) {
    throw new PaymentError("settlement rate must be a positive decimal with at most ten decimal places");
  }
  const whole = BigInt(match[1]!).toString();
  const fraction = (match[2] ?? "").padEnd(10, "0");
  if (BigInt(whole) === 0n && !/[1-9]/.test(fraction)) throw new PaymentError("settlement rate must be positive");
  return `${whole}.${fraction}`;
}

function validateSettlementEvidence(
  allocation: AllocationInput,
  sourceCurrency: string,
  targetCurrency: string,
): void {
  if (cmp(mulRate(allocation.sourceTransactionAmount, allocation.settlementRate), allocation.targetTransactionAmount) !== 0) {
    throw new PaymentError("settlement rate does not cross-foot source and target transaction amounts");
  }
  if (sourceCurrency === targetCurrency) {
    if (
      cmp(allocation.sourceTransactionAmount, allocation.targetTransactionAmount) !== 0 ||
      canonicalSettlementRate(allocation.settlementRate) !== "1.0000000000" ||
      allocation.settlementRateSource !== "same_currency" ||
      allocation.settlementFxRateId
    ) {
      throw new PaymentError("same-currency applications require equal amounts and a rate of one");
    }
    return;
  }
  if (allocation.settlementRateSource === "same_currency") {
    throw new PaymentError("cross-currency applications require explicit settlement-rate evidence");
  }
  if (allocation.settlementRateSource === "provider" && !allocation.settlementFxRateId) {
    throw new PaymentError("provider settlement evidence requires an FX rate observation");
  }
}

/**
 * Autosave surface for draft payments. Replaces header fields, the stored
 * allocations, and the single bank-account document line; the payment total
 * is always the sum of the allocations.
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
  },
  userId: string,
): Promise<void> {
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id));
  if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
  if (doc.status !== "draft") throw new PaymentError("only draft payments can be edited");

  const custom = (doc.custom ?? {}) as {
    bankAccountId?: string;
    allocations?: AllocationInput[];
    creditAllocations?: CreditAllocationInput[];
    discountAmount?: string;
    discountAccountId?: string;
    controlAccountId?: string;
  };
  const partyId = patch.partyId !== undefined ? patch.partyId : doc.partyId;
  const bankAccountId =
    patch.bankAccountId !== undefined ? patch.bankAccountId : (custom.bankAccountId ?? null);
  const allocations = patch.allocations ?? custom.allocations ?? [];
  const creditAllocations = patch.creditAllocations ?? custom.creditAllocations ?? [];
  const discountAmount = patch.discountAmount ?? custom.discountAmount ?? "0";
  const discountAccountId = patch.discountAccountId !== undefined ? patch.discountAccountId : (custom.discountAccountId ?? null);
  const controlAccountId = patch.controlAccountId !== undefined ? patch.controlAccountId : (custom.controlAccountId ?? null);

  validateAllocationInputs(allocations);
  validateAllocationInputs(creditAllocations.map((a) => sameCurrencyAllocation(`${a.fromLineId}:${a.toLineId}`, a.amount)));
  const discountUnits = toUnits(discountAmount);
  if (discountUnits < 0n) throw new PaymentError("discount amount cannot be negative");
  if (discountUnits > 0n && !discountAccountId) throw new PaymentError("select a discount account before applying a discount");

  if (bankAccountId) {
    const bank = (await db.execute(sql`
      select id from accounts
       where id = ${bankAccountId} and org_id = ${doc.orgId}
         and type = 'asset_bank' and is_active and not is_summary
    `)) as unknown as { rows: { id: string }[] };
    if (!bank.rows[0]) throw new PaymentError("bank account must be an active bank-type account");
  }
  if (discountAccountId || controlAccountId) {
    const refs = [discountAccountId, controlAccountId].filter(Boolean) as string[];
    const validRefs = (await db.execute(sql`
      select id from accounts where org_id = ${doc.orgId} and id in ${refs} and is_active and not is_summary
    `)) as unknown as { rows: { id: string }[] };
    if (validRefs.rows.length !== refs.length) throw new PaymentError("payment accounting account is invalid or inactive");
  }
  if (partyId && partyId !== doc.partyId) {
    const party = (await db.execute(
      sql`select id from parties where id = ${partyId} and org_id = ${doc.orgId} and is_active`,
    )) as unknown as { rows: { id: string }[] };
    if (!party.rows[0]) throw new PaymentError("party not found");
  }

  // Allocations must target real open items of this party, within open balance.
  if (allocations.length > 0) {
    if (!partyId) throw new PaymentError("select a party before applying open items");
    const openItems = await openItemsForParty(partyId, PAYMENT_KIND_SIDE[doc.kind]);
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

  const grossApplied = sum(allocations.map((a) => a.sourceTransactionAmount));
  if (cmp(discountAmount, grossApplied) > 0) throw new PaymentError("discount cannot exceed the payment applications");
  const total = fromUnits(toUnits(grossApplied) - discountUnits);

  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from document_lines where document_id = ${id}`);
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
        custom = ${JSON.stringify({ ...custom, bankAccountId, allocations, creditAllocations, discountAmount, discountAccountId, controlAccountId })}::jsonb,
        subtotal = ${total}, tax_total = '0', total = ${total},
        updated_at = now(), updated_by = ${userId}
      where id = ${id}
    `);
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
  opts?: { reference?: string | null; sourceCurrency: string },
): Promise<SuggestedApplication> {
  if (!opts?.sourceCurrency) throw new PaymentError("payment currency is required for automatic application");
  // Automated allocation is intentionally limited to open items already in the
  // payment currency. Cross-currency rows require explicit rate evidence and
  // source/target amounts from the accountant or bank advice.
  const items = (await openItemsForParty(partyId, side)).filter((item) => item.currency === opts.sourceCurrency);
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
export async function openItemsForParty(partyId: string, side: OpenItemSide): Promise<OpenItem[]> {
  const signFilter = side === "ap" ? sql`jl.amount < 0` : sql`jl.amount > 0`;
  const r = (await db.execute(sql`
    select jl.id as line_id, abs(jl.amount) as amount, jl.due_date, jl.memo,
           jl.currency, jl.fx_rate, abs(jl.txn_amount) as transaction_amount,
           je.id as entry_id, je.entry_number, je.posting_date,
           d.id as document_id, d.document_number, d.kind as document_kind, d.reference_number,
           coalesce(ap.applied, 0) as applied,
           coalesce(ap.transaction_applied, 0) as transaction_applied
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
      left join documents d on d.id = je.source_document_id
      left join lateral (
        select sum(a.amount) as applied, sum(a.target_transaction_amount) as transaction_applied
          from applications a
         where a.to_line_id = jl.id and a.unapplied_at is null
      ) ap on true
     where jl.party_id = ${partyId} and jl.is_open_item and ${signFilter}
     order by jl.due_date nulls last, je.posting_date, je.entry_number
  `)) as unknown as {
    rows: {
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
    }[];
  };
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
 * Full drawer payload for a payment document: header, stored draft
 * allocations, and (once posted) the live applications with their targets.
 */
export async function loadPaymentDocument(id: string, kind: PaymentKind) {
  const doc = (await db.execute(sql`
    select d.*, p.display_name as party_name, e.id as entry_id, e.entry_number,
           ba.id as bank_account_id_line, ba.number as bank_account_number, ba.name as bank_account_name
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
      left join document_lines dl on dl.document_id = d.id and dl.line_number = 1
      left join accounts ba on ba.id = coalesce((d.custom->>'bankAccountId')::uuid, dl.account_id)
     where d.id = ${id} and d.kind = ${kind}
  `)) as unknown as { rows: Record<string, unknown>[] };
  const row = doc.rows[0];
  if (!row) return null;

  const custom = (row.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const applied =
    row.status === "posted" && row.posted_entry_id
      ? ((await db.execute(sql`
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
            join applications a on a.from_line_id = jl.id and a.unapplied_at is null
            join journal_lines tl on tl.id = a.to_line_id
            join journal_entries te on te.id = tl.entry_id
            left join documents td on td.id = te.source_document_id
           where jl.entry_id = ${row.posted_entry_id}
           order by te.posting_date, te.entry_number
        `)) as unknown as { rows: Record<string, unknown>[] }).rows
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

/** Exact carrying amount consumed by a transaction-currency settlement. */
export function carryingAmountForSettlement(
  openBase: string,
  openTransaction: string,
  settledTransaction: string,
): string {
  if (cmp(settledTransaction, "0") <= 0 || cmp(settledTransaction, openTransaction) > 0) {
    throw new PaymentError("settlement amount must be positive and cannot exceed the open transaction amount");
  }
  // Taking the complete residual consumes the complete carrying value. This
  // prevents proportional rounding from leaving an uncloseable 0.0001 tail.
  if (cmp(settledTransaction, openTransaction) === 0) return openBase;
  return mulRatio(openBase, toUnits(settledTransaction), toUnits(openTransaction));
}

/**
 * Control-account adjustment required to clear source and target carrying
 * values. Positive is a debit; its exact opposite is realized gain/loss.
 */
export function realizedFxControlAdjustment(
  sourceSignedAmount: string,
  targetSignedAmount: string,
): string {
  return neg(add(sourceSignedAmount, targetSignedAmount));
}

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
): Promise<{ entryId: string }> {
  const [preflight] = await db.select().from(schema.documents).where(eq(schema.documents.id, paymentDocId));
  if (!preflight || !isPaymentKind(preflight.kind)) throw new PaymentError("payment document not found");

  const result = await withOrg(preflight.orgId, async () => {
    // Serialize both the payment aggregate and every application endpoint.
    await db.execute(sql`select id from documents where id = ${paymentDocId} for update`);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, paymentDocId));
    if (!doc || !isPaymentKind(doc.kind)) throw new PaymentError("payment document not found");
    if (doc.status === "posted") throw new PaymentError(`${doc.documentNumber} is already posted`);
    if (doc.status === "voided") throw new PaymentError(`${doc.documentNumber} is voided`);
    if (!doc.partyId) throw new PaymentError("select a party before posting");

    const custom = (doc.custom ?? {}) as {
      bankAccountId?: string;
      allocations?: AllocationInput[];
      creditAllocations?: CreditAllocationInput[];
      discountAmount?: string;
      controlAccountId?: string;
    };
    const allocs = allocations ?? custom.allocations ?? [];
    const creditAllocs = custom.creditAllocations ?? [];
    if (allocs.length === 0) throw new PaymentError("select at least one open item to apply");
    validateAllocationInputs(allocs);

    const endpointIds = [...new Set([
      ...allocs.map((a) => a.openLineId),
      ...creditAllocs.flatMap((a) => [a.fromLineId, a.toLineId]),
    ])];
    await db.execute(sql`select id from journal_lines where id in ${endpointIds} order by id for update`);

    const side = PAYMENT_KIND_SIDE[doc.kind];
    const openItems = await openItemsForParty(doc.partyId, side);
    const byLine = new Map(openItems.map((item) => [item.lineId, item]));
    for (const allocation of allocs) {
      const item = byLine.get(allocation.openLineId);
      if (!item) throw new PaymentError("an allocated item is no longer open for this party");
      validateSettlementEvidence(allocation, doc.currency, item.currency);
      if (cmp(allocation.targetTransactionAmount, item.transactionOpen) > 0) {
        throw new PaymentError(`application exceeds ${item.documentNumber ?? item.entryNumber}'s open transaction balance`);
      }
    }
    const evidenceIds = [...new Set(allocs.map((a) => a.settlementFxRateId).filter((id): id is string => !!id))];
    if (evidenceIds.length) {
      const evidenceRows = (await db.execute(sql`
        select id, from_currency, to_currency, rate, as_of::text as as_of
          from fx_rates
         where org_id = ${doc.orgId} and id in ${evidenceIds}
      `)) as unknown as { rows: { id: string; from_currency: string; to_currency: string; rate: string; as_of: string }[] };
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
    if (cmp(totalAlloc, fromUnits(toUnits(doc.total) + toUnits(discountAmount))) !== 0) {
      throw new PaymentError(`cash ${doc.total} plus discount ${discountAmount} must equal applications ${totalAlloc}`);
    }

    const deps = await paymentControlDeps(doc.orgId);
    const controlAccountId = custom.controlAccountId ?? (side === "ap" ? deps.control.ap : deps.control.ar);
    const entryId = await postDocument(doc.id, deps, { deferEffects: true });
    const sourceResult = (await db.execute(sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id,
             jl.subsidiary_id, je.posting_date, je.period_id, je.book_id,
             s.base_currency as functional_currency
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
        join subsidiaries s on s.id = jl.subsidiary_id
       where jl.entry_id = ${entryId} and jl.account_id = ${controlAccountId}
       limit 1
    `)) as unknown as { rows: {
      id: string; amount: string; currency: string; txn_amount: string; account_id: string;
      party_id: string | null; subsidiary_id: string; posting_date: string; period_id: string;
      book_id: string; functional_currency: string;
    }[] };
    const source = sourceResult.rows[0];
    if (!source) throw new PaymentError("posted payment entry has no AP/AR control line");
    if (source.currency !== doc.currency || cmp(fromUnits(toUnits(source.txn_amount) < 0n ? -toUnits(source.txn_amount) : toUnits(source.txn_amount)), totalAlloc) !== 0) {
      throw new PaymentError("payment control line does not cross-foot to the transaction-currency applications");
    }

    const targetsResult = (await db.execute(sql`
      select jl.id, jl.amount, jl.currency, jl.txn_amount, jl.account_id, jl.party_id, jl.subsidiary_id,
             abs(jl.amount) - coalesce(sum(a.amount) filter (where a.unapplied_at is null), 0) as open_base,
             abs(jl.txn_amount) - coalesce(sum(a.target_transaction_amount) filter (where a.unapplied_at is null), 0) as open_transaction
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
        left join applications a on a.to_line_id = jl.id
       where jl.id in ${allocs.map((a) => a.openLineId)}
       group by jl.id
    `)) as unknown as { rows: {
      id: string; amount: string; currency: string; txn_amount: string; account_id: string;
      party_id: string | null; subsidiary_id: string; open_base: string; open_transaction: string;
    }[] };
    const targetById = new Map(targetsResult.rows.map((row) => [row.id, row]));

    let sourceBaseRemaining = fromUnits(toUnits(source.amount) < 0n ? -toUnits(source.amount) : toUnits(source.amount));
    let sourceTransactionRemaining = totalAlloc;
    const applicationsToWrite: SettlementApplication[] = [];
    for (const allocation of allocs) {
      const target = targetById.get(allocation.openLineId);
      if (!target) throw new PaymentError("an application target disappeared while posting");
      if (target.account_id !== source.account_id || target.party_id !== source.party_id || target.subsidiary_id !== source.subsidiary_id) {
        throw new PaymentError("applications must settle the same control account, party, and subsidiary as the payment");
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
      fxEntryId = fxEntry.id;
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
      await db.update(schema.journalEntries).set({ status: "posted", postedAt: new Date(), postedBy: userId ?? doc.createdBy }).where(eq(schema.journalEntries.id, fxEntryId!));
    }

    await db.insert(schema.applications).values(applicationsToWrite.map(({ controlAdjustment: _adjustment, ...application }) => ({
      ...application,
      orgId: doc.orgId,
      fxGainLossEntryId: fxEntryId,
      createdBy: userId ?? doc.createdBy,
    })));

    if (creditAllocs.length > 0) {
      // Credit allocations currently carry functional-currency amounts. Keep
      // their evidence explicit and reject any attempt to disguise foreign
      // transaction values as base amounts.
      const creditRows = (await db.execute(sql`
        select jl.id, jl.currency, s.base_currency
          from journal_lines jl join subsidiaries s on s.id = jl.subsidiary_id
         where jl.id in ${creditAllocs.flatMap((a) => [a.fromLineId, a.toLineId])}
      `)) as unknown as { rows: { id: string; currency: string; base_currency: string }[] };
      if (creditRows.rows.some((row) => row.currency !== row.base_currency)) {
        throw new PaymentError("foreign-currency credit applications require explicit transaction amounts");
      }
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
    const targets = (await db.execute(sql`
      select distinct je.source_document_id as doc_id
        from journal_lines jl join journal_entries je on je.id = jl.entry_id
       where jl.id in ${targetIds} and je.source_document_id is not null
    `)) as unknown as { rows: { doc_id: string }[] };
    if (targets.rows.length > 0) {
      await db.insert(schema.documentLinks).values(targets.rows.map((target) => ({
        orgId: doc.orgId,
        fromDocumentId: doc.id,
        toDocumentId: target.doc_id,
        linkType: "pays" as const,
        createdBy: userId ?? doc.createdBy,
      })));
    }
    return { entryId };
  });

  await runPostDocumentEffects(paymentDocId, preflight.status);
  return result;
}

/** Reverse a payment and every realized-FX entry tied to its applications. */
async function reversePostedEntry(
  entryId: string,
  documentId: string,
  orgId: string,
  memo: string,
  unapplySourceEntry = false,
): Promise<string | null> {
  const [entry] = await db
    .select()
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, entryId));
  if (!entry) return null;
  const lines = await db
    .select()
    .from(schema.journalLines)
    .where(eq(schema.journalLines.entryId, entryId));

  // -- user scripts: before_void (veto) -----------------------------------
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
  const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId));
  if (doc && org) {
    const docLines = await db
      .select()
      .from(schema.documentLines)
      .where(eq(schema.documentLines.documentId, documentId));
    const scriptCtx: ScriptContext = {
      trigger: "before_void",
      document: doc as unknown as Record<string, unknown>,
      lines: docLines as unknown as Record<string, unknown>[],
      org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    };
    const outcomes = await runTriggerScripts("before_void", scriptCtx, documentId);
    const bad = outcomes.find((o) => o.status !== "ok");
    if (bad) {
      throw new PaymentError(
        bad.status === "aborted"
          ? `voiding vetoed by script "${bad.name}": ${bad.abortReason}`
          : `script "${bad.name}" ${bad.status}: ${bad.abortReason ?? ""}`,
      );
    }

    // -- flows: before_void (automation only, never a veto) ----------------
    await runRecordFlows({ kind: "before_void" }, doc.kind, documentId, { orgId });
  }

  let reversalId: string | null = null;
  await inDbTransaction(async (tx) => {
    const fxRows = unapplySourceEntry
      ? ((await tx.execute(sql`
          select distinct a.fx_gain_loss_entry_id as id
            from applications a
            join journal_lines jl on jl.id = a.from_line_id
           where jl.entry_id = ${entryId} and a.unapplied_at is null
             and a.fx_gain_loss_entry_id is not null
        `)) as unknown as { rows: { id: string }[] }).rows
      : [];
    if (unapplySourceEntry) {
      await tx.execute(sql`
        update applications a set unapplied_at = now()
         where a.unapplied_at is null and exists (
           select 1 from journal_lines jl where jl.id = a.from_line_id and jl.entry_id = ${entryId})
      `);
    }
    const insertReversal = async (
      sourceEntry: typeof schema.journalEntries.$inferSelect,
      sourceLines: (typeof schema.journalLines.$inferSelect)[],
      reversalMemo: string,
    ): Promise<string> => {
      const [rev] = await tx
      .insert(schema.journalEntries)
      .values({
        orgId,
        bookId: sourceEntry.bookId,
        subsidiaryId: sourceEntry.subsidiaryId,
        entryNumber: `${sourceEntry.entryNumber}-R`,
        postingDate: sourceEntry.postingDate,
        periodId: sourceEntry.periodId,
        memo: reversalMemo,
        status: "draft",
        sourceDocumentId: sourceEntry.sourceDocumentId,
        origin: sourceEntry.origin,
        reversesEntryId: sourceEntry.id,
      })
      .returning({ id: schema.journalEntries.id });
      await tx.insert(schema.journalLines).values(
      sourceLines.map((l) => ({
        orgId,
        entryId: rev.id,
        lineNumber: l.lineNumber,
        accountId: l.accountId,
        subsidiaryId: l.subsidiaryId,
        amount: negStr(l.amount),
        currency: l.currency,
        txnAmount: negStr(l.txnAmount),
        fxRate: l.fxRate,
        partyId: l.partyId,
        departmentId: l.departmentId,
        projectId: l.projectId,
        locationId: l.locationId,
        classId: l.classId,
        equipmentUnitId: l.equipmentUnitId,
        extraDims: l.extraDims,
        paymentCardId: l.paymentCardId,
        taxCodeId: l.taxCodeId,
        memo: l.memo,
        dueDate: null,
        isOpenItem: false,
      })),
    );
      await tx
      .update(schema.journalEntries)
      .set({ status: "posted", postedAt: new Date() })
      .where(eq(schema.journalEntries.id, rev.id));
      await tx
      .update(schema.journalEntries)
      .set({ status: "reversed" })
      .where(eq(schema.journalEntries.id, sourceEntry.id));
      return rev.id;
    };

    reversalId = await insertReversal(entry, lines, memo);
    for (const fxRow of fxRows) {
      const [fxEntry] = await tx.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, fxRow.id));
      if (!fxEntry || fxEntry.status !== "posted") {
        throw new PaymentError("realized FX evidence is missing or is not posted");
      }
      const fxLines = await tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, fxEntry.id));
      await insertReversal(fxEntry, fxLines, `${memo} — realized FX`);
    }
    await tx.execute(sql`
      update documents set status = 'voided', voided_at = now() where id = ${documentId}
    `);
  });

  // -- flows: the posted → voided status transition (never throws) ----------
  if (doc) {
    await emitStatusChange(doc.kind, documentId, { from: doc.status, to: "voided" }, { orgId });
  }
  return reversalId;
}

/** Reverse a posted payment after a bank return and reopen its applications. */
export async function reversePaymentForReturn(
  paymentDocumentId: string,
  orgId: string,
  reason: string,
): Promise<string> {
  const reversalId = await withOrg(orgId, async () => {
    const row = (await db.execute(sql`
      select d.id, d.posted_entry_id, d.document_number
        from documents d
       where d.id = ${paymentDocumentId} and d.org_id = ${orgId}
         and d.kind in ('vendor_payment', 'customer_payment') and d.status = 'posted'
       for update
    `)) as unknown as { rows: { id: string; posted_entry_id: string; document_number: string }[] };
    const payment = row.rows[0];
    if (!payment?.posted_entry_id) throw new PaymentError("returned payment is not posted");
    return reversePostedEntry(
      payment.posted_entry_id,
      payment.id,
      orgId,
      `bank return: ${reason.trim() || payment.document_number}`,
      true,
    );
  });
  if (!reversalId) throw new PaymentError("payment reversal could not be created");
  return reversalId;
}

// ---------------------------------------------------------------------------
// Originator settings (tenant-owned payment bank profiles)
// ---------------------------------------------------------------------------

export interface EftSettings {
  /** 10-character originator ID assigned by the financial institution. */
  originatorId: string;
  /** Up to 15 characters; appears on payee statements. */
  originatorShortName: string;
  /** Up to 30 characters; appears on payee statements. */
  originatorLongName: string;
  /** 5-digit destination data centre code of the processing institution. */
  dataCentre: string;
  /** Payer (settlement) bank: 3-digit institution, 5-digit transit, account. */
  institution: string;
  transit: string;
  account: string;
  /** Optional CPA transaction code override; default 460 (accounts payable). */
  transactionCode?: string;
}

const EFT_REQUIRED: (keyof EftSettings)[] = [
  "originatorId",
  "originatorShortName",
  "originatorLongName",
  "dataCentre",
  "institution",
  "transit",
  "account",
];

export type EftSettingsResult =
  | { ok: true; settings: EftSettings }
  | { ok: false; missing: string[] };

/** Read and validate the org's EFT origination settings. Never fakes success. */
export async function loadEftSettings(orgId: string, runId?: string): Promise<EftSettingsResult> {
  const r = (await db.execute(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id
      left join payment_runs r on r.payment_bank_profile_id = p.id
     where p.org_id = ${orgId} and p.is_active and f.rail = 'cpa005_credit'
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `)) as unknown as { rows: { originator_secrets_encrypted: string | null }[] };
  const eft = unsealJson<Partial<EftSettings>>(r.rows[0]?.originator_secrets_encrypted) ?? {};
  const missing = EFT_REQUIRED.filter((k) => {
    const v = eft[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (missing.length > 0) return { ok: false, missing };
  const s = eft as EftSettings;
  if (!/^\d{5}$/.test(s.dataCentre)) return { ok: false, missing: ["dataCentre (must be 5 digits)"] };
  if (!/^\d{3}$/.test(s.institution)) return { ok: false, missing: ["institution (must be 3 digits)"] };
  if (!/^\d{5}$/.test(s.transit)) return { ok: false, missing: ["transit (must be 5 digits)"] };
  if (!/^\d{1,12}$/.test(s.account)) return { ok: false, missing: ["account (1–12 digits)"] };
  if (s.originatorId.length > 10) return { ok: false, missing: ["originatorId (max 10 characters)"] };
  return { ok: true, settings: s };
}

// ---------------------------------------------------------------------------
// Counterparty bank account number encryption
// ---------------------------------------------------------------------------

/** Encrypt a payee bank account number for party_bank_accounts.account_number_encrypted. */
export function encryptAccountNumber(plain: string): string {
  return sealSecret(plain);
}

export function decryptAccountNumber(stored: string): string {
  const plain = unsealSecret(stored);
  if (plain === null) throw new PaymentError("stored bank account number is malformed or could not be decrypted");
  return plain;
}

// ---------------------------------------------------------------------------
// Payment runs
// ---------------------------------------------------------------------------

/**
 * Create an EFT payment run from selected posted vendor bills: one draft
 * vendor_payment per vendor (allocating each bill's current open balance) and
 * one payment_instruction per vendor. Nothing posts until the explicit
 * post step; the CPA-005 file is generated from the instructions.
 */
export async function createPaymentRun(opts: {
  orgId: string;
  createdBy: string;
  paymentBankProfileId: string;
  billDocumentIds: string[];
  scheduledFor?: string | null;
  sourceScheduleId?: string | null;
  selectionCriteria?: Record<string, unknown>;
}): Promise<{ id: string; runNumber: string }> {
  if (opts.billDocumentIds.length === 0) throw new PaymentError("select at least one bill to pay");

  const profiles = (await db.execute(sql`
    select p.id, p.bank_account_id, p.subsidiary_id, p.currency, p.require_run_approval, p.settings,
           f.rail, f.direction
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id and f.is_active
      join accounts a on a.id = p.bank_account_id and a.org_id = p.org_id
                        and a.type = 'asset_bank' and a.is_active and not a.is_summary
     where p.id = ${opts.paymentBankProfileId} and p.org_id = ${opts.orgId} and p.is_active
  `)) as unknown as { rows: {
    id: string;
    bank_account_id: string;
    subsidiary_id: string | null;
    currency: string;
    require_run_approval: boolean;
    settings: Record<string, unknown>;
    rail: string;
    direction: string;
  }[] };
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
  const bills = (await db.execute(sql`
    select d.id as document_id, d.document_number, d.kind as document_kind, d.document_date, d.party_id, p.display_name as vendor,
           d.currency, d.fx_rate, d.subsidiary_id, jl.account_id as control_account_id,
           jl.id as open_line_id, abs(jl.amount) - coalesce(ap.applied, 0) as open_base,
           round((abs(jl.amount) - coalesce(ap.applied, 0)) / d.fx_rate, 4) as open,
           pt.discount_days, pt.discount_percent
      from documents d
      join parties p on p.id = d.party_id
      left join vendor_roles vr on vr.party_id = d.party_id
      left join payment_terms pt on pt.id = vr.payment_terms_id and pt.is_active
      join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.is_open_item and jl.amount < 0
      left join lateral (
        select sum(a.amount) as applied from applications a
         where a.to_line_id = jl.id and a.unapplied_at is null
      ) ap on true
     where d.id in ${opts.billDocumentIds}
       and d.org_id = ${opts.orgId} and d.kind in ('vendor_bill', 'expense_report') and d.status = 'posted'
       and d.payment_hold_reason is null
       and d.currency = ${profile.currency}
       and (${profile.subsidiary_id}::uuid is null or d.subsidiary_id = ${profile.subsidiary_id})
  `)) as unknown as {
    rows: { document_id: string; document_number: string; document_kind: string; document_date: string; party_id: string; vendor: string; currency: string; fx_rate: string; subsidiary_id: string | null; control_account_id: string; open_line_id: string; open_base: string; open: string; discount_days: number | null; discount_percent: string | null }[];
  };

  const found = new Set(bills.rows.map((b) => b.document_id));
  const missing = opts.billDocumentIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new PaymentError("some selected bills are held, closed, or do not match the profile currency and subsidiary");
  }
  const payable = bills.rows.filter((b) => cmp(b.open, "0") > 0);
  if (payable.length === 0) throw new PaymentError("all selected bills are already fully paid");

  const byVendor = new Map<string, typeof payable>();
  for (const b of payable) {
    const groupKey = `${b.party_id}:${b.subsidiary_id ?? ""}:${b.control_account_id}:${b.fx_rate}`;
    const list = byVendor.get(groupKey) ?? [];
    list.push(b);
    byVendor.set(groupKey, list);
  }

  const runNumber = await nextNumber(opts.orgId, "payment_run", "RUN-");

  const [run] = await db
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
    .returning({ id: schema.paymentRuns.id, runNumber: schema.paymentRuns.runNumber });

  const criteria = opts.selectionCriteria ?? {};
  const captureDiscounts = criteria.captureDiscounts !== false;
  const applyCredits = criteria.applyCredits !== false;
  const discountAccountId = typeof profile.settings?.discountAccountId === "string"
    ? profile.settings.discountAccountId
    : null;
  const paymentDate = opts.scheduledFor ?? new Date().toISOString().slice(0, 10);

  for (const vendorBills of byVendor.values()) {
    const first = vendorBills[0]!;
    const partyId = first.party_id;
    const availableCredits = applyCredits ? (await db.execute(sql`
      select d.id as document_id, jl.id as open_line_id,
             abs(jl.amount) - coalesce(ap.applied, 0) as open_base
        from documents d
        join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
        join journal_lines jl on jl.entry_id = je.id and jl.is_open_item and jl.amount > 0
        left join lateral (
          select sum(a.amount) as applied from applications a
           where a.from_line_id = jl.id and a.unapplied_at is null
        ) ap on true
       where d.org_id = ${opts.orgId} and d.party_id = ${partyId}
         and d.kind = 'vendor_credit' and d.status = 'posted'
         and d.currency = ${profile.currency} and jl.account_id = ${first.control_account_id}
         and d.subsidiary_id is not distinct from ${first.subsidiary_id}::uuid
         and abs(jl.amount) - coalesce(ap.applied, 0) > 0
       order by d.document_date, d.document_number
    `)) as unknown as { rows: { document_id: string; open_line_id: string; open_base: string }[] } : { rows: [] };
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
      }
      if (remainingBase <= 0n) continue;
      const remainingTxn = divRate(fromUnits(remainingBase), bill.fx_rate);
      let discountTxn = "0";
      if (captureDiscounts && bill.discount_days != null && bill.discount_percent && cmp(bill.discount_percent, "0") > 0) {
        const deadline = new Date(`${bill.document_date}T00:00:00Z`);
        deadline.setUTCDate(deadline.getUTCDate() + bill.discount_days);
        if (paymentDate <= deadline.toISOString().slice(0, 10)) {
          const numerator = toUnits(remainingTxn) * toUnits(bill.discount_percent);
          const rawDiscount = (numerator + 500_000n) / 1_000_000n;
          discountTxn = fromUnits(((rawDiscount + 50n) / 100n) * 100n);
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
      subsidiaryId: first.subsidiary_id,
      currency: profile.currency,
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
    );

    // Latest approved, active bank account for the payee (may be none — the
    // file export blocks on it with a clear error, never silently).
    const payeeBank = (await db.execute(sql`
      select id from party_bank_accounts
       where party_id = ${partyId} and is_active and approved_at is not null
       order by approved_at desc, created_at desc limit 1
    `)) as unknown as { rows: { id: string }[] };

    const [instruction] = await db.insert(schema.paymentInstructions).values({
      orgId: opts.orgId,
      paymentRunId: run.id,
      payeePartyId: partyId,
      payeeBankAccountId: payeeBank.rows[0]?.id ?? null,
      amount: total,
      currency: profile.currency,
      paymentDocumentId: payment.id,
      status: "pending",
      createdBy: opts.createdBy,
    }).returning({ id: schema.paymentInstructions.id });

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
        from payment_instructions where payment_run_id = ${run.id} and status <> 'cancelled'
       group by payment_run_id
    ) x
    where r.id = x.payment_run_id
  `);
  await db.insert(schema.paymentEvents).values({
    orgId: opts.orgId,
    paymentRunId: run.id,
    eventType: "run_created",
    toStatus: "draft",
    details: { paymentBankProfileId: profile.id, sourceCount: payable.length },
    actorId: opts.createdBy,
  });

  return run;
}

/** Cancel a draft run: void nothing — drafts are deleted, instructions cancelled. */
export async function cancelPaymentRun(runId: string, orgId: string): Promise<void> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status !== "draft" && run.status !== "rejected" && run.status !== "rolled_back") {
    throw new PaymentError(`a ${run.status} run cannot be cancelled`);
  }
  const instructions = await db
    .select()
    .from(schema.paymentInstructions)
    .where(eq(schema.paymentInstructions.paymentRunId, runId));

  await db.transaction(async (tx) => {
    for (const ins of instructions) {
      // Release the FK to the draft payment before deleting it.
      await tx
        .update(schema.paymentInstructions)
        .set({ status: "cancelled", paymentDocumentId: null, updatedAt: new Date() })
        .where(eq(schema.paymentInstructions.id, ins.id));
      if (ins.paymentDocumentId) {
        const [doc] = await tx
          .select({ status: schema.documents.status })
          .from(schema.documents)
          .where(eq(schema.documents.id, ins.paymentDocumentId));
        if (doc && doc.status !== "draft") {
          throw new PaymentError("run has payments that are no longer drafts — it cannot be cancelled");
        }
        await tx.execute(sql`delete from document_lines where document_id = ${ins.paymentDocumentId}`);
        await tx.execute(sql`delete from documents where id = ${ins.paymentDocumentId}`);
      }
    }
    await tx
      .update(schema.paymentRuns)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(schema.paymentRuns.id, runId));
  });
}

export interface RunBlocker {
  instructionId: string;
  payee: string;
  reason: string;
}

/**
 * Everything the run detail view and the file export need to agree on:
 * EFT settings state and per-instruction bank-detail blockers.
 */
export async function paymentRunReadiness(runId: string, orgId: string): Promise<{
  eft: EftSettingsResult;
  blockers: RunBlocker[];
}> {
  const runInfo = (await db.execute(sql`
    select r.method, f.rail
      from payment_runs r
      left join payment_bank_profiles p on p.id = r.payment_bank_profile_id
      left join payment_formats f on f.id = p.payment_format_id
     where r.id = ${runId} and r.org_id = ${orgId}
  `)) as unknown as { rows: { method: string; rail: string | null }[] };
  const method = runInfo.rows[0]?.method;
  const rail = runInfo.rows[0]?.rail;
  let eft: EftSettingsResult;
  if (method === "ach") eft = await loadNachaSettings(orgId, runId) as EftSettingsResult;
  else if (method === "sepa") eft = await loadSepaSettings(orgId, runId) as EftSettingsResult;
  else if (method === "eft") eft = await loadEftSettings(orgId, runId);
  else eft = { ok: true, settings: {} as EftSettings };
  const rows = (await db.execute(sql`
    select i.id, p.display_name as payee, i.payee_bank_account_id,
           b.approved_at, b.is_active, b.routing, b.account_number_encrypted, i.currency
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      left join party_bank_accounts b on b.id = i.payee_bank_account_id
     where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
  `)) as unknown as {
    rows: {
      id: string;
      payee: string;
      payee_bank_account_id: string | null;
      approved_at: string | null;
      is_active: boolean | null;
      routing: Record<string, string> | null;
      account_number_encrypted: string | null;
      currency: string;
    }[];
  };

  const blockers: RunBlocker[] = [];
  for (const r of rows.rows) {
    if (method === "cheque" || method === "positive_pay") continue;
    if (!r.payee_bank_account_id) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "no approved bank account on file" });
      continue;
    }
    if (!r.approved_at) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "bank account is not approved" });
      continue;
    }
    if (!r.is_active) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "bank account is inactive" });
      continue;
    }
    const routing = r.routing ?? {};
    if (method === "eft" && !/^\d{3}$/.test(routing.institution ?? "")) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing/invalid 3-digit institution number" });
      continue;
    }
    if (method === "eft" && !/^\d{5}$/.test(routing.transit ?? "")) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing/invalid 5-digit transit number" });
      continue;
    }
    if (!r.account_number_encrypted) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing account number" });
      continue;
    }
    const aba = routing.aba ?? routing.routingNumber ?? routing.routing ?? "";
    if (method === "ach" && !/^\d{9}$/.test(aba)) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing/invalid 9-digit routing number" });
      continue;
    }
    if (method === "sepa" && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test((routing.iban ?? "").replace(/\s/g, ""))) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "missing/invalid IBAN" });
      continue;
    }
    if (method === "eft" && r.currency !== "CAD") {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: `CPA-005 CAD file cannot carry ${r.currency}` });
    }
  }
  return { eft, blockers };
}

/**
 * Post every pending instruction's payment document (+ applications).
 * Sequential and partial-failure-honest: successes are marked 'sent'; any
 * failures are reported and leave the run partially failed for retry.
 */
export async function postPaymentRun(
  runId: string,
  orgId: string,
  userId: string,
): Promise<{ posted: number; failures: { payee: string; error: string }[] }> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status !== "generated" && run.status !== "delivered" && run.status !== "partially_failed") {
    throw new PaymentError(
      run.status === "confirmed"
        ? "run is already posted"
        : "generate and download the EFT file before posting the run",
    );
  }

  const instructions = (await db.execute(sql`
    select i.id, i.payment_document_id, i.status, p.display_name as payee,
           d.status as document_status
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      left join documents d on d.id = i.payment_document_id
     where i.payment_run_id = ${runId} and i.status = 'pending'
     order by p.display_name
  `)) as unknown as {
    rows: {
      id: string;
      payment_document_id: string | null;
      status: string;
      payee: string;
      document_status: string | null;
    }[];
  };

  let posted = 0;
  const failures: { payee: string; error: string }[] = [];
  for (const ins of instructions.rows) {
    try {
      if (!ins.payment_document_id) throw new PaymentError("instruction has no payment document");
      // Already posted individually from its own flyout — just mark it sent.
      if (ins.document_status !== "posted") {
        await postPaymentWithApplications(ins.payment_document_id, undefined, userId);
      }
      await db
        .update(schema.paymentInstructions)
        .set({ status: "sent", updatedAt: new Date(), updatedBy: userId })
        .where(eq(schema.paymentInstructions.id, ins.id));
      try {
        await queueAutomaticRemittance(ins.id, orgId, userId);
      } catch (error) {
        console.error(`[payments] automatic remittance failed for instruction ${ins.id}:`, error);
      }
      posted += 1;
    } catch (e) {
      failures.push({ payee: ins.payee, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (failures.length === 0) {
    await db
      .update(schema.paymentRuns)
      .set({ status: "confirmed", updatedAt: new Date(), updatedBy: userId })
      .where(eq(schema.paymentRuns.id, runId));
  } else {
    await db
      .update(schema.paymentRuns)
      .set({ status: "partially_failed", updatedAt: new Date(), updatedBy: userId })
      .where(eq(schema.paymentRuns.id, runId));
  }
  return { posted, failures };
}

async function queueAutomaticRemittance(instructionId: string, orgId: string, userId: string): Promise<void> {
  const row = (await db.execute(sql`
    select i.id, i.amount, i.currency, i.payment_reference, d.document_number,
           coalesce(r.scheduled_for, d.document_date) as payment_date,
           p.display_name as payee, vr.eft_notification_email as email,
           bp.auto_remittance, r.direction, o.name as org_name
      from payment_instructions i
      join payment_runs r on r.id = i.payment_run_id
      join payment_bank_profiles bp on bp.id = r.payment_bank_profile_id
      join parties p on p.id = i.payee_party_id
      left join vendor_roles vr on vr.party_id = p.id
      left join documents d on d.id = i.payment_document_id
      join orgs o on o.id = i.org_id
     where i.id = ${instructionId} and i.org_id = ${orgId}
  `)) as unknown as { rows: Array<{ id: string; amount: string; currency: string; payment_reference: string | null; document_number: string | null; payment_date: string; payee: string; email: string | null; auto_remittance: boolean; direction: string; org_name: string }> };
  const instruction = row.rows[0];
  if (!instruction?.auto_remittance || instruction.direction !== "outbound") return;
  const already = (await db.execute(sql`
    select 1 from payment_remittances where payment_instruction_id = ${instructionId} and status = 'sent' limit 1
  `)) as unknown as { rows: unknown[] };
  if (already.rows[0]) return;
  const recipients = instruction.email ? [instruction.email] : [];
  const [remittance] = await db.insert(schema.paymentRemittances).values({
    orgId,
    paymentInstructionId: instructionId,
    recipients,
    status: recipients.length ? "pending" : "failed",
    attemptCount: 0,
    error: recipients.length ? null : "counterparty has no remittance email address",
    createdBy: userId,
    updatedBy: userId,
  }).returning({ id: schema.paymentRemittances.id });
  if (!recipients.length) return;
  const documents = (await db.execute(sql`
    select d.document_number as number, ri.payment_amount as amount,
           ri.discount_amount as discount, ri.credit_amount as credit
      from payment_run_items ri join documents d on d.id = ri.source_document_id
     where ri.payment_instruction_id = ${instructionId} and ri.kind in ('bill', 'expense', 'refund', 'receivable')
     order by d.document_number
  `)) as unknown as { rows: Array<{ number: string; amount: string; discount: string; credit: string }> };
  try {
    const [{ enqueueEmail }, { paymentRemittanceEmail }] = await Promise.all([
      import("@openbooks/jobs"),
      import("@openbooks/emails"),
    ]);
    const paymentReference = instruction.payment_reference ?? instruction.document_number ?? instruction.id;
    const message = paymentRemittanceEmail({
      orgName: instruction.org_name,
      payeeName: instruction.payee,
      paymentReference,
      paymentDate: instruction.payment_date,
      amount: instruction.amount,
      currency: instruction.currency,
      documents: documents.rows,
    });
    await enqueueEmail({ orgId, to: recipients, subject: message.subject, html: message.html, text: message.text, meta: { category: "payment_remittance" } });
    await db.execute(sql`update payment_remittances set status = 'sent', attempt_count = 1, last_attempt_at = now(), sent_at = now(), updated_at = now(), updated_by = ${userId} where id = ${remittance.id}`);
    await db.execute(sql`update payment_instructions set remittance_email_sent_at = now(), updated_at = now(), updated_by = ${userId} where id = ${instructionId}`);
  } catch (error) {
    await db.execute(sql`
      update payment_remittances set status = 'failed', attempt_count = 1, last_attempt_at = now(), error = ${error instanceof Error ? error.message : String(error)}, updated_at = now(), updated_by = ${userId} where id = ${remittance.id}
    `);
  }
}

// ---------------------------------------------------------------------------
// CPA Standard 005 file
// ---------------------------------------------------------------------------

export interface Cpa005Payment {
  /** Amount in cents (positive integer, max 10 digits). */
  amountCents: bigint;
  /** Date funds are to be made available (payment date). */
  fundsDate: Date;
  /** Payee routing: 3-digit institution + 5-digit transit. */
  institution: string;
  transit: string;
  /** Payee account number, 1–12 digits/characters. */
  accountNumber: string;
  /** Payee name, truncated to 30 characters. */
  payeeName: string;
  /** Originator's cross-reference (e.g. payment document number), ≤19 chars. */
  crossReference: string;
}

export interface Cpa005Run {
  settings: EftSettings;
  /** 1–9999, unique per file transmitted to the institution. */
  fileCreationNumber: number;
  fileCreationDate: Date;
  payments: Cpa005Payment[];
}

const RECORD_LEN = 1464;
const SEGMENTS_PER_RECORD = 6;
const SEGMENT_LEN = 240;

function alpha(value: string, len: number): string {
  return value.slice(0, len).padEnd(len, " ");
}

function num(value: bigint | number, len: number): string {
  const s = String(value);
  if (s.length > len || Number(value) < 0) {
    throw new PaymentError(`numeric field value ${s} does not fit in ${len} digits`);
  }
  return s.padStart(len, "0");
}

/** CPA date format: 0YYDDD (leading zero, 2-digit year, julian day of year). */
function julian(d: Date): string {
  const year = d.getFullYear();
  const start = Date.UTC(year, 0, 1);
  const day =
    Math.floor((Date.UTC(year, d.getMonth(), d.getDate()) - start) / 86_400_000) + 1;
  return `0${String(year % 100).padStart(2, "0")}${String(day).padStart(3, "0")}`;
}

/** 9-digit institutional ID: 0 + institution(3) + transit(5). */
function institutionalId(institution: string, transit: string): string {
  if (!/^\d{3}$/.test(institution)) throw new PaymentError(`institution "${institution}" must be 3 digits`);
  if (!/^\d{5}$/.test(transit)) throw new PaymentError(`transit "${transit}" must be 5 digits`);
  return `0${institution}${transit}`;
}

/**
 * Build a CPA Standard 005 credit file (logical records A, C, Z; fixed-width
 * 1464-character records; up to six 240-character credit segments per C
 * record; CAD funds). Records are joined with CRLF.
 */
export function buildCpa005File(run: Cpa005Run): string {
  const s = run.settings;
  if (run.fileCreationNumber < 1 || run.fileCreationNumber > 9999) {
    throw new PaymentError("file creation number must be 1–9999");
  }
  if (run.payments.length === 0) throw new PaymentError("run has no payments to export");

  const originatorId = alpha(s.originatorId, 10);
  const fileCreationNo = num(run.fileCreationNumber, 4);
  const originControl = `${originatorId}${fileCreationNo}`; // positions 11–24
  const txnType = /^\d{3}$/.test(s.transactionCode ?? "") ? s.transactionCode! : "460";

  let recordCount = 0;
  const records: string[] = [];

  // -- A: header --------------------------------------------------------
  recordCount += 1;
  records.push(
    (
      "A" +
      num(recordCount, 9) +
      originControl +
      julian(run.fileCreationDate) +
      num(Number(s.dataCentre), 5) +
      " ".repeat(20) + // reserved customer-direct clearer communication area
      "CAD"
    ).padEnd(RECORD_LEN, " "),
  );

  // -- C: credit details, 6 segments per logical record -------------------
  const returnRouting = institutionalId(s.institution, s.transit);
  const returnAccount = alpha(s.account, 12);

  const segments = run.payments.map((p) => {
    if (p.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    return (
      txnType + // transaction type (3)
      num(p.amountCents, 10) + // amount in cents (10)
      julian(p.fundsDate) + // date funds to be available (6)
      institutionalId(p.institution, p.transit) + // payee institutional id (9)
      alpha(p.accountNumber, 12) + // payee account number (12)
      "0".repeat(22) + // item trace number (22)
      "0".repeat(3) + // stored transaction type (3)
      alpha(s.originatorShortName, 15) + // originator short name (15)
      alpha(p.payeeName, 30) + // payee name (30)
      alpha(s.originatorLongName, 30) + // originator long name (30)
      originatorId + // originating direct clearer's user id (10)
      alpha(p.crossReference, 19) + // originator cross-reference (19)
      returnRouting + // institutional id for returns (9)
      returnAccount + // account number for returns (12)
      " ".repeat(15) + // originator sundry information (15)
      " ".repeat(22) + // filler (22)
      " ".repeat(2) + // originator-direct clearer settlement code (2)
      "0".repeat(11) // invalid data element id (11)
    );
  });
  for (const seg of segments) {
    if (seg.length !== SEGMENT_LEN) throw new PaymentError("internal error: CPA-005 segment is not 240 characters");
  }

  for (let i = 0; i < segments.length; i += SEGMENTS_PER_RECORD) {
    recordCount += 1;
    const chunk = segments.slice(i, i + SEGMENTS_PER_RECORD).join("");
    records.push(("C" + num(recordCount, 9) + originControl + chunk).padEnd(RECORD_LEN, " "));
  }

  // -- Z: trailer ---------------------------------------------------------
  const totalValue = run.payments.reduce((acc, p) => acc + p.amountCents, 0n);
  recordCount += 1;
  records.push(
    (
      "Z" +
      num(recordCount, 9) +
      originControl +
      num(0, 14) + // total value of debit transactions
      num(0, 8) + // total number of debit transactions
      num(totalValue, 14) + // total value of credit transactions
      num(run.payments.length, 8) + // total number of credit transactions
      num(0, 14) + // total value of error corrections "E"
      num(0, 8) + // total number of error corrections "E"
      num(0, 14) + // total value of error corrections "F"
      num(0, 8) // total number of error corrections "F"
    ).padEnd(RECORD_LEN, " "),
  );

  for (const rec of records) {
    if (rec.length !== RECORD_LEN) throw new PaymentError("internal error: CPA-005 record is not 1464 characters");
  }
  return records.join("\r\n") + "\r\n";
}

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
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
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

  const rows = (await db.execute(sql`
    select i.id, i.amount, p.display_name as payee, b.routing, b.account_number_encrypted,
           d.document_number
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      join party_bank_accounts b on b.id = i.payee_bank_account_id
      left join documents d on d.id = i.payment_document_id
     where i.payment_run_id = ${runId} and i.status <> 'cancelled'
     order by p.display_name
  `)) as unknown as {
    rows: {
      id: string;
      amount: string;
      payee: string;
      routing: Record<string, string>;
      account_number_encrypted: string;
      document_number: string | null;
    }[];
  };
  if (rows.rows.length === 0) throw new PaymentError("run has no payable instructions");

  const fundsDate = run.scheduledFor ? new Date(`${run.scheduledFor}T00:00:00`) : new Date();
  const payments: Cpa005Payment[] = rows.rows.map((r) => {
    const units = toUnits(r.amount);
    if (units % 100n !== 0n) {
      throw new PaymentError(`instruction for ${r.payee} has sub-cent precision (${r.amount})`);
    }
    return {
      amountCents: units / 100n,
      fundsDate,
      institution: r.routing.institution,
      transit: r.routing.transit,
      accountNumber: decryptAccountNumber(r.account_number_encrypted),
      payeeName: r.payee,
      crossReference: r.document_number ?? r.id.slice(0, 19),
    };
  });

  const numeric = run.runNumber.replace(/\D/g, "");
  const fileCreationNumber = ((Number(numeric || "1") - 1) % 9999) + 1;

  const content = buildCpa005File({
    settings: eft.settings,
    fileCreationNumber,
    fileCreationDate: new Date(),
    payments,
  });
  return { filename: `CPA005-${run.runNumber}.txt`, content, runNumber: run.runNumber };
}

// ---------------------------------------------------------------------------
// NACHA (US ACH) — orgs.settings.nacha
// ---------------------------------------------------------------------------

export interface NachaSettings {
  /** ODFI 9-digit routing/ABA number (the originating bank). */
  odfiRouting: string;
  /** 10-char immediate destination (usually " " + destination routing 9). */
  immediateDestination: string;
  /** 10-char immediate origin (usually company id / " " + routing 9). */
  immediateOrigin: string;
  destinationName: string;
  originName: string;
  /** Company name on the batch (≤16). */
  companyName: string;
  /** Company id (10) — commonly "1" + 9-digit EIN. */
  companyId: string;
  /** PPD (consumer) or CCD (corporate). Default CCD. */
  entryClassCode?: "PPD" | "CCD";
  /** Batch entry description (≤10). Default "PAYMENT". */
  entryDescription?: string;
}

const NACHA_REQUIRED: (keyof NachaSettings)[] = [
  "odfiRouting", "immediateDestination", "immediateOrigin", "destinationName", "originName", "companyName", "companyId",
];

export function validateNachaSettings(raw: Partial<NachaSettings> | null): { ok: true; settings: NachaSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing = NACHA_REQUIRED.filter((k) => {
    const v = s[k];
    return typeof v !== "string" || v.trim() === "" || v.includes("FILL-ME");
  });
  if (missing.length) return { ok: false, missing };
  if (!/^\d{9}$/.test(s.odfiRouting!)) return { ok: false, missing: ["odfiRouting (9 digits)"] };
  return { ok: true, settings: s as NachaSettings };
}

export async function loadNachaSettings(orgId: string, runId?: string) {
  const r = (await db.execute(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id
      left join payment_runs r on r.payment_bank_profile_id = p.id
     where p.org_id = ${orgId} and p.is_active and f.rail in ('nacha_credit', 'nacha_debit')
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `)) as unknown as { rows: { originator_secrets_encrypted: string | null }[] };
  return validateNachaSettings(unsealJson<Partial<NachaSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

export interface NachaEntry {
  /** 22 = checking credit, 32 = savings credit. */
  transactionCode: "22" | "32";
  /** Receiving bank 9-digit routing (8 + check digit). */
  routingNumber: string;
  accountNumber: string;
  amountCents: bigint;
  individualId: string;
  individualName: string;
}

function nachaField(v: string, len: number, align: "l" | "r" = "l", pad = " "): string {
  const s = v.slice(0, len);
  return align === "l" ? s.padEnd(len, pad) : s.padStart(len, pad);
}

/** Build a NACHA ACH credit file (94-char records, blocked to 10). */
export function buildNachaFile(opts: {
  settings: NachaSettings;
  effectiveDate: Date;
  creationDate: Date;
  fileIdModifier?: string;
  entries: NachaEntry[];
}): string {
  const s = opts.settings;
  if (opts.entries.length === 0) throw new PaymentError("run has no payments to export");
  const sec = s.entryClassCode ?? "CCD";
  const odfi8 = s.odfiRouting.slice(0, 8);
  const yymmdd = (d: Date) => `${String(d.getFullYear() % 100).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;

  const rows: string[] = [];
  // 1 — File Header
  rows.push(
    "1" + "01" + nachaField(s.immediateDestination, 10, "r") + nachaField(s.immediateOrigin, 10, "r") +
    yymmdd(opts.creationDate) + hhmm(opts.creationDate) + (opts.fileIdModifier ?? "A") + "094" + "10" + "1" +
    nachaField(s.destinationName, 23) + nachaField(s.originName, 23) + nachaField("", 8),
  );
  // 5 — Batch Header (220 = credits only)
  rows.push(
    "5" + "220" + nachaField(s.companyName, 16) + nachaField("", 20) + nachaField(s.companyId, 10) + sec +
    nachaField(s.entryDescription ?? "PAYMENT", 10) + nachaField("", 6) + yymmdd(opts.effectiveDate) + nachaField("", 3) +
    "1" + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 6 — Entry Details
  let entryHash = 0n;
  let totalCredit = 0n;
  opts.entries.forEach((e, i) => {
    if (e.amountCents <= 0n) throw new PaymentError("payment amounts must be positive");
    const rt8 = e.routingNumber.slice(0, 8);
    const checkDigit = e.routingNumber.length >= 9 ? e.routingNumber[8] : nachaCheckDigit(rt8);
    entryHash += BigInt(rt8);
    totalCredit += e.amountCents;
    const trace = odfi8 + String(i + 1).padStart(7, "0");
    rows.push(
      "6" + e.transactionCode + rt8 + checkDigit + nachaField(e.accountNumber, 17) + nachaField(String(e.amountCents), 10, "r", "0") +
      nachaField(e.individualId, 15) + nachaField(e.individualName, 22) + nachaField("", 2) + "0" + trace,
    );
  });
  const hashMod = (entryHash % 10_000_000_000n).toString().padStart(10, "0");
  // 8 — Batch Control
  rows.push(
    "8" + "220" + nachaField(String(opts.entries.length), 6, "r", "0") + hashMod +
    nachaField("0", 12, "r", "0") + nachaField(String(totalCredit), 12, "r", "0") + nachaField(s.companyId, 10) +
    nachaField("", 19) + nachaField("", 6) + odfi8 + nachaField("0000001", 7, "r", "0"),
  );
  // 9 — File Control
  const entryCount = opts.entries.length;
  const blockCount = Math.ceil((rows.length + 1) / 10);
  rows.push(
    "9" + nachaField("1", 6, "r", "0") + nachaField(String(blockCount), 6, "r", "0") + nachaField(String(entryCount), 8, "r", "0") +
    hashMod + nachaField("0", 12, "r", "0") + nachaField(String(totalCredit), 12, "r", "0") + nachaField("", 39),
  );
  // pad with 9-filler records to a full 10-record block
  while (rows.length % 10 !== 0) rows.push("9".repeat(94));
  for (const r of rows) if (r.length !== 94) throw new PaymentError(`NACHA record is ${r.length} chars, not 94`);
  return rows.join("\n") + "\n";
}

/** ABA routing check digit (mod-10 weighted 3-7-1) from the first 8 digits. */
function nachaCheckDigit(rt8: string): string {
  const w = [3, 7, 1, 3, 7, 1, 3, 7];
  const sum = rt8.split("").reduce((a, d, i) => a + Number(d) * w[i], 0);
  return String((10 - (sum % 10)) % 10);
}

export async function loadNachaRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate ACH payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "ach") throw new PaymentError(`NACHA export applies to ACH runs, not ${run.method}`);
  const settings = await loadNachaSettings(orgId, runId);
  if (!settings.ok) throw new PaymentError(`ACH origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`);

  const rows = (await db.execute(sql`
    select i.id, i.amount, p.display_name as payee, b.routing, b.account_number_encrypted, d.document_number
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      join party_bank_accounts b on b.id = i.payee_bank_account_id
      left join documents d on d.id = i.payment_document_id
     where i.payment_run_id = ${runId} and i.status <> 'cancelled' order by p.display_name
  `)) as unknown as { rows: { id: string; amount: string; payee: string; routing: Record<string, string>; account_number_encrypted: string; document_number: string | null }[] };
  if (rows.rows.length === 0) throw new PaymentError("run has no payable instructions");

  const entries: NachaEntry[] = rows.rows.map((r) => {
    const units = toUnits(r.amount);
    if (units % 100n !== 0n) throw new PaymentError(`instruction for ${r.payee} has sub-cent precision (${r.amount})`);
    const routingNumber = r.routing.aba ?? r.routing.routingNumber ?? r.routing.routing ?? "";
    if (!/^\d{9}$/.test(routingNumber)) throw new PaymentError(`${r.payee}: US ACH needs a 9-digit routing number`);
    return {
      transactionCode: r.routing.accountType === "savings" ? "32" : "22",
      routingNumber,
      accountNumber: decryptAccountNumber(r.account_number_encrypted),
      amountCents: units / 100n,
      individualId: (r.document_number ?? r.id).slice(0, 15),
      individualName: r.payee,
    };
  });
  const effectiveDate = run.scheduledFor ? new Date(`${run.scheduledFor}T00:00:00`) : new Date();
  const content = buildNachaFile({ settings: settings.settings, effectiveDate, creationDate: new Date(), entries });
  return { filename: `NACHA-${run.runNumber}.ach`, content, runNumber: run.runNumber };
}

// ---------------------------------------------------------------------------
// SEPA — pain.001.001.03 credit transfer, orgs.settings.sepa
// ---------------------------------------------------------------------------

export interface SepaSettings {
  originatorName: string;
  originatorIban: string;
  originatorBic: string;
}

export function validateSepaSettings(raw: Partial<SepaSettings> | null): { ok: true; settings: SepaSettings } | { ok: false; missing: string[] } {
  const s = raw ?? {};
  const missing = (["originatorName", "originatorIban", "originatorBic"] as (keyof SepaSettings)[]).filter(
    (k) => typeof s[k] !== "string" || (s[k] as string).trim() === "" || (s[k] as string).includes("FILL-ME"),
  );
  if (missing.length) return { ok: false, missing };
  return { ok: true, settings: s as SepaSettings };
}

export async function loadSepaSettings(orgId: string, runId?: string) {
  const r = (await db.execute(sql`
    select p.originator_secrets_encrypted
      from payment_bank_profiles p
      join payment_formats f on f.id = p.payment_format_id
      left join payment_runs r on r.payment_bank_profile_id = p.id
     where p.org_id = ${orgId} and p.is_active and f.rail in ('sepa_credit', 'sepa_debit')
       and (${runId ?? null}::uuid is null or r.id = ${runId ?? null})
     order by case when r.id is not null then 0 else 1 end, p.created_at
     limit 1
  `)) as unknown as { rows: { originator_secrets_encrypted: string | null }[] };
  return validateSepaSettings(unsealJson<Partial<SepaSettings>>(r.rows[0]?.originator_secrets_encrypted));
}

const xmlEsc = (v: string) => v.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));

/** Build a SEPA pain.001.001.03 Customer Credit Transfer Initiation (EUR). */
export function buildSepaFile(opts: {
  settings: SepaSettings;
  messageId: string;
  creationDateTime: string; // ISO
  executionDate: string; // YYYY-MM-DD
  payments: { endToEndId: string; amount: string; creditorName: string; creditorIban: string; creditorBic?: string | null; remittance: string | null }[];
}): string {
  const s = opts.settings;
  if (opts.payments.length === 0) throw new PaymentError("run has no payments to export");
  const ctrlSum = formatMoney(sum(opts.payments.map((payment) => payment.amount)), 2);
  const nb = opts.payments.length;
  const tx = opts.payments.map((p) => {
    const bic = (p.creditorBic ?? "").trim();
    return `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${xmlEsc(p.endToEndId.slice(0, 35))}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">${formatMoney(p.amount, 2)}</InstdAmt></Amt>
${bic ? `        <CdtrAgt><FinInstnId><BIC>${xmlEsc(bic)}</BIC></FinInstnId></CdtrAgt>\n` : ""}        <Cdtr><Nm>${xmlEsc(p.creditorName.slice(0, 70))}</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>${xmlEsc(p.creditorIban.replace(/\s/g, ""))}</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>${xmlEsc((p.remittance ?? p.endToEndId).slice(0, 140))}</Ustrd></RmtInf>
      </CdtTrfTxInf>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${xmlEsc(opts.messageId.slice(0, 35))}</MsgId>
      <CreDtTm>${opts.creationDateTime}</CreDtTm>
      <NbOfTxs>${nb}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <InitgPty><Nm>${xmlEsc(s.originatorName.slice(0, 70))}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${xmlEsc(opts.messageId.slice(0, 35))}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${nb}</NbOfTxs>
      <CtrlSum>${ctrlSum}</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>${opts.executionDate}</ReqdExctnDt>
      <Dbtr><Nm>${xmlEsc(s.originatorName.slice(0, 70))}</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>${xmlEsc(s.originatorIban.replace(/\s/g, ""))}</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>${xmlEsc(s.originatorBic)}</BIC></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
${tx}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

export async function loadSepaRunFile(runId: string, orgId: string, now: Date): Promise<{ filename: string; content: string; runNumber: string }> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "sepa") throw new PaymentError(`SEPA export applies to SEPA runs, not ${run.method}`);
  const settings = await loadSepaSettings(orgId, runId);
  if (!settings.ok) throw new PaymentError(`SEPA origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`);

  const rows = (await db.execute(sql`
    select i.id, i.amount, p.display_name as payee, b.routing, b.account_number_encrypted, d.document_number
      from payment_instructions i
      join parties p on p.id = i.payee_party_id
      join party_bank_accounts b on b.id = i.payee_bank_account_id
      left join documents d on d.id = i.payment_document_id
     where i.payment_run_id = ${runId} and i.status <> 'cancelled' order by p.display_name
  `)) as unknown as { rows: { id: string; amount: string; payee: string; routing: Record<string, string>; account_number_encrypted: string; document_number: string | null }[] };
  if (rows.rows.length === 0) throw new PaymentError("run has no payable instructions");

  const payments = rows.rows.map((r) => {
    const iban = (r.routing.iban ?? decryptAccountNumber(r.account_number_encrypted)).replace(/\s/g, "");
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new PaymentError(`${r.payee}: SEPA needs a valid IBAN`);
    return {
      endToEndId: r.document_number ?? r.id,
      amount: r.amount,
      creditorName: r.payee,
      creditorIban: iban,
      creditorBic: r.routing.bic ?? null,
      remittance: r.document_number,
    };
  });
  const content = buildSepaFile({
    settings: settings.settings,
    messageId: `MSG-${run.runNumber}`,
    creationDateTime: now.toISOString().replace(/\.\d{3}Z$/, ""),
    executionDate: run.scheduledFor ?? now.toISOString().slice(0, 10),
    payments,
  });
  return { filename: `SEPA-${run.runNumber}.xml`, content, runNumber: run.runNumber };
}

/** Dispatch a payment run to its bank file by method (eft→CPA-005, ach→NACHA, sepa→pain.001). */
export async function loadRunFile(runId: string, orgId: string, now: Date): Promise<{ filename: string; content: string; runNumber: string; contentType: string }> {
  const [run] = await db.select().from(schema.paymentRuns).where(eq(schema.paymentRuns.id, runId));
  if (!run || run.orgId !== orgId) throw new PaymentError("payment run not found");
  if (run.method === "ach") return { ...(await loadNachaRunFile(runId, orgId)), contentType: "text/plain; charset=us-ascii" };
  if (run.method === "sepa") return { ...(await loadSepaRunFile(runId, orgId, now)), contentType: "application/xml" };
  return { ...(await loadCpa005RunFile(runId, orgId)), contentType: "text/plain; charset=us-ascii" };
}
