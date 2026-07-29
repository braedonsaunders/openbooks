import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { requireProjectsFeature } from '../../../../../lib/projects-gate'
import { seedProjectTypes } from '@openbooks/engine/src/seed-project-types.ts'
import { isFeatureEnabled } from '../../../../../lib/features'
import { ProjectTypesWorkspace, type ProjectTypeRow } from './ProjectTypesWorkspace'

export const dynamic = 'force-dynamic'

export default async function ProjectTypesSetup() {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  await requireProjectsFeature(orgId)
  await seedProjectTypes(orgId, authz.user.id)

  const [typesRes, dimsRes, acctRes, fieldTicketsEnabled] = await Promise.all([
    db.execute(sql`
      select id, key, name, description, is_built_in as "isBuiltIn", is_active as "isActive",
             sort_order as "sortOrder", billing_method as "billingMethod",
             coalesce(version.financial_profile, project_types.financial_profile) as "financialProfile",
             version.effective_from::text as "financialProfileEffectiveFrom",
             invoicing_profile as "invoicingProfile", backup_profile as "backupProfile"
        from project_types
        left join lateral (
          select v.financial_profile, v.effective_from
            from project_financial_profile_versions v
           where v.org_id = project_types.org_id
             and v.project_type_id = project_types.id
             and v.effective_from <= current_date
             and (v.effective_to is null or v.effective_to >= current_date)
           order by v.effective_from desc
           limit 1
        ) version on true
       where project_types.org_id = ${orgId}
       order by sort_order, name`),
    db.execute(sql`select distinct dimension from account_groups where org_id = ${orgId} order by dimension`),
    db.execute(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and coalesce(is_summary,false) = false
         and type in ('income','income_other') order by number limit 500`),
    isFeatureEnabled(orgId, 'fieldTickets'),
  ])

  return (
    <ProjectTypesWorkspace
      types={(typesRes as unknown as { rows: ProjectTypeRow[] }).rows}
      dimensions={(dimsRes as unknown as { rows: { dimension: string }[] }).rows.map((r) => r.dimension)}
      incomeAccounts={(acctRes as unknown as { rows: { id: string; number: string; name: string }[] }).rows}
      fieldTicketsEnabled={fieldTicketsEnabled}
    />
  )
}
