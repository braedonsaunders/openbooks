import { sql } from "drizzle-orm";
import { cmp, roundMoney } from "../money/money.ts";
import type { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

/** Signed hours describe a bank deposit, never negative worked time. */
export async function assertBankDepositAdjustment(
  executor: Pick<typeof db, "execute">,
  input: {
    orgId: string; componentId: string; amount: string; hours: string | null;
    terminationRun: boolean;
  },
): Promise<void> {
  if (input.hours === null || cmp(input.hours, "0") >= 0) return;
  const component = (await executor.execute<{
    code: string; kind: string; payment_kind: string; unit_of_measure: string | null; is_active: boolean;
  }>(sql`select code, kind, payment_kind, unit_of_measure, is_active from pay_components
    where org_id=${input.orgId} and id=${input.componentId} for share`)).rows[0];
  const name = component?.code ?? input.componentId;
  if (cmp(roundMoney(input.amount, 2), "0") >= 0 || !component?.is_active || component.kind !== "earning"
      || component.payment_kind !== "cash" || component.unit_of_measure === "quantity") {
    throw new PayrollError(`Payroll component ${name} cannot carry negative hours — enter non-negative worked hours; a bank deposit requires an active cash earning component and a negative cash amount`);
  }
  if (input.terminationRun) {
    throw new PayrollError(`Payroll component ${name} cannot deposit banked time on a termination run — record the deposit on an ordinary editable run before the final bank settlement`);
  }
  const plans = (await executor.execute<{
    code: string; unit: string; direction: string; deposit_component_id: string | null;
  }>(sql`select code, unit, direction, deposit_component_id::text from entitlement_plans
    where org_id=${input.orgId} and is_active
      and (payout_component_id=${input.componentId} or deposit_component_id=${input.componentId})
    order by code for share`)).rows;
  if (plans.length !== 1) {
    throw new PayrollError(plans.length === 0
      ? `Payroll component ${name} has negative hours but no active entitlement bank — configure its bank settlement component in Benefits programs, or enter non-negative worked hours`
      : `Payroll component ${name} settles multiple entitlement banks (${plans.map(plan => plan.code).join(", ")}) — assign distinct settlement components before entering a bank deposit`);
  }
  const plan = plans[0]!;
  if (plan.direction !== "accrue" || !["money", "hours"].includes(plan.unit)
      || plan.unit === "hours" && plan.deposit_component_id !== input.componentId) {
    throw new PayrollError(`Payroll component ${name} cannot deposit hours into entitlement bank ${plan.code} — use an accrued bank's deposit component; ordinary worked hours must be non-negative`);
  }
}
