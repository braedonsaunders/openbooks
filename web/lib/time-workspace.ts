import 'server-only'
import { NextResponse } from 'next/server'
import { guardFeaturePermission } from './feature-gates'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { can, guardPermission, type Authz } from './authz'
import { grantsConferring } from './permissions'
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
 * Every grant that opens a time command, in resolution order: the
 * supervisory grants over everyone's weeks, then the own-scope grants
 * declared in PERMISSION_IMPLICATIONS (time.self reads and enters, time.clock
 * reads). An own-scope caller is then confined to the person linked to
 * their own login by the shared time authority every command locks its week
 * through (lockSharedTimeAuthority), which refuses anyone else's week by name.
 */
export function timeCommandGrants(permission: TimeCommandPermission): { all: string[]; own: string[] } {
  return { all: grantsConferring(permission, 'all'), own: grantsConferring(permission, 'own') }
}

/** True when the caller may run this time command over everyone's weeks. */
export function supervisesTime(authz: Authz, permission: TimeCommandPermission): boolean {
  return timeCommandGrants(permission).all.some((grant) => can(authz, grant))
}

/** True when the caller may run this time command over their own weeks only. */
export function ownTimeOnly(authz: Authz, permission: TimeCommandPermission): boolean {
  return !supervisesTime(authz, permission) && timeCommandGrants(permission).own.some((grant) => can(authz, grant))
}

/** Both workspaces use the same entries and lifecycle. Native commands separately fence every actual cost target. */
export function authorizeTimeWorkspace(permission: TimeCommandPermission) {
  return async ({ request }: { request: Request }) => {
    const family = timeWorkFamily(request)
    const feature = family === 'production' ? 'manufacturing' : 'timeTracking'
    let gate = await guardFeaturePermission(permission, feature)
    const { all, own } = timeCommandGrants(permission)
    for (const grant of [...all, ...own]) {
      if (!(gate instanceof NextResponse) || gate.status !== 403 || grant === permission) continue
      const alternative = await guardFeaturePermission(grant, feature)
      if (!(alternative instanceof NextResponse)) gate = alternative
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
 * own linked person.
 */
export async function refuseOthersTime(authz: Authz, permission: TimeCommandPermission, employeeId: string): Promise<NextResponse | null> {
  if (supervisesTime(authz, permission)) return null
  const own = (await db.execute<{ partyId: string | null }>(sql`
    select party_id as "partyId" from users where id = ${authz.user.id} and org_id = ${authz.user.orgId}`)).rows[0]?.partyId ?? null
  if (own !== null && own === employeeId) return null
  const refusal = selfServiceTimeRefusal()
  return NextResponse.json({ error: refusal.message, code: refusal.code, remedy: refusal.remedy }, { status: refusal.status })
}

