import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Organization policy for how time is captured and cleared for use.
 *
 * Whether hours need approving before they can be billed or paid is a business
 * decision, not a product one: a two-person shop where the owner enters and
 * uses their own time gains nothing from a submit/approve round trip, while a
 * contractor billing T&M needs the documented sign-off. Both are legitimate,
 * so this is configurable rather than assumed.
 *
 * Off means time is usable the moment it is saved, which is the conventional
 * shape of a "require approvals on time records" preference. It does NOT mean
 * approval is faked: nothing is stamped with an approver who did not approve.
 */
export interface TimePolicy {
  /** Hours pass through submit → approve before they may be billed or paid. */
  requireApproval: boolean
}

export const DEFAULT_TIME_POLICY: TimePolicy = { requireApproval: true }

export async function loadTimePolicy(orgId: string): Promise<TimePolicy> {
  const r = (await db.execute<{ require_approval: boolean }>(sql`
    select coalesce((settings->'timesheets'->>'requireApproval')::boolean, true) as require_approval
      from orgs where id = ${orgId}`))
  const row = r.rows[0]
  if (!row) return DEFAULT_TIME_POLICY
  return { requireApproval: row.require_approval !== false }
}

/**
 * The status a freshly saved entry takes.
 *
 * With approval required this is 'draft' and the entry is inert until someone
 * submits and approves it. Without, it is 'approved' — the org has said that
 * entering the hours IS the authorization, so the entry is immediately usable
 * and downstream code needs no special case for "approval is switched off".
 */
export function initialEntryStatus(policy: TimePolicy): 'draft' | 'approved' {
  return policy.requireApproval ? 'draft' : 'approved'
}
