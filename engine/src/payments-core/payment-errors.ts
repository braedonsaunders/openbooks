// Shared constructors keep facade consumers and extracted policies on one error identity.

export class PaymentError extends Error {}

/** Raised when a caller lost the posting claim it was working under — the run
 *  moved on (terminal transition, or a recovered stale claim) and no further
 *  mutation from this worker may commit. */
export class PaymentRunPostingClaimFencedError extends PaymentError {
  constructor(runId: string) {
    super(`payment-run posting claim ${runId} no longer owns the run`);
    this.name = "PaymentRunPostingClaimFencedError";
  }
}

/**
 * Raised when a draft-payment save echoes a revision token that no longer
 * matches the row locked FOR UPDATE — another save committed first. The HTTP
 * layer maps this to 409 so the client reloads instead of overwriting.
 */
export class PaymentRevisionConflictError extends PaymentError {
  constructor() {
    super("this payment changed after you opened it; reload and review the latest revision");
    this.name = "PaymentRevisionConflictError";
  }
}

/**
 * Raised when a reused credit-application idempotency key cannot replay: a
 * changed payload, or a key colliding with another organization's
 * application row. The route maps this to 409 — fail closed, never the older
 * settlement as though it matched — and the message names the remedy, which
 * exists: reloading the panel shows what already settled.
 */
export class CreditApplicationConflictError extends PaymentError {
  constructor(reason: "changed-payload" | "foreign-key") {
    super(reason === "foreign-key"
      ? "This request key is already in use by another organization. Reload the credit panel to start a fresh request."
      : "This credit application was already saved with different details. Reload the credit panel, review what settled, and start a fresh request.");
    this.name = "CreditApplicationConflictError";
  }
}
