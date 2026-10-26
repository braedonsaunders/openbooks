import { EXPLICIT_GUARD_DIGESTS } from "./tenant-retirement-explicit-guard-digests.ts";
import { ACCOUNTING_THROUGH_HRM_GUARD_DIGESTS } from "./tenant-retirement-guard-digests-accounting-through-hrm.ts";
import { HRM_THROUGH_PICK_GUARD_DIGESTS } from "./tenant-retirement-guard-digests-hrm-through-pick.ts";
import { POSITION_THROUGH_PERIOD_END_GUARD_DIGESTS } from "./tenant-retirement-guard-digests-position-through-period-end.ts";

export const TENANT_RETIREMENT_GUARDS = [
  ...EXPLICIT_GUARD_DIGESTS,
  ...ACCOUNTING_THROUGH_HRM_GUARD_DIGESTS,
  ...HRM_THROUGH_PICK_GUARD_DIGESTS,
  ...POSITION_THROUGH_PERIOD_END_GUARD_DIGESTS,
] as const;
