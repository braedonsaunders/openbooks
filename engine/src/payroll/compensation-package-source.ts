import { sql, type SQL } from 'drizzle-orm';
import { COMPENSATION_PACKAGE_COMPONENT_SOURCE, type CompensationPackageComponentSource } from './compensation-package-components.ts';
import { lockCompensationPackageComponents } from './compensation-package-components.ts';
import { compensationPackageSchemaRefusal } from './compensation-package-error.ts';
import { ONE_OFF_RUN_TYPES } from './run-contracts.ts';
export { lockCompensationPackageComponents, type CompensationPackageComponentSource } from './compensation-package-components.ts';
import type { SqlExecutor } from '../platform/db.ts';
import type { CompensationPackageDefinition } from './compensation-package.ts';
import { lockCompensationPackageConfiguration } from './compensation-package-store.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';

export interface CompensationPackageAssignmentSource {
  assignmentId: string;
  packageId: string;
  packageCode: string;
  employmentId: string;
  employeePartyId: string;
  subsidiaryId: string;
  country: string;
  currency: string;
  currencyMinorUnits: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  inputs: Readonly<Record<string, string | boolean>>;
  versionId: string;
  versionEffectiveFrom: string;
  versionEffectiveTo: string | null;
  definition: CompensationPackageDefinition;
  definitionHash: string;
  components: CompensationPackageComponentSource[];
}

/** One statement resolves financial sources; the caller owns the surrounding native payroll transaction. */
async function assignmentSources(tx: SqlExecutor, orgId: string, predicate: SQL, lockComponents = false): Promise<CompensationPackageAssignmentSource[]> {
  if (await lockCompensationPackageConfiguration(tx, orgId) === null) return [];
  const sources = (await tx.execute<{ source: CompensationPackageAssignmentSource }>(sql`
    select jsonb_build_object(
      'assignmentId',a.id,'packageId',a.package_id,'packageCode',p.code,
      'employmentId',a.employment_id,'employeePartyId',a.employee_party_id,'subsidiaryId',a.subsidiary_id,
      'country',p.country,'currency',p.currency,'currencyMinorUnits',(select minor_units from currencies where code=p.currency),'effectiveFrom',a.effective_from::text,'effectiveTo',a.effective_to::text,
      'inputs',a.inputs,'versionId',v.id,'versionEffectiveFrom',v.effective_from::text,'versionEffectiveTo',v.effective_to::text,
      'definition',v.definition,'definitionHash',v.definition_hash,
      'components',coalesce((select jsonb_agg(${COMPENSATION_PACKAGE_COMPONENT_SOURCE} order by c.id)
        from pay_components c left join pay_component_earning_classifications ec on ec.org_id=c.org_id and ec.pay_component_id=c.id
        where c.org_id=a.org_id and c.id in (select (rule->>'componentId')::uuid from jsonb_array_elements(v.definition->'rules') rule)), '[]'::jsonb)
    ) as source
    from payroll_compensation_assignments a
    join payroll_compensation_packages p on p.org_id=a.org_id and p.id=a.package_id
    join payroll_compensation_versions v on v.org_id=a.org_id and v.package_id=a.package_id and v.id=a.version_id
    where a.org_id=${orgId} and a.status in ('active','ended') and v.status='approved' and (${predicate})
    order by a.employment_id,a.effective_from,a.id
  `)).rows.map(row => row.source);
  if (lockComponents && sources.length) {
    await lockCompensationPackageComponents(tx, orgId, sources);
    // READ COMMITTED can wait for an editor after the first statement. Re-read
    // under the acquired native fences so comparison uses the retained policy.
    return assignmentSources(tx, orgId, predicate);
  }
  return sources;
}

/** Retirement stops new configuration; approved employment terms continue to govern their covered dates. */
export async function compensationPackageEmploymentSource(tx: SqlExecutor, args: {
  orgId: string; employmentId: string; periodStart: string; periodEnd: string; allowedSubsidiaryIds?: PayrollSubsidiaryScope; lockComponents?: boolean;
}): Promise<CompensationPackageAssignmentSource[]> {
  try { return await assignmentSources(tx, args.orgId, sql`a.employment_id=${args.employmentId}
    and a.effective_from<=${args.periodEnd}::date and (a.effective_to is null or a.effective_to>=${args.periodStart}::date)
    ${payrollSubsidiaryScopeFilter(sql`a.subsidiary_id`, args.allowedSubsidiaryIds)}`, args.lockComponents);
  } catch (error) { throw compensationPackageSchemaRefusal(error) ?? error; }
}

/** Reproduce the calculated native employment population, including newly approved terms for those same employments. */
export async function compensationPackageRunSource(tx: SqlExecutor, orgId: string, documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope, lockComponents = false): Promise<CompensationPackageAssignmentSource[]> {
  try { return await assignmentSources(tx, orgId, sql`exists (
    select 1 from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
    join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id
    where r.org_id=a.org_id and r.document_id=${documentId} and s.employment_id=a.employment_id
      and s.employee_party_id=a.employee_party_id and d.subsidiary_id=a.subsidiary_id
      and r.run_type not in (${sql.join([...ONE_OFF_RUN_TYPES].map(type => sql`${type}`), sql`, `)})
      and a.effective_from<=r.period_end and (a.effective_to is null or a.effective_to>=r.period_start)
      ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  )`, lockComponents);
  } catch (error) { throw compensationPackageSchemaRefusal(error) ?? error; }
}
