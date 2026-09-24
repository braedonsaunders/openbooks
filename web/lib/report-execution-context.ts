import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { getAuthz, resolveUserAuthz, can, type Authz } from './authz'
import { canRunReportEntity, canRunReportStatement, reportEntityPermission } from './report-authz'
import type { SessionUser } from './auth'

const execution = new AsyncLocalStorage<Authz>()
export const withReportAuthz = <T>(authz: Authz, action: () => T): T => execution.run(authz, action)

/** Every web report execution requires a verified request or durable principal. */
export async function requireReportAuthz(orgId: string): Promise<Authz> {
  const authz = execution.getStore() ?? await getAuthz()
  if (!authz || authz.user.orgId !== orgId || !can(authz, 'reports.read')) {
    throw new Error('Report access denied')
  }
  return authz
}

export type ReportAuthorization = {
  version: 1
  userId: string
  allowedSubsidiaryIds: string[] | null
  /** Extra permissions the RENDERED content required beyond the definition
   * gate — e.g. payroll.read for a journal/GL artifact bearing pay-run
   * lines, whose kind is gated by the reports feature only. Recorded at
   * render time; downloads refuse viewers who lack them (by name) instead
   * of re-rendering per viewer. Absent on artifacts rendered before the
   * field existed: those keep the definition-level gate only. */
  requiredPermissions?: string[]
  definition: {
    report_type: 'query' | 'statement'
    query: unknown
    statement: { kind?: string; params?: Record<string, string> } | null
    name: string
    slug: string
    kind: string
  }
}

export function snapshotReportAuthorization(authz: Authz, definition: ReportAuthorization['definition']): ReportAuthorization {
  // Query definitions name their entity permission up front (a payroll
  // register snapshot carries payroll.read from creation). Statement content
  // is data-dependent, so the render stamps requiredPermissions later.
  const entityPermission = definition.report_type === 'query' ? reportEntityPermission(definition.query) : null
  return { version: 1, userId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds].sort(),
    ...(entityPermission ? { requiredPermissions: [entityPermission] } : {}),
    definition }
}

export async function canAccessReportDefinition(authz: Authz, def: ReportAuthorization['definition']): Promise<boolean> {
  return can(authz, 'reports.read') && (def.report_type === 'statement'
    ? Boolean(def.statement?.kind) && await canRunReportStatement(authz, def.statement?.kind)
    : Boolean(def.query) && await canRunReportEntity(authz, def.query))
}

/** Historical output requires the original data permissions and the entire
 * original scope. A narrower reader cannot safely consume unfiltered bytes. */
export type ReportArtifactAccess = { ok: true; missingPermissions: [] } | { ok: false; missingPermissions: string[] }

export async function reportArtifactAccessDetail(authz: Authz, raw: unknown): Promise<ReportArtifactAccess> {
  if (!raw || typeof raw !== 'object') return { ok: false, missingPermissions: [] }
  const snapshot = raw as ReportAuthorization
  if (snapshot.version !== 1 || !snapshot.definition ||
      !(snapshot.allowedSubsidiaryIds === null || Array.isArray(snapshot.allowedSubsidiaryIds))) return { ok: false, missingPermissions: [] }
  if (authz.allowedSubsidiaryIds !== null && (snapshot.allowedSubsidiaryIds === null ||
      !snapshot.allowedSubsidiaryIds.every((id) => authz.allowedSubsidiaryIds!.has(id)))) return { ok: false, missingPermissions: [] }
  if (!(await canAccessReportDefinition(authz, snapshot.definition))) return { ok: false, missingPermissions: [] }
  // Render-time content permissions: a malformed record fails closed with no
  // names to give; an absent one predates recording (definition gate only).
  if (snapshot.requiredPermissions === undefined) return { ok: true, missingPermissions: [] }
  if (!Array.isArray(snapshot.requiredPermissions) ||
      !snapshot.requiredPermissions.every((p) => typeof p === 'string')) return { ok: false, missingPermissions: [] }
  const missing = snapshot.requiredPermissions.filter((p) => !can(authz, p))
  if (missing.length > 0) return { ok: false, missingPermissions: missing }
  return { ok: true, missingPermissions: [] }
}

export async function canAccessReportArtifact(authz: Authz, raw: unknown): Promise<boolean> {
  return (await reportArtifactAccessDetail(authz, raw)).ok
}

/** Re-resolve active membership and grants at execution, never trust a saved
 * permission set. Deactivation/revocation fails the run; grants cannot widen it. */
export async function scheduledReportAuthz(orgId: string, snapshot: ReportAuthorization): Promise<Authz> {
  if (snapshot?.version !== 1 || !snapshot.userId) throw new Error('Report schedule requires reauthorization')
  const row = await withBypassContext(async () => (await db.execute<{
    id: string; email: string; name: string; org_id: string; is_super_admin: boolean
  }>(sql`
    select u.id, u.email, u.name, u.org_id, u.is_super_admin from users u
     where u.id = ${snapshot.userId} and u.is_active
       and (u.org_id = ${orgId} or u.is_super_admin or exists (
         select 1 from role_assignments a where a.user_id = u.id and a.org_id = ${orgId}
       ))
  `)).rows[0])
  if (!row) throw new Error('Report execution principal is inactive or unavailable')
  const user: SessionUser = { ...row, orgId, roles: [], envKind: 'production', productionOrgId: orgId,
    homeUserId: row.id, homeOrgId: row.org_id, isSuperAdmin: row.is_super_admin }
  const current = await resolveUserAuthz(user)
  if (!can(current, 'reports.schedule') || !(await canAccessReportArtifact(current, snapshot))) {
    throw new Error('Report execution permission was revoked')
  }
  return { ...current, allowedSubsidiaryIds: snapshot.allowedSubsidiaryIds === null
    ? null : new Set(snapshot.allowedSubsidiaryIds) }
}
