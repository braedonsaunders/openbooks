/**
 * Row locks taken before a pay run's calculation evidence is read.
 *
 * Split from the source-shape module so each operation stays within the line bound.
 */
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/** Lock the dated group authority and policy rows before producing the source snapshot. */
export async function lockStatutoryTreatmentSources(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  await executor.execute(sql`
    select profile.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join employee_payroll_profiles profile
        on profile.org_id=stub.org_id and profile.employee_party_id=stub.employee_party_id
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
     order by profile.employee_party_id
     for share of profile
  `);
  await executor.execute(sql`
    select assignment.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join payroll_employee_employer_assignments assignment
        on assignment.org_id=stub.org_id and assignment.employee_party_id=stub.employee_party_id
       and assignment.assignment_kind='worker_comp'
       and run.pay_date between assignment.effective_from and assignment.effective_to
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
     order by assignment.id
     for share of assignment
  `);
  await executor.execute(sql`
    select role.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join employee_roles role on role.org_id=stub.org_id and role.party_id=stub.employee_party_id and role.is_active
      join worker_comp_groups worker_group
        on worker_group.org_id=role.org_id and worker_group.id=role.worker_comp_group_id and worker_group.is_active
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       and not exists (
         select 1 from payroll_employee_employer_assignments assignment
          where assignment.org_id=stub.org_id and assignment.employee_party_id=stub.employee_party_id
            and assignment.assignment_kind='worker_comp'
            and run.pay_date between assignment.effective_from and assignment.effective_to
       )
     order by role.id
     for share of role, worker_group
  `);
  await executor.execute(sql`
    select component.id
      from pay_runs run
      join documents d on d.org_id=run.org_id and d.id=run.document_id
      join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
      join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
      join pay_components component on component.org_id=line.org_id and component.id=line.component_id
     where run.org_id=${orgId} and run.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       and line.kind='earning' and line.component_id is not null
     order by component.id
     for share of component
  `);
  await executor.execute(sql`
    select treatment.id
      from pay_component_statutory_treatments treatment
     where treatment.org_id=${orgId}
       and exists (
         select 1
           from pay_runs run
           join documents d on d.org_id=run.org_id and d.id=run.document_id
           join pay_stubs stub on stub.org_id=run.org_id and stub.pay_run_document_id=run.document_id
           join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
          where run.org_id=${orgId} and run.document_id=${documentId}
            ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
            and line.kind='earning' and line.component_id is not null
            and treatment.pay_component_id=line.component_id
            and treatment.effective_from<=run.pay_date
            and (treatment.effective_to is null or treatment.effective_to>=run.pay_date)
            and (treatment.worker_comp_group_id is null
              or treatment.worker_comp_group_id is not distinct from
                 public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, run.pay_date))
            and treatment.id=(
              select selected.id
                from pay_component_statutory_treatments selected
               where selected.org_id=line.org_id and selected.pay_component_id=line.component_id
                 and selected.effective_from<=run.pay_date
                 and (selected.effective_to is null or selected.effective_to>=run.pay_date)
                 and (selected.worker_comp_group_id is null
                   or selected.worker_comp_group_id is not distinct from
                     public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, run.pay_date))
               order by (selected.worker_comp_group_id is not null) desc,
                 selected.effective_from desc, selected.id
               limit 1
            )
       )
     order by treatment.id
     for share of treatment
  `);
}
