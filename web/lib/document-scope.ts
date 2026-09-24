import 'server-only'

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardSubsidiaryScope, type Authz } from './authz'

/**
 * Locked subsidiary recheck for document write routes (actions, PATCH,
 * DELETE, void, correct).
 *
 * The route's precheck reads the document's subsidiary, then the engine
 * locks the row and acts — a rehome that commits between the two hands a
 * caller another subsidiary's document. This re-reads the subsidiary UNDER
 * ROW LOCK and re-applies the direct-record scope gate, so it must run
 * inside the caller's tenant transaction (withOrgTransaction) ahead of the
 * engine call: same connection, same snapshot, no window. A concurrently
 * deleted row answers as missing. Denials are the uniform 404, never an
 * oracle.
 */
export async function lockedDocumentScopeDenied(
  authz: Authz,
  id: string,
): Promise<NextResponse | null> {
  const relocked = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from documents
     where id = ${id} and org_id = ${authz.user.orgId} for update
  `))
  const row = relocked.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return guardSubsidiaryScope(authz, row.subsidiaryId)
}
