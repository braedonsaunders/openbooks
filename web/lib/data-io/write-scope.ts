import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { subsidiaryScopeAllows } from '../authz'

/**
 * Import-side subsidiary scope.
 *
 * `/api/data/export` binds the caller's role-derived subsidiary fence before
 * every read; `/api/data/import` used to bind nothing on the write side, so a
 * caller restricted to one legal entity could load payroll carry-ins, leases
 * or master records for another. A resource that enforces the fence in its
 * `write()` declares `scopedWrite: true` on its descriptor and calls these
 * helpers; the import route refuses restricted callers for every resource
 * that does not, so an unenforced write can never happen by omission.
 */
export type WriteScope = ReadonlySet<string> | null | undefined

/** The employee (party) rows a restricted importer may write against. */
export async function employeeWriteScopeError(
  orgId: string,
  employeePartyId: string,
  scope: WriteScope,
): Promise<string | null> {
  if (scope == null) return null
  const row = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where org_id = ${orgId} and id = ${employeePartyId}`)).rows[0]
  // An unresolved employee is indistinguishable from an out-of-scope one.
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiaryId)) {
    return "employee is outside the caller's subsidiary scope"
  }
  return null
}
