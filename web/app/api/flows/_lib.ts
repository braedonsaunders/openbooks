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
};

/** Load a gate header scoped to the caller's org (null = not found for them). */
export async function loadGateHeader(gateId: string, orgId: string): Promise<GateHeader | null> {
  const r = (await db.execute<GateHeader>(sql`
    select id, org_id, status, assignee_user_id, assignee_role
      from flow_gates where id = ${gateId} and org_id = ${orgId}
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
