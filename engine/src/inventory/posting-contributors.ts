import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import {
  postingLineHooks,
  type PostingLineContributors,
} from "../journal/posting-line-contributors.ts";
import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import {
  voidRemedyHooks,
  type VoidRemedyContributors,
} from "../journal/void-remedy-contributors.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import { InventoryError } from "./contracts.ts";
import { reverseBillInventoryReceipts, reverseOrderShipment } from "./document-void-remedies.ts";
import {
  applyInventoryReturnsForCustomerCredit,
  assertCustomerCreditInventoryReturnsPostable,
} from "./documents-customer-credits.ts";
import {
  applyBillInventoryReceipts,
  applyInventoryReceiptsForBill,
  assertBillReceiptsPostable,
  resolveBillInventoryAccounts,
} from "./documents-purchasing.ts";
import { autoMatchBillLinesToOrders } from "./bill-order-matching.ts";
import { applyInventoryIssuesForInvoice, assertInvoiceIssuesPostable } from "./documents-sales.ts";
import {
  applyInventoryReturnsForVendorCredit,
  applyVendorCreditInventoryReturns,
  assertVendorCreditInventoryReturnsPostable,
  resolveVendorCreditInventoryAccounts,
} from "./documents-vendor-credits.ts";
import { AgencyError, resolveAgencyPosting } from "./drop-ship-agency.ts";
import { reverseDropShipConfirmationPair } from "./drop-ship-reversal.ts";
import { listReceiptVoidBlockers } from "./receipt-void-dependents.ts";
import { assertReturnSourceSelectable } from "./returnable-sources.ts";
import { activeStockLocations, profiledItemIds } from "./stock-locations.ts";

const lines: PostingLineContributors["inventory"] = {
  async agencyByLine(runner, orgId, documentId) {
    try {
      return await resolveAgencyPosting(runner, orgId, documentId);
    } catch (error) {
      if (error instanceof AgencyError) throw new PostingError(error.message);
      throw error;
    }
  },
  replayAgencyByLine: resolveAgencyPosting,
  billInventoryAccounts: resolveBillInventoryAccounts,
  vendorCreditReturnAccounts: resolveVendorCreditInventoryAccounts,
};

const preconditions: PostingPreconditions["inventory"] = {
  matchBillLinesToOrders: autoMatchBillLinesToOrders,
  assertBillReceiptsPostable,
  assertInvoiceIssuesPostable,
  assertVendorCreditReturnsPostable: assertVendorCreditInventoryReturnsPostable,
  assertCustomerCreditReturnsPostable: assertCustomerCreditInventoryReturnsPostable,
  activeStockLocations,
  profiledItemIds,
  async assertReturnSourceSelectable(runner, orgId, selection, lineLabel) {
    try {
      await assertReturnSourceSelectable(runner, orgId, selection, lineLabel);
    } catch (error) {
      if (error instanceof InventoryError)
        throw new DocumentEditError(422, `${error.message}; nothing was changed`);
      throw error;
    }
  },
};

const effects: PostingEffectContributors["inventory"] = {
  applyBillReceipts: applyBillInventoryReceipts,
  applyVendorCreditReturns: applyVendorCreditInventoryReturns,
  issueForInvoice: applyInventoryIssuesForInvoice,
  receiveForBill: applyInventoryReceiptsForBill,
  returnForVendorCredit: applyInventoryReturnsForVendorCredit,
  returnForCustomerCredit: applyInventoryReturnsForCustomerCredit,
};

const remedies: VoidRemedyContributors["inventory"] = {
  receiptVoidBlockers: listReceiptVoidBlockers,
  reverseDropShipConfirmationPair,
  reverseBillReceipts: reverseBillInventoryReceipts,
  reverseOrderShipment,
};

/** Inventory: stock routing, posting checks, stock effects and void unwinds for documents. */
export function registerInventoryPostingContributors(): void {
  postingLineHooks.register("inventory", lines);
  postingPreconditionHooks.register("inventory", preconditions);
  postingEffectHooks.register("inventory", effects);
  voidRemedyHooks.register("inventory", remedies);
}
