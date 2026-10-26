import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { PayrollError } from "./error.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";

class PayrollProfileEmploymentError extends PayrollError {
  readonly status = 422;
}

/**
 * The legal employer a payroll profile answers to. A recorded party
 * subsidiary stands; a NULL one (native Hire mints the party without it)
 * resolves from the employments' own employer subsidiary — the employment
 * record names its legal employer, so there is nothing to default. Zero
 * employments resolve to nothing (HRM is not complete); employments under
 * different subsidiaries are ambiguous and refuse BY NAME with the remedy,
 * never a guessed employer.
 */
export async function resolveProfileLegalEmployer(
  exec: SqlExecutor,
  orgId: string,
  employeePartyId: string,
  employerId: string | null,
): Promise<string | null> {
  if (employerId !== null) return employerId;
  const subsidiaries = (
    await exec.execute<{ employer_subsidiary_id: string }>(
      sql`
    select distinct employer_subsidiary_id from worker_employments
    where org_id=${orgId} and worker_party_id=${employeePartyId}`,
      "objects",
    )
  ).map((row) => row.employer_subsidiary_id);
  if (subsidiaries.length === 0) return null;
  if (subsidiaries.length === 1) return subsidiaries[0]!;
  throw new PayrollProfileEmploymentError(
    "This employee has employments under more than one legal employer and no legal employer recorded — choose the employment episode through the Payroll employment links import before saving payroll settings",
  );
}

/** Validate the stable employment identity; effective coverage remains a dated HRM policy. */
export async function payrollProfileEmployment(
  exec: SqlExecutor,
  orgId: string,
  employeePartyId: string,
  employerId: string | null,
  linkedId: string | null,
): Promise<string | null> {
  const resolvedEmployerId = await resolveProfileLegalEmployer(
    exec,
    orgId,
    employeePartyId,
    employerId,
  );
  const rows = await exec.execute<{ id: string; employer_subsidiary_id: string }>(
    sql`
    select id, employer_subsidiary_id from worker_employments
    where org_id=${orgId} and worker_party_id=${employeePartyId}
    order by id for share`,
    "objects",
  );
  if (linkedId !== null) {
    const linked = rows.find((row) => row.id === linkedId);
    if (!linked || linked.employer_subsidiary_id !== resolvedEmployerId) {
      throw new PayrollProfileEmploymentError(
        "The payroll employment does not belong to this employee and legal employer — review the employee employment record before saving payroll settings",
      );
    }
    return linkedId;
  }
  // An unlinked profile can be configured before HRM is complete, but cannot calculate.
  // Several employment episodes require an explicit choice through the link import.
  return rows.length === 1 && rows[0]!.employer_subsidiary_id === resolvedEmployerId
    ? rows[0]!.id
    : null;
}

export interface EmploymentLinkResolution {
  employeePartyId: string;
  employeeName: string;
  employmentId: string | null;
  linked: boolean;
  reason: string | null;
}

/**
 * Link every unlinked payroll profile that has exactly one ACTIVE
 * employment (a current version in an active or on-leave status), audited
 * per profile. This is the pay-run readiness Resolve action: native Hire
 * predates it, so hired employees whose profiles were created unlinked get
 * their unambiguous link in one click. Anything else is refused BY NAME —
 * no employment on file, no effective version yet, an ended employment, or
 * several employments to choose between — for the link import, never a
 * guessed episode. Posted payroll history never moves: only NULL links are
 * filled.
 */
