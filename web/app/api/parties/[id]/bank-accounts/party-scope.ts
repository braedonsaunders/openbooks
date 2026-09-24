import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { guardSubsidiaryScope, type Authz } from '../../../../../lib/authz'

/** Party record boundary shared by every bank-account verb here (null-subsidiary parties are org-wide). */
export async function denyOutsidePartyScope(gate: Authz, partyId: string): Promise<NextResponse | null> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${partyId} and org_id = ${gate.user.orgId}`,
  ))
  if (!row.rows[0]) return NextResponse.json({ error: 'party not found' }, { status: 404 })
  return guardSubsidiaryScope(gate, row.rows[0].subsidiaryId, { orgWideNull: true })
}

/**
 * Locked recheck for the bank-account write transactions. The unlocked
 * precheck above can authorize party A while a concurrent A→B rehome lands
 * before the write commits; this runs under the party row lock inside the
 * write transaction, so the scope verdict sees the latest committed
 * subsidiary and the rehome blocks until the write commits. Answers exactly
 * like a missing party, matching the precheck.
 */
export async function denyLockedOutsidePartyScope(
  tx: SqlExecutor,
  gate: Authz,
  partyId: string,
): Promise<NextResponse | null> {
  const row = (await tx.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties
         where id = ${partyId} and org_id = ${gate.user.orgId}
           ${subsidiaryVisibleFilter(sql`subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
         for update`,
  ))
  if (!row.rows[0]) return NextResponse.json({ error: 'party not found' }, { status: 404 })
  return null
}
