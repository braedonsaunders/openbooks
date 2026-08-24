import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PDF_RECORD_TYPE_BY_KEY } from '../../../lib/pdf-templates/catalog'

/**
 * The printed/emailed record is the disclosure: resolve its subsidiary scope
 * before any template work. Document-backed types live in `documents`
 * (kind-pinned, matching loadDocumentValues); journal entries carry their own
 * subsidiary. Types without a resolvable subsidiary return a null one so the
 * caller's guard fails closed.
 */
export async function loadRecordSubsidiaryScope(
  recordType: string,
  orgId: string,
  id: string,
): Promise<{ subsidiaryId: string | null } | null> {
  if (recordType === 'journal_entry') {
    return (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`select subsidiary_id as "subsidiaryId" from journal_entries where id = ${id} and org_id = ${orgId}`,
      )
    ).rows[0] ?? null
  }
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta?.docKind) return { subsidiaryId: null }
  return (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`select subsidiary_id as "subsidiaryId" from documents where id = ${id} and kind = ${meta.docKind} and org_id = ${orgId}`,
    )
  ).rows[0] ?? null
}
