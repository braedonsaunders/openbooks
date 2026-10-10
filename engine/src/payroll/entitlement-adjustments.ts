import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";

export interface EntitlementAdjustment {
  readonly id: string;
  readonly planId: string;
  readonly employeePartyId: string;
  readonly movementDate: string;
  readonly amount: string | null;
  readonly hours: string | null;
}

/**
 * Correct an employee's entitlement balance (vacation, banked time) with a
 * dated, audited adjustment. Committed payroll movements stay untouched; the
 * adjustment records why the balance differs from what payroll carried.
 * Money plans take an amount and hour plans take hours, never both.
 */
export async function recordEntitlementAdjustment(input: {
  orgId: string; actorId: string; planId: string; employeePartyId: string;
  movementDate: string; amount?: string | null; hours?: string | null; reason: string;
}): Promise<EntitlementAdjustment> {
  const reason = input.reason.trim();
  if (!reason) throw new PayrollError("Record why this entitlement balance is being adjusted.");
  if (!isIsoCalendarDate(input.movementDate)) throw new PayrollError("Enter the adjustment date as a real calendar date (YYYY-MM-DD).");
  return withOrgTransaction(input.orgId, async () => {
    if (!(await actorHasPermission(db, input.orgId, input.actorId, "payroll.manage"))) {
      throw new PayrollError("Adjusting entitlement balances needs the payroll.manage permission.");
    }
    const plan = (await db.execute<{ unit: string; isActive: boolean }>(sql`
      select unit, is_active as "isActive" from entitlement_plans where org_id=${input.orgId} and id=${input.planId}`)).rows[0];
    if (!plan) throw new PayrollError("The entitlement plan was not found in this organization.");
    if (!plan.isActive) throw new PayrollError("The entitlement plan is inactive; activate it before adjusting balances.");
    const value = plan.unit === "money" ? input.amount : input.hours;
    const other = plan.unit === "money" ? input.hours : input.amount;
    if (value == null || other != null) {
      throw new PayrollError(plan.unit === "money"
        ? "Adjust a money plan with an amount only."
        : "Adjust an hours plan with hours only.");
    }
    const normalized = normalizeMoney(value);
    if (cmp(normalized, "0") === 0) throw new PayrollError("An entitlement adjustment must change the balance.");
    const employment = (await db.execute<{ id: string }>(sql`
      select w.id from worker_employments w
        join worker_employment_versions v on v.org_id=w.org_id and v.employment_id=w.id and v.recorded_until is null
       where w.org_id=${input.orgId} and w.worker_party_id=${input.employeePartyId}
         and v.effective_from<=${input.movementDate}::date and (v.effective_to is null or v.effective_to>${input.movementDate}::date)
       limit 1`)).rows[0];
    if (!employment) throw new PayrollError("The employee has no employment on the adjustment date; date the adjustment within their employment.");
    const inserted = (await db.execute<EntitlementAdjustment>(sql`
      insert into entitlement_ledger (org_id, plan_id, employee_party_id, employment_id, movement_date, amount, hours, kind, note, created_by, updated_by)
      values (${input.orgId}, ${input.planId}, ${input.employeePartyId}, ${employment.id}, ${input.movementDate}::date,
              ${plan.unit === "money" ? normalized : null}, ${plan.unit === "money" ? null : normalized}, 'adjustment', ${reason}, ${input.actorId}, ${input.actorId})
      returning id, plan_id as "planId", employee_party_id as "employeePartyId", movement_date::text as "movementDate", amount::text as amount, hours::text as hours`)).rows;
    if (inserted.length !== 1) throw new PayrollError("The entitlement adjustment was not saved; nothing changed.");
    const audited = (await db.execute<{ id: string }>(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'entitlement_ledger', ${inserted[0]!.id}, 'insert', ${JSON.stringify({ before: null, after: inserted[0], reason })}::jsonb, ${input.actorId}) returning id`)).rows;
    if (audited.length !== 1) throw new PayrollError("The entitlement adjustment could not be audited; nothing changed.");
    return inserted[0]!;
  });
}
