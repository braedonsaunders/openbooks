import 'server-only'
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from './feature-gates'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { can, guardPermission, type Authz } from './authz'
import { selfServiceTimeRefusal, type TimeCommandPermission, type TimeWorkFamily } from '@openbooks/engine/src/projects/time-work-target.ts'

export function timeWorkFamily(request: Request): TimeWorkFamily {
  const value = new URL(request.url).searchParams.get('workFamily')
  if (value !== null && value !== 'project' && value !== 'production') throw new InvalidTimeWorkspaceError()
  return value === 'production' ? 'production' : 'project'
}
class InvalidTimeWorkspaceError extends Error {
  readonly status = 422
  readonly code = 'invalid_time_workspace'
  constructor() { super('Choose the project or production time workspace.'); this.name = 'InvalidTimeWorkspaceError' }
}
/**
 * Reading and entering a week accept the self-service time.self grant in
 * place of the supervisory grant: the route opens, and the shared time
 * authority every command locks its week through (lockSharedTimeAuthority)
 * then confines a time.self caller to the employee linked to their own
 * login, refusing anyone else's week by name.
 */
const SELF_SERVICE_COMMANDS: ReadonlySet<TimeCommandPermission> = new Set(['time.read', 'time.manage'])

/** Both workspaces use the same entries and lifecycle. Native commands separately fence every actual cost target. */
export function authorizeTimeWorkspace(permission: TimeCommandPermission) {
  return async ({ request }: { request: Request }) => {
    const family = timeWorkFamily(request)
    const feature = family === 'production' ? 'manufacturing' : 'timeTracking'
    let gate = await guardFeaturePermission(permission, feature)
    if (gate instanceof NextResponse && gate.status === 403 && SELF_SERVICE_COMMANDS.has(permission)) {
      const self = await guardFeaturePermission('time.self', feature)
      if (!(self instanceof NextResponse)) gate = self
    }
    if (gate instanceof NextResponse || family !== 'production') return gate
    const production = await guardPermission('manufacturing.read')
    return production instanceof NextResponse ? production : gate
  }
}

/**
 * Early refusal for a self-service time caller naming someone else's week,
 * before any of that week is read. The shared time authority repeats the
 * check under lock; this answers first so no coworker data is touched.
 * Returns null when the caller holds the supervisory grant or names their
 * own linked employee.
 */
export async function refuseOthersTime(authz: Authz, permission: TimeCommandPermission, employeeId: string): Promise<NextResponse | null> {
  if (can(authz, permission)) return null
  const own = (await db.execute<{ partyId: string | null }>(sql`
    select party_id as "partyId" from users where id = ${authz.user.id} and org_id = ${authz.user.orgId}`)).rows[0]?.partyId ?? null
  if (own !== null && own === employeeId) return null
  const refusal = selfServiceTimeRefusal()
  return NextResponse.json({ error: refusal.message, code: refusal.code, remedy: refusal.remedy }, { status: refusal.status })
}

