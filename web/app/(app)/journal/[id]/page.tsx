import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { requirePermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { journalScopeWhere } from '../../../../lib/customization/entity-list-query/journal-entries'

export const dynamic = 'force-dynamic'

/** Compatibility redirect: posted entry detail now always opens in a drawer. */
export default async function LegacyJournalEntry({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('gl.read')
  const { id } = await params
  if (!isUuid(id)) redirect('/journal')
  const result = (await db.execute<{ id: string }>(sql`
    select e.id
      from journal_entries e
     where e.id = ${id} and ${journalScopeWhere(authz.user.orgId, authz.allowedSubsidiaryIds)}
  `))
  const row = result.rows[0]
  if (!row) redirect('/journal')
  redirect(`/journal?journalEntry=${id}`)
}
