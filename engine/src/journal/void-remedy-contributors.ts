/**
 * Void-remedy hooks: domain checks and reversals a void runs, inside the
 * void's own transaction unless stated otherwise. Ordering and installation:
 * see posting-contributors.ts.
 */
import type { db, SqlExecutor } from "../platform/db.ts";
import { postingContributorRegistry } from "./posting-contributors.ts";
import type { DocumentScriptHooks } from "./posting-preconditions.ts";

/** A transaction handed out by db.transaction. */
export type DocumentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A goods receipt's downstream consumption, as a void refusal names it. */
export interface ReceiptVoidRelief {
  receiptNumber: string;
  blockers: {
    dependents: { reverseAction: string; sourceDocument: { id: string; number: string } | null }[];
  }[];
  /** True only when every dependent reverses through its own document void. */
  allowVoidWithDependents: boolean;
  /** Unconsumed cover across the receipt's movements. */
  remainderQuantity: string;
}

export interface VoidRemedyContributors {
  scripting: DocumentScriptHooks;
  "stored-value": {
    /** Moves the card subledger with the journal reversal that moved the liability. */
    reverseForVoidedDocument(input: {
      orgId: string;
      documentId: string;
      documentNumber: string;
      reversalEntryId: string | null;
      actorId: string;
      reason: string;
    }): Promise<unknown>;
  };
  webhooks: {
    documentVoided(
      executor: SqlExecutor,
      orgId: string,
      documentId: string,
      input: { reversalEntryId: string | null; reason: string },
    ): Promise<unknown>;
  };
  payroll: {
    /** Returns the leave and allowance inputs a voided pay run consumed to the next run. */
    releaseRunInputs(
      executor: SqlExecutor,
      input: { orgId: string; runDocumentId: string },
    ): Promise<void>;
  };
  inventory: {
    /** What a goods receipt's downstream consumption blocks, and whether every dependent voids natively. */
    receiptVoidBlockers(
      runner: SqlExecutor,
      orgId: string,
      receiptId: string,
    ): Promise<ReceiptVoidRelief>;
    /** Reverses both halves of a drop-ship confirmation; null when the document is not one. */
    reverseDropShipConfirmationPair(
      tx: DocumentTransaction,
      input: {
        orgId: string;
        documentId: string;
        document: Record<string, unknown>;
        actorId: string;
        reversalDate: string;
        reason: string;
        reverseDocument: (
          documentId: string,
          kind: "purchase_receipt" | "sales_fulfillment",
        ) => Promise<void>;
      },
    ): Promise<{ pairedDocumentId: string; reversalEntryId: string | null } | null>;
    /** Unwinds a vendor bill's receipts and purchase price variance. */
    reverseBillReceipts(
      executor: SqlExecutor,
      input: {
        orgId: string;
        billId: string;
        billNumber: string;
        actorId: string;
        reversalDate: string;
        reason: string;
      },
    ): Promise<void>;
    /** Unwinds a shipment or goods receipt and restores its source order counters. */
    reverseOrderShipment(
      executor: SqlExecutor,
      input: {
        orgId: string;
        voidDocumentId: string;
        voidKind: string;
        actorId: string;
        reversalDate: string;
        reason: string;
      },
    ): Promise<void>;
  };
}

export const voidRemedyHooks = postingContributorRegistry<VoidRemedyContributors>("void remedy");
