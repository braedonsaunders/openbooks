/**
 * Stub line shape and the account stamps applied before a stub is stored.
 *
 * Kept beside run-stub-records.ts so each operation module stays within the
 * line bound. Callers still import the line type and stamps from run-stub-records.ts.
 */

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { PayrollError } from "./error.ts";

import { type Money } from "../money/brands.ts";

import { type PayrollAssessedOn } from "./packs.ts";

import { type EntitlementPlan } from "./entitlements.ts";

import type { BankCashFundingSplit, BankCashPayDateValuation } from "./run-bank-cash-evidence.ts";

import type { UsSupplementalWageCategory } from "./supplemental-wages.ts";

import type { UsStatutoryExemptionCategory } from "./statutory-exemptions.ts";

/** Which rung of the expense-account resolution answered for a stub line. */
export type ExpenseAccountSource =
  "item" | "component" | "department" | "org_default" | "entitlement_plan";

export interface Line {
  /** Priced operational quantity, independent of insured or benefit-counted hours. */
  derivedQuantity?: string;
  /** Rule code frozen when its operational facts are priced. */
  derivedRuleCode?: string;
  /** Exact recurring election allocation represented by this native line. */
  benefitAllocationId?: string;
  entitlementMovementKey?: string;
  /** False only for newly earned cash paid independently of an entitlement bank. */
  fundedByEntitlementBank?: boolean;
  /** Entitlement plan whose bank this line withdraws from or deposits into. */
  entitlementSettlementPlanId?: string;
  /** Audited funding split; carried only by the bank-funded portion line. */
  bankCashFundingSplit?: BankCashFundingSplit;
  /** Frozen native pay-date wage source the split's bank-funded portion is valued at. */
  bankCashValuation?: BankCashPayDateValuation;
  componentId: string | null;
  kind: "earning" | "deduction" | "employer_contribution" | "credit";
  // Brand boundary: every stub amount is canonical ledger money by the time
  // it lands on a line (divideMoney/allocateProportionally/entitlementMoneyValue
  // outputs, or roundMoney/mulPercent-closed values). Hours and rates stay
  // plain strings: they are quantities, not money.
  description: string;
  hours?: string;
  rate?: string;
  amount: Money;
  /** Civil dates that substantiate when an earning amount was earned. */
  earnedFrom?: string | null;
  earnedTo?: string | null;
  /** Covered configuration dates for a recurring component or elected benefit; independent of when wages were earned. */
  sourceEffectiveFrom?: string;
  sourceEffectiveTo?: string;
  /** Only fixed amounts use the configuration window as their monetary denominator. */
  sourceProratedByCoverage?: boolean;
  /** Native one-off input identity distinguishes a top-up from recurring configuration. */
  runAdjustmentId?: string;
  /** Native claim of an independently approved unpaid holiday entitlement. */
  holidayAllocationId?: string;
  projectId?: string | null;
  departmentId?: string | null;
  timeTypeId?: string | null;
  /** Service item the hours were worked on; only time-driven earning lines
   * carry one. Absent everywhere else — never inferred, never defaulted. */
  itemId?: string | null;
  /**
   * Expense account stamped at calculate (migration 0180). GL routing only:
   * setting these never changes what anyone is paid. Lines without an
   * item-driven stamp leave all three absent and post through the unchanged
   * component-then-default fallback.
   */
  expenseAccountId?: string | null;
  expenseAccountSource?: ExpenseAccountSource | null;
  expenseAccountEvidence?: { reason: string; reference: string } | null;
  sequence: number;
  taxable?: boolean;
  pensionable?: boolean;
  insurable?: boolean;
  /**
   * Per-program applicability for contribution programs the pack declares
   * (see `PayrollContributionProgram`): the earning type contributes to the
   * program's own base when its key is present and true. Absent key means
   * included, matching the sibling flags' default-true; an absent map means
   * every declared program includes the line. Never derived from another
   * program's base. The shared final stamp resolves each component-backed
   * earning after all sources have been appended; component-less holiday pay
   * carries no map and defaults to included, like the sibling flags.
   */
  programApplicability?: Record<string, boolean>;
  vacationable?: boolean;
  nonPeriodic?: boolean;
  taxTreatment?: string;
  supplementalWageCategory?: UsSupplementalWageCategory | null;
  /** Federal exemption class once the earning-component classification lands; absent until then. */
  statutoryExemptionCategory?: UsStatutoryExemptionCategory | null;
  statutoryReportingCategory?: string | null;
  statutoryReportingCode?: {
    formCode: string;
    boxCode: string;
    code: string;
    label: string;
  } | null;
  accrualOnly?: boolean;
  /**
   * Set on every pack-emitted statutory line: what the country pack declares
   * the amount is assessed on. `taxable_income` lines are dropped and
   * re-derived on each protection pass; `earnings` lines are computed once
   * and asserted unchanged (see the statutory pass below).
   */
  assessedOn?: PayrollAssessedOn;
  /** Time-type classification behind an hours line: the hours cap exempts
   *  overtime/double time charged to a job. */
  classification?: string;
  /** pay_components protection columns, carried so phase 10 needs no re-read. */
  protectionBase?: string;
  protectionMaxPercent?: string | null;
  protectionPriority?: number;
  /** pay_components.protection_class — the pack-declared class of order. */
  protectionClass?: string | null;
  includeInDisposableEarnings?: boolean;
  paymentKind?: "cash" | "non_cash";
  nonCashAccountId?: string | null;
}

