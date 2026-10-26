/**
 * Effect hooks: subledger, automation and event effects of a committed
 * posting. Every effect is idempotent by document or journal line, so the
 * post-commit drain may run it again. Ordering and installation: see
 * posting-contributors.ts.
 */
import type { SqlExecutor } from "../platform/db.ts";
import { postingContributorRegistry } from "./posting-contributors.ts";
import type { DocumentScriptHooks } from "./posting-preconditions.ts";

export interface PostingEffectContributors {
  "stored-value": {
    issueForInvoice(documentId: string, orgId: string, actorId: string | null): Promise<unknown>;
    issueStoreCreditForCreditMemo(
      documentId: string,
      orgId: string,
      actorId: string | null,
    ): Promise<unknown>;
  };
  assets: {
    /** Asset proposals for the entry's capitalizable lines; a no-op unless proposals are switched on. */
    proposeForPostedEntry(orgId: string, entryId: string, actorId: string | null): Promise<unknown>;
  };
  scripting: DocumentScriptHooks;
  webhooks: {
    documentPosted(executor: SqlExecutor, orgId: string, documentId: string): Promise<unknown>;
    paymentReceived(executor: SqlExecutor, orgId: string, documentId: string): Promise<unknown>;
  };
  inventory: {
    /** Receipts of a vendor bill, inside the posting transaction. */
    applyBillReceipts(
      runner: SqlExecutor,
      orgId: string,
      actorId: string | null,
      documentId: string,
      billEntryId: string,
      date: string,
      subsidiaryId: string,
    ): Promise<unknown>;
    /** Returns of a vendor credit, inside the posting transaction. */
    applyVendorCreditReturns(
      runner: SqlExecutor,
      orgId: string,
      actorId: string | null,
      documentId: string,
      date: string,
      subsidiaryId: string,
    ): Promise<unknown>;
    issueForInvoice(
      orgId: string,
      actorId: string | null,
      documentId: string,
      date: string,
      subsidiaryId: string,
    ): Promise<unknown>;
    receiveForBill(
      orgId: string,
      actorId: string | null,
      documentId: string,
      billEntryId: string,
      date: string,
      subsidiaryId: string,
    ): Promise<unknown>;
    returnForVendorCredit(
      orgId: string,
      actorId: string | null,
      documentId: string,
      date: string,
      subsidiaryId: string,
    ): Promise<unknown>;
    returnForCustomerCredit(
      orgId: string,
      actorId: string | null,
      documentId: string,
      date: string,
      subsidiaryId: string,
    ): Promise<unknown>;
  };
  "payments-core": {
    /** Completes the payment acceptance a posted customer payment settles. */
    finalizeAcceptance(paymentDocumentId: string): Promise<void>;
  };
  tax: {
    /** Queues the external tax provider commit of a sale or return, inside the posting transaction. */
    trackProviderCommit(
      runner: SqlExecutor,
      input: {
        orgId: string;
        documentId: string;
        kind: string;
        documentNumber: string;
        actorId: string | null;
      },
    ): Promise<void>;
  };
  sales: {
    /** Redeems a cash sale's stored-value tenders against its entry; a refused tender throws a PostingError. */
    redeemCashSaleTenders(
      orgId: string,
      documentId: string,
      options: { journalEntryId: string; actorId: string | null },
    ): Promise<void>;
    hasStoredValueTenders(runner: SqlExecutor, orgId: string, documentId: string): Promise<boolean>;
    /** Settles a cash refund's stored-value tenders per tender. */
    settleCashRefundTenders(
      orgId: string,
      documentId: string,
      options: { journalEntryId: string; actorId: string | null },
    ): Promise<unknown>;
  };
  revenue: {
    /** Performance obligations of an invoice's deferred lines. */
    createObligationsFromInvoice(
      documentId: string,
      orgId: string,
      actorId: string | null,
    ): Promise<unknown>;
  };
}

export const postingEffectHooks = postingContributorRegistry<PostingEffectContributors>("effect");
