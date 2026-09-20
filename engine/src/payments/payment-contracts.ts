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

export type PaymentKind = "vendor_payment" | "customer_payment";
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
