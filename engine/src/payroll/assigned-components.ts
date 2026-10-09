import { assignmentAppliesToRun, type AssignmentRunApplicability } from './assignment-run-applicability.ts';
import { sql, type SQL } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

type Executor = Pick<typeof db, "execute">;

/**
 * Recurring per-employee pay-component assignments — the write side of the
 * rows `run-stub-compute.ts` prices every regular run (fixed deductions,
 * taxable benefits, employee premiums). The engine read path silently skips
 * statutory components and refuses duplicates delivered by a Benefits rule,
 * so this writer refuses both up front, naming the remedy, instead of
 * storing a row no run can observe.
 */

/** Same-employee serialization: concurrent saves cannot interleave windows. */
export function employeePayComponentScopeLock(orgId: string, employeePartyId: string): SQL {
  return sql`select pg_advisory_xact_lock(hashtextextended(
    ${orgId} || ':employee_pay_components:' || ${employeePartyId}, 0))`;
}

export interface EmployeePayComponentAssignmentInput {
  employeePartyId: string;
  /** Null = party-wide (every employment); otherwise one employment. */
  employmentId: string | null;
  componentId: string;
  /** Canonical decimal text, or null to price the component's own value. */
  value: string | null;
  runApplicability?: AssignmentRunApplicability;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Row being ended or deleted — excluded from the overlap read. */
  excludeId?: string | null;
}

export interface ValidatedAssignment {
  employeeName: string;
  componentCode: string;
  componentName: string;
  componentKind: string;
  componentBasis: string;
}

/**
 * Every refusal a stored assignment must survive: the employee and component
 * exist and can meet on a run, the window is ordered, no live window for the
 * same component overlaps (storage exclusion 0250 backstops the race), and no
 * Benefits rule already delivers this component to the employee. Pure reads —
 * the caller owns the write and its audit row in the same transaction.
 */
