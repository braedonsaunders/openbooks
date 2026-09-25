/** Property management. Split from property/management.ts (ARCH-FILE-SPLIT; pure moves only). */
export { billCamReconciliation, cancelCamPool, createCamPool, finalizeCamPool, reopenFinalizedCamPool, updateCamPool } from "./cam.ts";
export { recordSecurityDeposit, reverseSecurityDepositTransaction } from "./deposits.ts";
export { MAX_LEASE_SCHEDULE_HORIZON_MONTHS, activatePropertyLease, addLeaseEscalation, applyLeaseEscalation, scheduleLeaseCharges, terminatePropertyLease } from "./lease-schedules.ts";
export { addLeaseCharge, cancelPropertyLease, createPropertyLease, emptyRefToNull, updatePropertyLease } from "./leases.ts";
export { PropertyManagementError, depositBalance, depositPostingShape, depositReversalKind, escalatedRent, isSecurityDepositImportConflict, leaseChargeSchedule, overlapDayCount, prorateLeaseCharge } from "./management-foundation.ts";
export type { DepositKind, SchedulePeriod } from "./management-foundation.ts";
export { createManagedProperty, createPropertyUnit, deleteManagedProperty, deletePropertyUnit, updateManagedProperty, updatePropertyUnit } from "./properties.ts";
export { assessLeaseLateFees, billDueLeaseCharges, levelLeaseRentStraightLine, runDuePropertyBilling } from "./rent-billing.ts";
export type { LeaseLevellingResult } from "./rent-billing.ts";
export { SCHEDULE_PREVIEW_LIMIT, propertyManagementWorkspace, securityDepositReconciliation } from "./workspace.ts";
export type { CamAllocationRow, CamPoolRow, LeaseChargeRow, LeaseEscalationRow, LeaseScheduleRow, ManagedPropertyRow, OverdueInvoiceRow, OverdueLeaseRow, PropertyLeaseRow, PropertyUnitRow, ScheduleCountRow, SecurityDepositRow } from "./workspace.ts";
