import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { GateError } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, type Authz } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'

/** Session + Flows feature gate for /api/flows/* (pages already 404 when off). */
export async function requireFlowsSession(): Promise<Authz | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!(await isFeatureEnabled(authz.user.orgId, 'flows'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return authz
}

/** Shared helpers for the /api/flows/* gate endpoints. */

export type GateHeader = {
  id: string
  org_id: string
  status: string
  assignee_user_id: string | null
  assignee_role: string | null
  /** Legal entity owning the approval subject (null = unavailable/rootless). */
  subsidiary_id: string | null
};

/** Load a gate header scoped to the caller's org (null = not found for them). */
export async function loadGateHeader(gateId: string, orgId: string): Promise<GateHeader | null> {
  const r = (await db.execute<GateHeader>(sql`
    select g.id, g.org_id, g.status, g.assignee_user_id, g.assignee_role,
           case
             when g.subject_kind = 'party_bank_account' then (
               select p.subsidiary_id
                 from party_bank_accounts ba
                 join parties p on p.id = ba.party_id and p.org_id = ba.org_id
                where ba.id = g.subject_id and ba.org_id = g.org_id
             )
             when g.subject_kind = 'timesheet_week' then (
               select p.subsidiary_id
                 from timesheet_weeks tw
                 join parties p on p.id = tw.employee_party_id and p.org_id = tw.org_id
                where tw.id = g.subject_id and tw.org_id = g.org_id
             )
             else d.subsidiary_id
           end as subsidiary_id
      from flow_gates g
      left join documents d
        on d.id = g.subject_id and d.org_id = g.org_id and d.kind = g.subject_kind
     where g.id = ${gateId} and g.org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}

/**
 * Map an engine GateError onto an HTTP status. The engine throws one error
 * class with human-readable messages; the route pre-checks catch the common
 * cases (404 missing, 409 already decided) so this mapping only has to cover
 * races and authorization.
 */
export function gateErrorResponse(e: unknown): NextResponse {
  if (e instanceof GateError) {
    const msg = e.message
    const status = /not found/.test(msg)
      ? 404
      : /already resolved|only a pending/.test(msg)
        ? 409
        : /not an approver|only the assignee/.test(msg)
          ? 403
          : 422
    return NextResponse.json({ error: msg }, { status })
  }
  console.error('[flows] gate endpoint failed:', e)
  return NextResponse.json({ error: 'internal error' }, { status: 500 })
}
