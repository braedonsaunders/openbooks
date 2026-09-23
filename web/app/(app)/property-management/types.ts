import type {
  CamAllocationRow,
  CamPoolRow,
  LeaseChargeRow,
  LeaseEscalationRow,
  LeaseScheduleRow,
  ManagedPropertyRow,
  OverdueInvoiceRow,
  OverdueLeaseRow,
  PropertyLeaseRow,
  PropertyUnitRow,
  ScheduleCountRow,
  SecurityDepositRow,
} from "@openbooks/engine/src/property/management.ts";

export type PropertyWorkspace = {
  properties: ManagedPropertyRow[];
  units: PropertyUnitRow[];
  leases: PropertyLeaseRow[];
  charges: LeaseChargeRow[];
  escalations: LeaseEscalationRow[];
  schedules: LeaseScheduleRow[];
  /** Full schedule-line count: the preview above is capped, this is not. */
  scheduleTotal: number;
  /** True when older lines fell out of the capped preview. */
  schedulesTruncated: boolean;
  /** Complete per-lease schedule-line counts for "showing N of M". */
  scheduleCountsByLease: ScheduleCountRow[];
  /** As-of date of the server-side past-due aggregate below. */
  overdueAsOf: string;
  /** Portfolio past-due total over ALL posted documents, never the preview. */
  overdueTotal: string;
  /** Per-lease past-due balances over ALL posted documents. */
  overdueByLease: OverdueLeaseRow[];
  /** Every posted overdue invoice behind the aggregate, for arrears detail. */
  overdueInvoices: OverdueInvoiceRow[];
  deposits: SecurityDepositRow[];
  camPools: CamPoolRow[];
  camAllocations: CamAllocationRow[];
};

export type PropertyRow = ManagedPropertyRow;
export type UnitRow = PropertyUnitRow;
export type LeaseRow = PropertyLeaseRow;
export type ChargeRow = LeaseChargeRow;
export type EscalationRow = LeaseEscalationRow;
export type ScheduleRow = LeaseScheduleRow;
export type DepositRow = SecurityDepositRow;
export type CamPool = CamPoolRow;
export type CamAllocation = CamAllocationRow;
export type Money = (value: string | number, options?: { currency?: string }) => string;
export type WorkspaceOption = { id: string; name: string; currency?: string; partyId?: string; openBalance?: string };
export type WorkspaceOptions = {
  subsidiaries: WorkspaceOption[];
  locations: WorkspaceOption[];
  tenants: WorkspaceOption[];
  incomeAccounts: WorkspaceOption[];
  expenseAccounts: WorkspaceOption[];
  liabilityAccounts: WorkspaceOption[];
  bankAccounts: WorkspaceOption[];
  assets: WorkspaceOption[];
  openInvoices: WorkspaceOption[];
};
export type PropertyPermissions = {
  manage: boolean;
  bill: boolean;
  account: boolean;
  bulk: boolean;
  customize: boolean;
};
export type PropertyAction = (
  payload: Record<string, unknown>,
  success: string,
  // A refused action still toasts, but the toast alone let the CAM Finalize
  // refusal read as silence (F-t07-007): callers that own a record surface
  // can pin the same reason there until the next attempt.
  onError?: (message: string) => void,
) => Promise<Record<string, unknown> | null>;
export type SaveAction = (
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown> | null | void>;
export type LeaseForm = {
  propertyId: string;
  unitId: string;
  tenantId: string;
  leaseNumber: string;
  startsOn: string;
  endsOn: string;
  baseRent: string;
  billingDay: string;
  paymentTermsDays: string;
  securityDepositRequired: string;
  camMethod: string;
  camSharePercent: string;
  lateFeeType: string;
  lateFeeValue: string;
  graceDays: string;
  autoInvoice: boolean;
  autoPost: boolean;
};
