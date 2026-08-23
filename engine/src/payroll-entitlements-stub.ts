import { sql } from "drizzle-orm";
import { sum } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  computePlanMovement,
  type EntitlementMovement,
  type EntitlementWarning,
} from "./payroll-entitlements-movement-kernel.ts";
import {
  employeeScope,
  entitlementPlans,
  planBalanceExcludingRun,
  resolvePlanLimit,
  resolveServiceTier,
  type Executor,
} from "./payroll-entitlements-db.ts";
import { type EntitlementPlan } from "./payroll-entitlements-types.ts";

export interface StubEarningLine {
  componentId: string | null;
  amount: string;
  hours?: string | null;
  /** Earnings excluded from bankable pay (a vacation payout is not vacationable). */
  bankable?: boolean;
}

export interface StubMovementPlan {
  movements: EntitlementMovement[];
  warnings: EntitlementWarning[];
}

/**
 * Every plan's movements for one employee's stub.
 *
 * Given the stub's earning lines this returns the accrual, repayment, and
 * capped-payout movements the run should record — it writes nothing. The pay
 * run calls this while it still has the lines in hand, adds the returned
 * `componentId` movements to the stub as lines, and calls
 * recordEntitlementMovements inside the same transaction.
 *
 * Service tiers are applied first: a 10-year employee's vacation plan accrues
 * at the rung's rate, not the plan's base rate, for this and every future run.
 */
export async function planMovementsForStub(
  executor: Executor,
  input: {
    orgId: string;
    employeePartyId: string;
    /** Pay date; the movement date and the date every rule resolves on. */
    movementDate: string;
    /** Run whose prior movements must not be double-counted on recalculation. */
    payRunDocumentId: string | null;
    earnings: readonly StubEarningLine[];
    /** Plans to consider; loaded from the org when omitted. */
    plans?: readonly EntitlementPlan[];
    /** planId → per-employee rate the caller owns (vacation_percent, …). */
    employeeAccrualValues?: ReadonlyMap<string, string>;
  },
): Promise<StubMovementPlan> {
  const { orgId, employeePartyId, movementDate, payRunDocumentId } = input;
  const plans = input.plans ?? (await entitlementPlans(orgId, executor));
  if (plans.length === 0) return { movements: [], warnings: [] };

  const bankable = input.earnings.filter((line) => line.bankable !== false);
  const earnings = sum(bankable.map((line) => line.amount));
  const hours = sum(
    input.earnings.filter((line) => line.hours != null).map((line) => String(line.hours)),
  );

  const tiers = await resolveServiceTier(executor, orgId, employeePartyId, movementDate);
  // One scope lookup serves every plan's limit resolution for this employee.
  const scope = await employeeScope(executor, orgId, employeePartyId);
  const movements: EntitlementMovement[] = [];
  const warnings: EntitlementWarning[] = [];
  for (const plan of plans) {
    const openingBalance = await planBalanceExcludingRun(
      executor, orgId, plan.id, employeePartyId, movementDate, payRunDocumentId,
    );
    const limit = await resolvePlanLimit(
      executor, orgId, plan.id, employeePartyId, movementDate, scope,
    );
    const result = computePlanMovement({
      plan,
      employeePartyId,
      movementDate,
      openingBalance,
      earnings,
      hours,
      limit,
      serviceAccrualValue: tiers.planAccrualValues.get(plan.id) ?? null,
      employeeAccrualValue: input.employeeAccrualValues?.get(plan.id) ?? null,
    });
    movements.push(...result.movements);
    warnings.push(...result.warnings);
  }
  return { movements, warnings };
}

/**
 * Append one EMPLOYEE'S movements to the ledger, replacing whatever that
 * employee's previous pass on the same run wrote.
 *
 * The unit of replacement is the (run, EMPLOYEE) pair, never the run — because
 * the caller is per employee. `calculateStub` runs once per person, so a
 * run-wide delete here meant employee 2's call erased employee 1's rows: after
 * a 40-person run only the last employee had ledger rows at all, while all 40
 * stubs carried the accrual line and the GL carried the credit. Every other
 * employee's bank was silently short, forever.
 *
 * `employeePartyIds` is therefore REQUIRED whenever `payRunDocumentId` is set,
 * and must name every employee being rewritten — including one whose recompute
 * produced NO movements, whose stale rows must still go. The schema states the
 * same intent: `entitlement_ledger_run_movement` is unique on
 * (run, plan, employee, kind).
 *
 * Run-level cleanup (an employee who dropped off the run entirely) belongs to
 * `calculatePayRun`, which deletes the run's movements alongside its stubs.
 */
export async function recordEntitlementMovements(
  executor: Executor,
  input: {
    orgId: string;
    actorId: string | null;
    payRunDocumentId: string | null;
    /** Employees whose run-sourced movements this call replaces. */
    employeePartyIds?: readonly string[];
    movements: readonly EntitlementMovement[];
    /** Stub line ids by plan+kind, when the run materialized them as lines. */
    stubLineIds?: ReadonlyMap<string, string>;
  },
): Promise<number> {
  const { orgId, actorId, payRunDocumentId } = input;
  if (payRunDocumentId) {
    const employeePartyIds = [
      ...new Set([
        ...(input.employeePartyIds ?? []),
        ...input.movements.map((movement) => movement.employeePartyId),
      ]),
    ];
    if (employeePartyIds.length === 0) {
      throw new PayrollError(
        "recordEntitlementMovements needs the employees whose run movements it replaces "
        + "— a run-wide delete would drop every other employee's ledger rows",
      );
    }
    await executor.execute(sql`
      delete from entitlement_ledger
       where org_id = ${orgId} and pay_run_document_id = ${payRunDocumentId}
         and employee_party_id = any(${`{${employeePartyIds.join(",")}}`}::uuid[])
    `);
  }
  for (const movement of input.movements) {
    const stubLineId = input.stubLineIds?.get(`${movement.planId}:${movement.kind}`) ?? null;
    await executor.execute(sql`
      insert into entitlement_ledger (org_id, plan_id, employee_party_id, movement_date, amount,
                                      hours, kind, pay_run_document_id, stub_line_id, note,
                                      created_by, updated_by)
      values (${orgId}, ${movement.planId}, ${movement.employeePartyId}, ${movement.movementDate},
              ${movement.amount}, ${movement.hours}, ${movement.kind}, ${payRunDocumentId},
              ${stubLineId}, ${movement.note}, ${actorId}, ${actorId})
    `);
  }
  return input.movements.length;
}
