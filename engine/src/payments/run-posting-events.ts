/** Event types written by the payment-run posting lifecycle. */
export const PAYMENT_RUN_POSTING_EVENTS = {
  recovered: "run_posting_recovered",
  started: "run_posting_started",
  instructionSent: "instruction_sent",
  failed: "run_posting_failed",
  completed: "run_posting_completed",
} as const;

export const PAYMENT_RUN_POSTING_EVENT_TYPES = Object.values(PAYMENT_RUN_POSTING_EVENTS);
