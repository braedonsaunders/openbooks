import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../lib/authz'
import { featureDisableStatuses, isFeatureEnabled } from '../../../../../lib/features'
import { InvoicingSettingsWorkspace } from './InvoicingSettingsWorkspace'

export const dynamic = 'force-dynamic'

/**
 * Authoritative company policy for customer-invoice workflows. Project billing
 * is summarized here but remains governed by the Projects parent gate and the
 * project's effective type profile.
 */
export default async function InvoicingSettingsPage() {
  const authz = await requirePermission('admin.setup.manage')
  const orgId = authz.user.orgId
  const [subscriptionBillingEnabled, projectsEnabled, projectTypes, subscriptionCounts] = await Promise.all([
    isFeatureEnabled(orgId, 'subscriptionBilling'),
    isFeatureEnabled(orgId, 'projects'),
    db.execute(sql`
      select count(*) filter (where is_active)::int as active,
             count(*) filter (
               where is_active
                 and coalesce(invoicing_profile->>'billingProcedure', 'standard') = 'standard'
             )::int as standard,
             count(*) filter (
               where is_active
                 and coalesce(invoicing_profile->>'billingProcedure', 'standard') = 'application_for_payment'
             )::int as applications
        from project_types
       where org_id = ${orgId}`) as unknown as Promise<{
      rows: { active: number; standard: number; applications: number }[]
    }>,
    db.execute(sql`
      select count(*) filter (where status = 'active')::int as active,
             count(*) filter (where status = 'paused')::int as paused
        from subscriptions
       where org_id = ${orgId}`) as unknown as Promise<{
      rows: { active: number; paused: number }[]
    }>,
  ])
  const disableStatus = subscriptionBillingEnabled ? (await featureDisableStatuses(orgId, ['subscriptionBilling'])).subscriptionBilling : undefined
  const typeCounts = projectTypes.rows[0]
  const subscriptions = subscriptionCounts.rows[0]

  return (
    <InvoicingSettingsWorkspace
      subscriptionBillingEnabled={subscriptionBillingEnabled}
      subscriptionDisableStatus={disableStatus ?? { blocked: false, impacts: [] }}
      activeSubscriptions={Number(subscriptions?.active ?? 0)}
      pausedSubscriptions={Number(subscriptions?.paused ?? 0)}
      projectsEnabled={projectsEnabled}
      activeProjectTypes={Number(typeCounts?.active ?? 0)}
      standardProjectTypes={Number(typeCounts?.standard ?? 0)}
      applicationProjectTypes={Number(typeCounts?.applications ?? 0)}
    />
  )
}
