import { EXPLICIT_GUARD_ATTRIBUTES } from "./tenant-retirement-explicit-guard-attributes.ts";
import { ACCOUNTING_THROUGH_HRM_GUARD_ATTRIBUTES } from "./tenant-retirement-guard-attributes-accounting-through-hrm.ts";
import { HRM_THROUGH_PICK_GUARD_ATTRIBUTES } from "./tenant-retirement-guard-attributes-hrm-through-pick.ts";
import { POSITION_THROUGH_PERIOD_END_GUARD_ATTRIBUTES } from "./tenant-retirement-guard-attributes-position-through-period-end.ts";

export const TENANT_RETIREMENT_GUARD_ATTRIBUTES = [
  ...EXPLICIT_GUARD_ATTRIBUTES,
  ...ACCOUNTING_THROUGH_HRM_GUARD_ATTRIBUTES,
  ...HRM_THROUGH_PICK_GUARD_ATTRIBUTES,
  ...POSITION_THROUGH_PERIOD_END_GUARD_ATTRIBUTES,
] as const;
