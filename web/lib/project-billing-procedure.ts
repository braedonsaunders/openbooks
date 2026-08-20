import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

export type ProjectBillingProcedure = 'standard' | 'application_for_payment'

/** Resolve the operational billing procedure from the project's active type. */
export async function projectBillingProcedure(orgId: string, projectId: string): Promise<ProjectBillingProcedure | null> {
  const result = (await db.execute<{ procedure: string }>(sql`
    select pt.invoicing_profile->>'billingProcedure' as procedure
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${projectId}
  `))
  if (!result.rows[0]) return null
  return result.rows[0].procedure === 'application_for_payment' ? 'application_for_payment' : 'standard'
}

export async function supportsApplicationsForPayment(orgId: string, projectId: string): Promise<boolean> {
  return (await projectBillingProcedure(orgId, projectId)) === 'application_for_payment'
}
