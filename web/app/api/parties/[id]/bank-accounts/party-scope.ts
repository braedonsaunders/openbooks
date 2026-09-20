import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardSubsidiaryScope, type Authz } from '../../../../../lib/authz'

/** Party record boundary shared by every bank-account verb here (null-subsidiary parties are org-wide). */
export async function denyOutsidePartyScope(gate: Authz, partyId: string): Promise<NextResponse | null> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${partyId} and org_id = ${gate.user.orgId}`,
  ))
  if (!row.rows[0]) return NextResponse.json({ error: 'party not found' }, { status: 404 })
  return guardSubsidiaryScope(gate, row.rows[0].subsidiaryId, { orgWideNull: true })
}
