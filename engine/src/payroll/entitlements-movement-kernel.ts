import { add, cmp, mulDecimal, mulPercent, neg, roundMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import {
  type EntitlementMovementKind,
  type EntitlementPlan,
  type EntitlementPlanLimit,
} from "./entitlements-types.ts";

/* ------------------------------------------------------------------ */
/* The movement kernel                                                 */
/* ------------------------------------------------------------------ */

/** A ledger row the caller is being asked to write. */
export interface EntitlementMovement {
  planId: string;
  employeePartyId: string;
  movementDate: string;
  /** Signed, in the plan's unit. */
  amount: string;
  hours: string | null;
  kind: EntitlementMovementKind;
  /** Component the movement should appear against on the stub, if any. */
  componentId: string | null;
  note: string | null;
}

export interface EntitlementWarning {
  planId: string;
  planCode: string;
  employeePartyId: string;
  /** 'near_limit' crossed notifyBalance; 'over_limit' crossed maxBalance. */
  kind: "near_limit" | "over_limit";
  balance: string;
  threshold: string;
}

export interface PlanMovementResult {
  movements: EntitlementMovement[];
  warnings: EntitlementWarning[];
  /** Balance after applying every returned movement. */
  closingBalance: string;
}

export interface PlanMovementInput {
  plan: EntitlementPlan;
  employeePartyId: string;
  movementDate: string;
  /** Balance carried into this period (SUM of the ledger before this run). */
  openingBalance: string;
  /** Bankable earnings behind a percent_of_earnings accrual. */
  earnings: string;
  /** Hours on the stub behind a per_hour_worked accrual. */
  hours: string;
  /** Resolved cap for this employee/date, or null when unlimited. */
  limit: EntitlementPlanLimit | null;
  /** Service-tier override of plan.accrualValue, when a rung has been reached. */
  serviceAccrualValue?: string | null;
  /**
   * Per-employee rate the caller already owns elsewhere — for the migrated
   * Vacation plan this is employee_payroll_profiles.vacation_percent, which
   * keeps its one home on the payroll profile rather than being copied here.
   */
  employeeAccrualValue?: string | null;
}

/**
 * One plan's movements for one stub. Pure — this is the function the payroll
 * run calls per plan and the function the tests pin.
 *
 * accrue plans earn; owe plans repay. A repayment never overshoots: it is
 * capped at the outstanding negative balance, so a $1,200 benefit debt repaid
 * at $100 a period stops dead on the twelfth period at exactly zero and never
 * turns into a credit the employee is owed.
 *
 * Caps apply only to accrue plans (an 'owe' balance is bounded by zero):
 *   warn        — record the movement, return an over_limit warning;
 *   block       — throw PayrollError, so the run reports the employee and the
 *                 operator fixes configuration rather than discovering a
 *                 breached cap after posting;
 *   auto_payout — record the accrual AND a payout of the excess, landing the
 *                 bank exactly on the cap with the difference paid out.
 */
export function computePlanMovement(input: PlanMovementInput): PlanMovementResult {
  const { plan, employeePartyId, movementDate, openingBalance, limit } = input;
  const movements: EntitlementMovement[] = [];
  const warnings: EntitlementWarning[] = [];

  // Rate precedence: a reached service rung is org POLICY and wins; below it
  // the per-employee rate wins over the plan's base. Configure a ladder and
  // you mean it — that is the whole point of a schedule.
  const accrualValue = input.serviceAccrualValue
    ?? input.employeeAccrualValue
    ?? plan.accrualValue;
  const earned = accrualValue == null ? "0" : earnedAmount(plan, accrualValue, input);

  if (plan.direction === "owe") {
    // The balance is negative; recoup toward zero and stop there.
    const outstanding = cmp(openingBalance, "0") < 0 ? neg(openingBalance) : "0";
    const repayment = cmp(earned, outstanding) > 0 ? outstanding : earned;
    if (cmp(repayment, "0") > 0) {
      movements.push({
        planId: plan.id,
        employeePartyId,
        movementDate,
        amount: repayment,
        hours: null,
        kind: "repayment",
        componentId: plan.payoutComponentId,
        note: null,
      });
    }
    return { movements, warnings, closingBalance: add(openingBalance, repayment) };
  }

  let balance = openingBalance;
  if (cmp(earned, "0") > 0) {
    const projected = add(balance, earned);
    const max = limit?.maxBalance ?? null;
    if (max != null && cmp(projected, max) > 0) {
      if (plan.capBehavior === "block") {
        throw new PayrollError(
          `entitlement plan ${plan.code} would exceed its ${max} limit `
          + `(balance ${balance} + ${earned}) — raise the limit or pay the bank down`,
        );
      }
      if (plan.capBehavior === "auto_payout") {
        const excess = add(projected, neg(max));
        movements.push(accrualMovement(plan, employeePartyId, movementDate, earned, input.hours));
        movements.push({
          planId: plan.id,
          employeePartyId,
          movementDate,
          amount: neg(excess),
          hours: null,
          kind: "payout",
          componentId: plan.payoutComponentId,
          note: `Balance capped at ${max}`,
        });
        return { movements, warnings, closingBalance: max };
      }
      // warn: the movement still happens — the cap is a policy signal, not a
      // silent data loss.
      warnings.push({
        planId: plan.id,
        planCode: plan.code,
        employeePartyId,
        kind: "over_limit",
        balance: projected,
        threshold: max,
      });
    }
    movements.push(accrualMovement(plan, employeePartyId, movementDate, earned, input.hours));
    balance = projected;
  }

  const notify = limit?.notifyBalance ?? null;
  const alreadyOver = warnings.some((w) => w.kind === "over_limit");
  if (!alreadyOver && notify != null && cmp(balance, notify) >= 0) {
    warnings.push({
      planId: plan.id,
      planCode: plan.code,
      employeePartyId,
      kind: "near_limit",
      balance,
      threshold: notify,
    });
  }
  return { movements, warnings, closingBalance: balance };
}

/**
 * Money value of a ledger amount held in the plan's unit — the conversion
 * every stub line pays through.
 *
 * Money plans pass through (rounded to cents); hours plans value at the
 * employee's current hourly wage, the same valuation `entitlementBalances`
 * reports as `balanceMoney`. There is no wage, there is no price: an hours
 * bank with no resolvable wage is refused BY NAME rather than paid as its
 * hour count (40 hours at $30/h paid as $40.00) or, worse, as zero. The
 * remedy names the fix the operator can actually perform.
 */
export function entitlementMoneyValue(args: {
  plan: EntitlementPlan;
  /** Ledger amount in the plan's unit — a balance or a movement. */
  amount: string;
  /** The employee's hourly wage on the pay date; required for hours plans. */
  wage: string | null;
  /** Employee display name, for the refusal. */
  employeeName: string;
}): string {
  if (args.plan.unit === "money") return roundMoney(args.amount, 2);
  if (args.wage == null || cmp(args.wage, "0") <= 0) {
    throw new PayrollError(
      `entitlement plan ${args.plan.code} banks hours but ${args.employeeName} has no hourly wage `
      + `on the pay date — add a labor cost rate covering the pay date for this employee, then recalculate`,
    );
  }
  return roundMoney(mulDecimal(args.amount, args.wage), 2);
}

function accrualMovement(
  plan: EntitlementPlan,
  employeePartyId: string,
  movementDate: string,
  amount: string,
  hours: string,
): EntitlementMovement {
  return {
    planId: plan.id,
    employeePartyId,
    movementDate,
    amount,
    hours: plan.accrualMethod === "per_hour_worked" ? roundMoney(hours, 2) : null,
    kind: "accrual",
    componentId: plan.accrualComponentId,
    note: null,
  };
}

/** This period's earned (or scheduled-repayment) amount, to the cent. */
function earnedAmount(
  plan: EntitlementPlan,
  accrualValue: string,
  input: Pick<PlanMovementInput, "earnings" | "hours">,
): string {
  switch (plan.accrualMethod) {
    case "percent_of_earnings":
      // A percent of (money) earnings IS money. Banking it into an
      // hours-denominated plan would store dollars as hours — an
      // 80.00 accrual nobody worked — so the combination is refused at the
      // source, with the two coherent shapes named. Storage refuses it too
      // (the entitlement_plans check in the 0253 forward migration).
      if (plan.unit === "hours") {
        throw new PayrollError(
          `entitlement plan ${plan.code} banks hours but accrues a percent of earnings — `
          + `accrue per hour worked or a fixed amount per period instead, or change the plan's `
          + `unit to money, in Payroll setup → Entitlement plans`,
        );
      }
      return mulPercent(input.earnings, accrualValue, 2);
    case "per_hour_worked":
      return roundMoney(mulDecimal(accrualValue, input.hours), 2);
    case "fixed_per_period":
      return roundMoney(accrualValue, 2);
    case "manual":
      return "0";
  }
}
