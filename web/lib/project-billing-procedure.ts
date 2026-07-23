import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

export type ProjectBillingProcedure = 'standard' | 'application_for_payment'

/** Resolve the operational billing procedure from the project's active type.
 * Legacy profiles without the discriminator are standard. */
export async function projectBillingProcedure(orgId: string, projectId: string): Promise<ProjectBillingProcedure | null> {
  const result = (await db.execute(sql`
    select coalesce(pt.invoicing_profile->>'billingProcedure', 'standard') as procedure
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${projectId}
  `)) as unknown as { rows: { procedure: string }[] }
  if (!result.rows[0]) return null
  return result.rows[0].procedure === 'application_for_payment' ? 'application_for_payment' : 'standard'
}

/** Historical SOV records stay operable after migration even if their project
 * predates the explicit procedure discriminator. New SOV work requires the
 * project type to opt in. */
export async function supportsApplicationsForPayment(orgId: string, projectId: string): Promise<boolean> {
  if ((await projectBillingProcedure(orgId, projectId)) === 'application_for_payment') return true
  const legacy = (await db.execute(sql`
    select exists(select 1 from sov_lines where org_id = ${orgId} and project_id = ${projectId})
        or exists(select 1 from pay_applications where org_id = ${orgId} and project_id = ${projectId}) as supported
  `)) as unknown as { rows: { supported: boolean }[] }
  return Boolean(legacy.rows[0]?.supported)
}
