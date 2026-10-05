/** Restocking fee policies the returns workflow and the setup registry share. */
export {
  checkRestockingPolicyOverlap,
  recordRestockingFeeWaiver,
  resolveRestockingFee,
  restockingFeeCreditLines,
  RestockingFeeRefusal,
  validateRestockingFeePolicy,
} from "./restocking-fees.ts";
export type { ResolveRestockingFeeResult } from "./restocking-fees.ts";