export async function resolvePayrollProfileEmploymentLinks(input: {
  orgId: string;
  actorId: string;
  employeePartyIds?: readonly string[];
  reason: string;
  dryRun: boolean;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<{ linked: EmploymentLinkResolution[]; unresolved: EmploymentLinkResolution[] }> {
  const reason = input.reason.trim();
  if (!reason || reason.length > 500)
    throw new PayrollProfileEmploymentError(
      "Provide a reason or source reference of 1–500 characters for the employment links",
    );
  if (typeof input.dryRun !== "boolean")
    throw new PayrollProfileEmploymentError(
      "Specify whether the employment links are a preview or an apply",
    );
  return withOrgTransaction(input.orgId, async () => {
    if (!(await actorHasPermission(db, input.orgId, input.actorId, "payroll.manage")))
      throw new PayrollProfileEmploymentError(
        "Payroll manage permission is required to link employments",
      );
    if (!(await lockAndCheckOrgFeature(db, input.orgId, "payroll")))
      throw new PayrollProfileEmploymentError(
        "Enable Payroll in Company Settings → Features before linking employments",
      );
    const candidates = await db.execute<{
      profile_id: string;
      employee_party_id: string;
      employee_name: string;
    }>(
      sql`
      select prof.id as profile_id, prof.employee_party_id, p.display_name as employee_name
        from employee_payroll_profiles prof
        join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
       where prof.org_id = ${input.orgId} and prof.employment_id is null
         ${
           input.employeePartyIds?.length
             ? sql`and prof.employee_party_id in (${sql.join(
                 input.employeePartyIds.map((id) => sql`${id}`),
                 sql`, `,
               )})`
             : sql``
         }
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
       order by p.display_name for update`,
      "objects",
    );
    const linked: EmploymentLinkResolution[] = [];
    const unresolved: EmploymentLinkResolution[] = [];
    for (const candidate of candidates) {
      const employments = await db.execute<{ id: string; status: string | null }>(
        sql`
        select e.id, v.status
          from worker_employments e
          left join worker_employment_versions v
            on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
         where e.org_id = ${input.orgId} and e.worker_party_id = ${candidate.employee_party_id}
         order by e.id for share of e`,
        "objects",
      );
      const active = employments.filter(
        (row) => row.status === "active" || row.status === "on_leave",
      );
      if (employments.length === 0) {
        unresolved.push({
          employeePartyId: candidate.employee_party_id,
          employeeName: candidate.employee_name,
          employmentId: null,
          linked: false,
          reason: "no employment on file — complete the hire first",
        });
        continue;
      }
      if (active.length !== 1 || employments.length !== 1) {
        const why =
          employments.length !== 1
            ? "several employments on file — choose the episode through the Payroll employment links import"
            : "the single employment is not effective — hire, rehire or leave dates decide the episode, then link it through the import";
        unresolved.push({
          employeePartyId: candidate.employee_party_id,
          employeeName: candidate.employee_name,
          employmentId: null,
          linked: false,
          reason: why,
        });
        continue;
      }
      const employmentId = active[0]!.id;
      if (!input.dryRun) {
        const updated = await db.execute(
          sql`update employee_payroll_profiles
          set employment_id=${employmentId}, updated_by=${input.actorId},
            updated_at=greatest(clock_timestamp(), updated_at + interval '1 microsecond')
          where org_id=${input.orgId} and id=${candidate.profile_id} and employment_id is null returning id`,
          "objects",
        );
        if (updated.length !== 1)
          throw new PayrollProfileEmploymentError(
            `The payroll employment link for ${candidate.employee_name} changed — preview the links again`,
          );
        await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
          values (${input.orgId},'employee_payroll_profiles',${candidate.profile_id},'update',
            ${JSON.stringify({ before: { employmentId: null }, after: { employmentId }, employeePartyId: candidate.employee_party_id, reason })}::jsonb,${input.actorId})`);
      }
      linked.push({
        employeePartyId: candidate.employee_party_id,
        employeeName: candidate.employee_name,
        employmentId,
        linked: true,
        reason: null,
      });
    }
    return { linked, unresolved };
  });
}

/** Fill an explicitly reviewed missing profile link without moving posted payroll history. */
export async function linkPayrollProfileEmployment(input: {
  orgId: string;
  actorId: string;
  employeePartyId: string;
  employmentId: string;
  reason: string;
  dryRun: boolean;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<{ changed: boolean }> {
  if (
    ![input.employeePartyId, input.employmentId].every((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    )
  ) {
    throw new PayrollProfileEmploymentError(
      "Use the employee ID and employment ID exported from the native employee records",
    );
  }
  const reason = input.reason.trim();
  if (!reason || reason.length > 500)
    throw new PayrollProfileEmploymentError(
      "Provide a reason or source reference of 1–500 characters for the employment link",
    );
  if (typeof input.dryRun !== "boolean")
    throw new PayrollProfileEmploymentError(
      "Specify whether the employment link is a preview or an apply",
    );
  return withOrgTransaction(input.orgId, async () => {
    if (!(await actorHasPermission(db, input.orgId, input.actorId, "payroll.manage")))
      throw new PayrollProfileEmploymentError(
        "Payroll manage permission is required to link an employment",
      );
    if (!(await lockAndCheckOrgFeature(db, input.orgId, "payroll")))
      throw new PayrollProfileEmploymentError(
        "Enable Payroll in Company Settings → Features before linking employments",
      );
    const employee = (
      await db.execute<{ subsidiary_id: string | null }>(
        sql`
      select p.subsidiary_id from parties p where p.org_id=${input.orgId} and p.id=${input.employeePartyId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
      for no key update`,
        "objects",
      )
    )[0];
    if (!employee)
      throw new PayrollProfileEmploymentError(
        "The employee is not available in your legal entity — review the employee ID",
      );
    const before = (
      await db.execute<{ id: string; employment_id: string | null }>(
        sql`
      select id, employment_id from employee_payroll_profiles
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} for update`,
        "objects",
      )
    )[0];
    if (!before)
      throw new PayrollProfileEmploymentError(
        "No payroll profile is available for this employee in your legal entity — create the payroll profile from Employees first",
      );
    await payrollProfileEmployment(
      db,
      input.orgId,
      input.employeePartyId,
      employee.subsidiary_id,
      input.employmentId,
    );
    if (before.employment_id !== null && before.employment_id !== input.employmentId) {
      throw new PayrollProfileEmploymentError(
        "This payroll profile is already linked to a different employment — review its payroll and employment history; this import only fills missing links",
      );
    }
    if (before.employment_id === input.employmentId) return { changed: false };
    if (input.dryRun) return { changed: true };
    const updated = await db.execute(
      sql`update employee_payroll_profiles
      set employment_id=${input.employmentId}, updated_by=${input.actorId},
        updated_at=greatest(clock_timestamp(), updated_at + interval '1 microsecond')
      where org_id=${input.orgId} and id=${before.id} and employment_id is null returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new PayrollProfileEmploymentError(
        "The payroll employment link changed — preview the import again",
      );
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values (${input.orgId},'employee_payroll_profiles',${before.id},'update',
        ${JSON.stringify({ before: { employmentId: null }, after: { employmentId: input.employmentId }, employeePartyId: input.employeePartyId, reason })}::jsonb,${input.actorId})`);
    return { changed: true };
  });
}
