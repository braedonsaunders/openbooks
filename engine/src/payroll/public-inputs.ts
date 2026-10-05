/** Controlled pay-run input writes and previews for native import surfaces. */
export {
  mutatePayRunAdjustment,
  preflightPayRunAdjustment,
  payRunBulkAdjustmentId,
  PayRunAdjustmentIdempotencyConflict,
} from './run-adjustments.ts';
export type { PayRunAdjustmentMutation } from './run-adjustments.ts';
