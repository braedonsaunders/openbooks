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