export async function validateEmployeePayComponentAssignment(
  exec: Executor,
  orgId: string,
  input: EmployeePayComponentAssignmentInput,
): Promise<ValidatedAssignment> {
  assignmentAppliesToRun(input.runApplicability ?? 'standard_runs', 'regular');
  const { employeePartyId, employmentId, componentId, effectiveFrom, effectiveTo } = input;
  const employee = (await exec.execute<{ display_name: string | null }>(sql`
    select display_name from parties where org_id = ${orgId} and id = ${employeePartyId}`)).rows[0];
  if (!employee) {
    throw new PayrollError("The employee for this pay-component assignment is not visible in this organization — reload the employee drawer and try again");
  }
  const employeeName = employee.display_name ?? employeePartyId;
  if (employmentId !== null) {
    const employment = (await exec.execute(sql`select id from worker_employments
      where org_id = ${orgId} and id = ${employmentId} and worker_party_id = ${employeePartyId}`)).rows[0];
    if (!employment) {
      throw new PayrollError(`${employeeName} holds no such employment in this organization — choose one of their employments or leave the assignment party-wide`);
    }
  }
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new PayrollError(`The assignment ends ${effectiveTo} before it starts ${effectiveFrom} — end the assignment on or after its start`);
  }
  const component = (await exec.execute<{ code: string; name: string; kind: string; basis: string; is_active: boolean; system_key: string | null; country: string | null }>(sql`
    select code, name, kind, basis, is_active, system_key, country
      from pay_components where org_id = ${orgId} and id = ${componentId}`)).rows[0];
  if (!component) {
    throw new PayrollError("The payroll component for this assignment is not visible in this organization — choose a component from Payroll setup");
  }
  if (!component.is_active) {
    throw new PayrollError(`Payroll component ${component.code} is inactive — re-enable it in Payroll setup before assigning it`);
  }
  if (component.system_key !== null) {
    throw new PayrollError(`Payroll component ${component.code} is statutory (${component.system_key}) — statutory amounts are always recomputed, so assign a user-defined component instead`);
  }
  if (input.runApplicability === 'regular_only') {
    const rateCard = (await exec.execute(sql`select id from pay_derived_rules
      where org_id=${orgId} and component_id=${componentId} and is_active and rate_mode='rate_card'
        and effective_from <= coalesce(${effectiveTo}::date, 'infinity'::date)
        and (effective_to is null or effective_to >= ${effectiveFrom}::date) limit 1`)).rows[0];
    if (rateCard) throw new PayrollError(`Payroll component ${component.code} prices operational facts through a rate-card rule — keep standard applicability for its rate assignment and configure operational earnings in the derived rule.`);
  }
  if (component.country !== null) {
    const profile = (await exec.execute<{ country: string | null }>(sql`
      select country from employee_payroll_profiles
       where org_id = ${orgId} and employee_party_id = ${employeePartyId} and is_active
         and (${employmentId}::uuid is null or employment_id = ${employmentId}::uuid)
       order by created_at desc limit 1`)).rows[0];
    if (profile?.country != null && profile.country !== component.country) {
      throw new PayrollError(`Payroll component ${component.code} belongs to the ${component.country} payroll while ${employeeName} pays under ${profile.country} — choose a component available to the employee payroll`);
    }
  }
  // The storage guard keys on coalesce(employment_id, employee_party_id), but
  // the run pays every row that matches — a party-wide row AND an
  // employment-scoped row for the same component would both land on one stub.
  // The write refuses unless both rows are employment-scoped and different.
  const overlap = (await exec.execute<{ effective_from: string; effective_to: string | null }>(sql`
    select effective_from::text as effective_from, effective_to::text as effective_to
      from employee_pay_components
     where org_id = ${orgId} and component_id = ${componentId} and is_active
       and employee_party_id = ${employeePartyId}
       and (employment_id is null or ${employmentId}::uuid is null or employment_id = ${employmentId}::uuid)
       and daterange(effective_from, effective_to, '[]') && daterange(${effectiveFrom}::date, ${effectiveTo}::date, '[]')
       and (${input.excludeId ?? null}::uuid is null or id <> ${input.excludeId ?? null}::uuid)
     limit 1`)).rows[0];
  if (overlap) {
    const window = `${overlap.effective_from} to ${overlap.effective_to ?? 'open'}`;
    throw new PayrollError(`${employeeName} already holds ${component.code} for ${window} — end that assignment before starting an overlapping one`);
  }
  const benefit = (await exec.execute<{ rule_key: string; code: string }>(sql`
    select r.rule_key, p.code
      from hrm_benefit_contribution_rules r
      join hrm_benefit_plans p on p.org_id = r.org_id and p.id = r.plan_id
      join hrm_benefit_enrollments e on e.org_id = r.org_id and e.plan_id = r.plan_id
      join worker_employments w on w.org_id = e.org_id and w.id = e.employment_id
     where r.org_id = ${orgId} and r.pay_component_id = ${componentId} and r.is_active
       and r.effective_from <= ${effectiveTo ?? '9999-12-31'}::date
       and (r.effective_to is null or r.effective_to >= ${effectiveFrom}::date)
       and w.worker_party_id = ${employeePartyId}
       and (${employmentId}::uuid is null or e.employment_id = ${employmentId}::uuid)
       and e.status in ('active', 'ended')
       and e.effective_from <= ${effectiveTo ?? '9999-12-31'}::date
       and (e.effective_to is null or e.effective_to >= ${effectiveFrom}::date)
     limit 1`)).rows[0];
  if (benefit) {
    throw new PayrollError(`Payroll component ${component.code} is already delivered to ${employeeName} by benefit rule ${benefit.rule_key} (plan ${benefit.code}) — keep the Benefits election as the contribution source instead of assigning a duplicate`);
  }
  return {
    employeeName,
    componentCode: component.code,
    componentName: component.name,
    componentKind: component.kind,
    componentBasis: component.basis,
  };
}
