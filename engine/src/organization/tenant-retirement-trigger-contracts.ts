import { CHANGE_CONTROL_TRIGGER_CONTRACTS } from "./tenant-retirement-change-control-contracts.ts";
import { EQUITY_TRIGGER_CONTRACTS } from "./tenant-retirement-equity-contracts.ts";
import { FINANCIAL_EVIDENCE_TRIGGER_CONTRACTS } from "./tenant-retirement-financial-evidence-contracts.ts";
import { RECORD_PROTECTION_TRIGGER_CONTRACTS } from "./tenant-retirement-record-protection-contracts.ts";
import { LIFECYCLE_TRIGGER_CONTRACTS } from "./tenant-retirement-lifecycle-contracts.ts";
import { PAYROLL_TRIGGER_CONTRACTS } from "./tenant-retirement-payroll-contracts.ts";
import { OPERATIONS_TRIGGER_CONTRACTS } from "./tenant-retirement-operations-contracts.ts";
import { PERIOD_END_TRIGGER_CONTRACTS } from "./tenant-retirement-period-end-contracts.ts";

export const TENANT_RETIREMENT_TRIGGER_CONTRACTS = [
  ...CHANGE_CONTROL_TRIGGER_CONTRACTS,
  ...EQUITY_TRIGGER_CONTRACTS,
  ...FINANCIAL_EVIDENCE_TRIGGER_CONTRACTS,
  ...RECORD_PROTECTION_TRIGGER_CONTRACTS,
  ...LIFECYCLE_TRIGGER_CONTRACTS,
  ...PAYROLL_TRIGGER_CONTRACTS,
  ...OPERATIONS_TRIGGER_CONTRACTS,
  ...PERIOD_END_TRIGGER_CONTRACTS,
] as const;
