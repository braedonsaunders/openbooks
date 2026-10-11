import { type AllocationInput } from "./settlement-policy.ts";
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

import type { PaymentKind } from "../payments-core/payment-document-lock.ts";
export type { PaymentKind } from "../payments-core/payment-document-lock.ts";
export type OpenItemSide = "ap" | "ar";

export const PAYMENT_KIND_SIDE: Record<PaymentKind, OpenItemSide> = {
  vendor_payment: "ap",
  customer_payment: "ar",
};

export interface CreditAllocationInput {
  fromLineId: string;
  toLineId: string;
  amount: string;
  sourceDocumentId: string;
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
  /** The receivable/payable account the open item sits on. A payment settles
   *  one account: every application shares its source's account. */
  accountId: string;
  accountNumber: string | null;
  accountName: string;
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
  /**
   * The live payment run that has reserved this item, if any. A reserved
   * item is paid by that run; settling it anywhere else is refused.
   */
  reservedByRun: { runId: string; runNumber: string; runStatus: string } | null;
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
 * Payee bank-account state as payment runs read it. Client-safe: the run
 * builder and the bank-details panel classify rows with the same rule the
 * SQL predicates in payments/payee-bank-account apply.
 */
export type PayeeBankState = "approved" | "pending" | "undated" | "missing";

export interface PayeeBankAccountFields {
  approvalStatus: string | null;
  approvedAt: string | null;
  isActive: boolean;
  retiredAt: string | null;
}

/**
 * Classify one bank account row. A retired row is always `missing` (its
 * retirement also clears is_active). `undated` is an approved status without
 * an approval date: a state payment runs refuse, which the operator resolves
 * by saving the details again to re-approve them.
 */
export function classifyPayeeBankAccount(row: PayeeBankAccountFields): PayeeBankState {
  if (row.retiredAt) return "missing";
  if (row.approvalStatus === "approved") {
    if (row.approvedAt === null) return "undated";
    return row.isActive ? "approved" : "missing";
  }
  if (row.approvalStatus === "pending") return "pending";
  return "missing";
}
