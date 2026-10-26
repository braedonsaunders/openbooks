import { closeModuleForDocument, type CloseModule } from "../periods/period-policy.ts";

/**
 * Machine-readable void refusal reasons. The human message
 * travels unchanged in `message`; `code` lets callers branch — the journal
 * drawer maps the three actionable refusals to localized copy instead of
 * toasting raw kernel text. Every other refusal is `invalid`.
 */
export type DocumentVoidCode =
  | "invalid"
  | "posting-effects-incomplete"
  | "stale-revision"
  | "reversal-period-uncovered"
  | "reversal-period-closed"
  | "retainer-drawdowns-posted"
  | "billed-on-invoice"
  | "receipt-stock-consumed"
  | "bill-stock-consumed";

/** A refused document void. Void-remedy hooks refuse with it too. */
export class DocumentVoidError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code: DocumentVoidCode = "invalid",
    /** Machine-readable evidence (never internals): the API boundary renders plain-object details. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * Close module guarding a void's reversal postings. Registered kinds resolve
 * through the one kind map; a goods receipt unwinds AP-side fulfillment (the
 * purchase-order side of the sales-side shipment → "ar" precedent), so its
 * void answers the AP lock the same way a purchase-order void does. The
 * storage fence still judges the reversal journals GL-only for this kind —
 * this companion only decides which module lock can push the void's date
 * forward, never whether the journals may post.
 */
export function voidCloseModule(kind: string): CloseModule {
  if (kind === "purchase_receipt") return "ap";
  return closeModuleForDocument(kind);
}
