import { redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/** Compatibility redirect: posted entry detail now always opens in a drawer. */
export default async function LegacyJournalEntry({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('gl.read')
  const { id } = await params
  if (!isUuid(id)) redirect('/journal')
  const subsidiaryFilter = authz.allowedSubsidiaryIds
    ? authz.allowedSubsidiaryIds.size > 0
      ? sql`and e.subsidiary_id in ${[...authz.allowedSubsidiaryIds]}`
      : sql`and false`
    : sql``
  const result = (await db.execute<{ doc_id: string | null; doc_kind: string | null }>(sql`
    select d.id as doc_id, d.kind as doc_kind
      from journal_entries e
      left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
     where e.id = ${id} and e.org_id = ${authz.user.orgId}
       ${subsidiaryFilter}
  `))
  const row = result.rows[0]
  if (!row) redirect('/journal')
  if (row.doc_id && row.doc_kind) {
    const next = new URLSearchParams({
      reportRecord: row.doc_id,
      reportRecordKind: row.doc_kind,
      drawerReturn: '/journal',
    })
    redirect(`/journal?${next}`)
  }
  redirect(`/journal?txn=${id}`)
}
