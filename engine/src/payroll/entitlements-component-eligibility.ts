import { sql } from 'drizzle-orm';
import { db } from '../platform/db.ts';
import { isIsoCalendarDate } from '../platform/civil-date.ts';
import { PayrollError } from './error.ts';
import { lockPayrollServiceConfiguration, resolveEmploymentServiceCredit } from './service-credit.ts';
import { resolveServiceTiersFrom, type ServiceTierRow } from './entitlements-service-tiers.ts';

/** Requested components must satisfy the employment's effective service schedule. */
export async function assertComponentServiceEligibility(executor: Pick<typeof db, 'execute'>, args: {
  orgId: string; employmentId: string; policyDate: string; componentIds: readonly string[];
}): Promise<void> {
  if (!isIsoCalendarDate(args.policyDate)) throw new PayrollError('Select a valid pay-period end to resolve component service eligibility.');
  await lockPayrollServiceConfiguration(executor, args.orgId);
  const requested = [...new Set(args.componentIds)];
  const result = await executor.execute<Record<string, unknown>>(sql`
    select t.id,t.component_id,t.after_months,t.eligible,t.employer_subsidiary_id,
      e.employer_subsidiary_id as employment_employer,c.name,c.system_key
    from entitlement_service_tiers t join pay_components c on c.org_id=t.org_id and c.id=t.component_id
    join worker_employments e on e.org_id=t.org_id and e.id=${args.employmentId}
    where t.org_id=${args.orgId} and t.is_active and t.effective_from<=${args.policyDate}::date
      and (t.effective_to is null or t.effective_to>=${args.policyDate}::date)
      and (t.employer_subsidiary_id is null or t.employer_subsidiary_id=e.employer_subsidiary_id)
      and (c.system_key is not null or ${requested.length ? sql`c.id in (${sql.join(requested.map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`})
  `);
  const invalid = result.rows.find((row) => row.system_key != null);
  if (invalid) throw new PayrollError(`${String(invalid.name)} is an engine-owned payroll component and cannot have a service gate; remove its component service tier and configure service eligibility only for employer-defined components.`);
  if (result.rows.length === 0) return;
  const service = await resolveEmploymentServiceCredit(executor, { orgId: args.orgId, employmentId: args.employmentId, asOf: args.policyDate });
  if (!service) throw new PayrollError(`${String(result.rows[0]!.name)} requires documented service; record the employment's service start or credited-service baseline before requesting this component.`);
  const rows: ServiceTierRow[] = result.rows.map((row) => ({ id: String(row.id), planId: null,
    componentId: String(row.component_id), afterMonths: Number(row.after_months), accrualValue: null,
    eligible: row.eligible === true, isActive: true,
    employerSubsidiaryId: row.employer_subsidiary_id == null ? null : String(row.employer_subsidiary_id) }));
  const tiers = resolveServiceTiersFrom(rows, service.completedMonths, null, String(result.rows[0]!.employment_employer));
  for (const componentId of new Set(rows.map((row) => row.componentId!))) {
    if (tiers.componentEligibility.get(componentId) !== true) {
      const component = result.rows.find((row) => row.component_id === componentId)!;
      throw new PayrollError(`${String(component.name)} is not service-eligible at period end ${args.policyDate}; end the premature assignment or election, correct documented service if it is wrong, or request the component in an eligible pay period.`);
    }
  }
}
