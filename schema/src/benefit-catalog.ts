import { sql } from 'drizzle-orm';
import { check, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { auditColumns, orgRef } from './helpers';

/** Identity only; native typed records remain authoritative for all program rules. */
export const benefitCatalog = pgTable('hrm_benefit_catalog', {
  id: uuid('id').primaryKey(), orgId: orgRef(),
  insuredPlanId: uuid('insured_plan_id'), employerProgramId: uuid('employer_program_id'), entitlementPlanId: uuid('entitlement_plan_id'),
  ...auditColumns,
}, t => [uniqueIndex('hrm_benefit_catalog_org_id_id').on(t.orgId,t.id),
  check('benefit_catalog_one_native',sql`num_nonnulls(${t.insuredPlanId},${t.employerProgramId},${t.entitlementPlanId})=1`),
  check('benefit_catalog_native_identity',sql`${t.id}=coalesce(${t.insuredPlanId},${t.employerProgramId},${t.entitlementPlanId})`)]);