/**
 * Entitlement settlement accounts (after the department pass, before
 * persistence): a line that withdraws from or deposits into a bank posts to
 * the plan's liability account. An accruing plan already expensed its bank as
 * it accrued, so drawing it relieves the liability instead of expensing the
 * same money twice; a deposit credits the account a later withdrawal
 * relieves. Cash paid outside the bank never carries a settlement plan and
 * keeps its expense stamp. Plans with neither an accrual component nor a
 * liability account keep their banks off the balance sheet and are left
 * unchanged.
 */
export function stampEntitlementSettlementAccounts(args: {
  lines: Line[];
  plans: readonly EntitlementPlan[];
  /** Active pay components, for the accrual component's credited liability. */
  components: readonly Record<string, unknown>[];
  employeeName: string;
}): void {
  const { lines, plans, components, employeeName } = args;
  for (const line of lines) {
    if (!line.entitlementSettlementPlanId) continue;
    if (line.kind !== "earning") {
      throw new PayrollError(
        `${employeeName}'s "${line.description}" settles an entitlement bank but is not an earning line — recalculate after correcting the plan's payout and deposit components`,
      );
    }
    const plan = plans.find((candidate) => candidate.id === line.entitlementSettlementPlanId);
    if (!plan)
      throw new PayrollError(
        `${employeeName}'s "${line.description}" settles an entitlement plan that is no longer active — reactivate the plan or remove the payout before recalculating`,
      );
    if (!plan.liabilityAccountId) {
      if (plan.accrualComponentId) {
        throw new PayrollError(
          `Entitlement plan ${plan.code} accrues a liability but names no liability account — set the plan's liability account before paying from its bank`,
        );
      }
      continue;
    }
    if (plan.accrualComponentId) {
      const accrual = components.find((component) => component.id === plan.accrualComponentId);
      const credited = accrual?.liability_account_id ? String(accrual.liability_account_id) : null;
      if (credited && credited !== plan.liabilityAccountId) {
        throw new PayrollError(
          `Entitlement plan ${plan.code} accrues to a different liability account than the plan names — align the accrual component's liability account with the plan's before paying from its bank`,
        );
      }
    }
    line.expenseAccountId = plan.liabilityAccountId;
    line.expenseAccountSource = "entitlement_plan";
    line.expenseAccountEvidence = {
      reason: `settles the ${plan.code} entitlement bank, so it posts to the plan's liability account`,
      reference: `entitlement_plans:${plan.id}`,
    };
  }
}

/**
 * Department expense mapping (one pass over the finished stub, before
 * persistence): for every line carrying a department, the component's
 * mapping for that department effective on the pay date answers first —
 * except item-routed lines, whose item account stays the most specific
 * rung. Component and org-default stamps are overwritten in memory (the
 * recalculate path deletes and reinserts, so no frozen stamp is ever
 * rewritten); the liability side is untouched.
 */
export async function stampDepartmentExpenseAccounts(args: {
  tx: Pick<typeof db, "execute">;
  orgId: string;
  lines: Line[];
  payDate: string;
}): Promise<void> {
  const { tx, orgId, lines, payDate } = args;
  const targets = lines.filter(
    (line) =>
      line.departmentId != null && line.componentId != null && line.expenseAccountSource !== "item",
  );
  if (targets.length === 0) return;
  const pairs = [
    ...new Map(
      targets.map((line) => [
        `${line.componentId}|${line.departmentId}`,
        { componentId: line.componentId!, departmentId: line.departmentId! },
      ]),
    ).values(),
  ];
  const mappings = await tx.execute<{
    pay_component_id: string;
    department_id: string;
    expense_account_id: string;
  }>(
    sql`
    select distinct on (m.pay_component_id, m.department_id)
           m.pay_component_id, m.department_id, m.expense_account_id
      from pay_component_department_expenses m
     where m.org_id = ${orgId} and m.is_active
       and (m.pay_component_id, m.department_id) in (${sql.join(
         pairs.map((pair) => sql`(${pair.componentId}::uuid, ${pair.departmentId}::uuid)`),
         sql`, `,
       )})
       and m.effective_from <= ${payDate}::date
       and (m.effective_to is null or ${payDate}::date <= m.effective_to)
     order by m.pay_component_id, m.department_id, m.effective_from desc
  `,
    "objects",
  );
  // The exclusion constraint admits one active window per component,
  // department and date, so at most one row answers per pair; the
  // effective_from ordering is a belt-and-braces tiebreak that can only
  // fire on rows written around the constraint.
  const byPair = new Map(
    mappings.map((row) => [`${row.pay_component_id}|${row.department_id}`, row.expense_account_id]),
  );
  for (const line of targets) {
    const accountId = byPair.get(`${line.componentId}|${line.departmentId}`);
    if (!accountId) continue;
    line.expenseAccountId = accountId;
    line.expenseAccountSource = "department";
    line.expenseAccountEvidence = {
      reason: `department mapping for this line's department answers before the component default`,
      reference: `pay_component_department_expenses:${line.componentId}:${line.departmentId}`,
    };
  }
}
