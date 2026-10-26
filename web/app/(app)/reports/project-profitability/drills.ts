import type { ReportDrillTarget } from "../../../../lib/report-drill";

/** What every drill on the report shares: the period, dimensions and basis. */
export type ProfitDrillBase = {
  from: string;
  to: string;
  dims: Record<string, unknown>;
  basis?: string;
  activeProjects: boolean;
};

/** What one row narrows the shared drill to. */
export type ProfitDrillScope = {
  projectId?: string;
  customerId?: string;
  unassignedCustomer?: boolean;
  search?: string;
};

export type ProfitMetric =
  "revenue" | "cogs" | "grossProfit" | "expenses" | "net" | "margin" | "hours";

const REVENUE = ["income", "income_other"];
const EXPENSES = ["expense", "expense_other", "expense_deferred"];

/** Unset dimensions are left out rather than sent as explicit empties. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null),
  ) as T;
}

/**
 * Every metric cell's drill for one row, built where the row renders: the
 * report sends the shared base once and each row only its scope, instead of
 * seven fully spelled-out targets per project.
 */
export function profitDrillTargets(
  base: ProfitDrillBase,
  label: string,
  scope: ProfitDrillScope,
): Record<ProfitMetric, ReportDrillTarget> {
  const activeProjectsOnly = base.activeProjects && !scope.projectId;
  const dims = compact(scope.projectId ? { ...base.dims, projectId: scope.projectId } : base.dims);
  const ledger = (accountTypes: string[], profitSigned = false): ReportDrillTarget =>
    compact({
      kind: "ledger",
      label,
      accountTypes,
      from: base.from,
      to: base.to,
      mode: "flow",
      dims,
      projectCustomerId: scope.customerId,
      unassignedProjectCustomer: scope.unassignedCustomer,
      projectSearch: scope.search,
      activeProjectsOnly,
      profitSigned,
      basis: base.basis,
    }) as ReportDrillTarget;
  const net = ledger([...REVENUE, "cogs", ...EXPENSES], true);
  return {
    revenue: ledger(REVENUE),
    cogs: ledger(["cogs"]),
    grossProfit: ledger([...REVENUE, "cogs"], true),
    expenses: ledger(EXPENSES),
    net,
    margin: net,
    hours: compact({
      kind: "time",
      label,
      from: base.from,
      to: base.to,
      projectId: scope.projectId,
      projectCustomerId: scope.customerId,
      unassignedProjectCustomer: scope.unassignedCustomer,
      projectSearch: scope.search,
      activeProjectsOnly,
    }) as ReportDrillTarget,
  };
}
