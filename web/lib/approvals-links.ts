// Deep-links from the approvals hub to each document kind's native module
// drawer. Built on the shared report→transaction map (txn-links.ts) and
// extended with the order-cycle kinds approvals can gate but reports never
// link to. Client-safe: no server-only imports.

import { moduleDrawerHref } from './txn-links'

const ORDER_HREF: Record<string, (id: string) => string> = {
  financial_change: (id) => `/accounting/changes?change=${id}`,
  quote: (id) => `/estimates?estimate=${id}`,
  sales_order: (id) => `/sales-orders?order=${id}`,
  purchase_order: (id) => `/purchase-orders?order=${id}`,
  close_run: (id) => `/close?run=${id}&stage=lock`,
  // Budgets open their module drawer, where the checker decision is recorded.
  budget_scenario: (id) => `/budgets?budget=${id}`,
  // Allocation runs have no record drawer: approvers land on the Runs tab,
  // which shows the pending run with its computation and lineage.
  allocation_run: () => `/admin/setup/allocations?tab=runs`,
  // Employment change requests open their queue, whose columns carry what
  // the approver decides (employee, kind, effective date, requester). The
  // engine adapter's deepLink names the same URL: one declaration of
  // where an approver inspects the request, never a second drawer.
  hrm_employment_change_request: (id) => `/hrm/change-requests?request=${id}`,
  // Leave requests open their dialog on the leave queue.
  hrm_leave_request: (id) => `/hrm/leave?request=${id}`,
  // Compensation cycles open their record page.
  hrm_comp_cycle: (id) => `/hrm/compensation/cycles/${id}`,
  // Timesheet weeks open their flyout; crew batches open on the crew page.
  // Both URLs mirror the engine adapters' deepLinks.
  timesheet_week: (id) => `/timesheets?timesheet=${id}`,
  crew_time_batch: (id) => `/time/crew?batch=${id}`,
  // Bank details render inside the party flyout, which needs the party id
  // — the engine adapter lands on the hub for the same reason, and so
  // does this resolver rather than a second, party-less drawer.
  party_bank_account: () => `/inbox`,
}

/**
 * The URL that opens an approval subject's native record drawer, or null when
 * the kind has no module surface (the row renders as plain text).
 */
export function approvalRecordHref(
  kind: string | null | undefined,
  id: string | null | undefined,
): string | null {
  if (!kind || !id) return null
  const order = ORDER_HREF[kind]
  if (order) return order(id)
  return moduleDrawerHref(kind, id)
}
