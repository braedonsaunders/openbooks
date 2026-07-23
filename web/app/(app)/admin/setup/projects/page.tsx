import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { seedProjectTypes } from '@openbooks/engine/src/seed-project-types.ts'
import { requirePermission } from '../../../../../lib/authz'
import { isFeatureEnabled } from '../../../../../lib/features'
import { ProjectsSettingsWorkspace } from './ProjectsSettingsWorkspace'

export const dynamic = 'force-dynamic'

/** Projects configuration hub. The authoritative module gate is centralized on
 * Company Settings → Features; this page is always reachable to show status. */
export default async function ProjectsSettingsPage() {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const [enabled, fieldTicketsEnabled] = await Promise.all([
    isFeatureEnabled(orgId, 'projects'),
    isFeatureEnabled(orgId, 'fieldTickets'),
  ])

  // Keep the built-in billing profiles complete for existing organizations.
  // The seed is idempotent and never overwrites tenant edits.
  if (enabled) await seedProjectTypes(orgId, authz.user.id)

  const [typeCounts, sovCount] = await Promise.all([
    db.execute(sql`
      select count(*)::int as total,
             count(*) filter (where is_active)::int as active
        from project_types where org_id = ${orgId}`) as unknown as Promise<{ rows: { total: number; active: number }[] }>,
    db.execute(sql`
      select count(*)::int as n from project_types
       where org_id = ${orgId} and is_active
         and coalesce(invoicing_profile->>'billingProcedure', 'standard') = 'application_for_payment'`) as unknown as Promise<{ rows: { n: number }[] }>,
  ])

  return (
    <ProjectsSettingsWorkspace
      enabled={enabled}
      typeCount={Number(typeCounts.rows[0]?.total ?? 0)}
      activeTypeCount={Number(typeCounts.rows[0]?.active ?? 0)}
      applicationTypeCount={Number(sovCount.rows[0]?.n ?? 0)}
      fieldTicketsEnabled={fieldTicketsEnabled}
    />
  )
}
