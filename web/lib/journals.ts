import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { nextDocumentNumber } from './bills'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Instant-into-draft: empty manual journal document (kind 'journal', JE- sequence). */
export async function createDraftJournal(orgId: string, userId: string) {
  const root = (await db.execute(sql`
    select id, base_currency from subsidiaries where org_id = ${orgId} and parent_id is null`)) as unknown as {
    rows: { id: string; base_currency: string }[]
  }
  const subsidiary = root.rows[0]
  if (!subsidiary) throw new Error('org has no root subsidiary')
  const documentNumber = await nextDocumentNumber(orgId, 'journal', 'JE-', subsidiary.id)
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind: 'journal',
      subsidiaryId: subsidiary.id,
      documentNumber,
      documentDate: new Date().toISOString().slice(0, 10),
      currency: subsidiary.base_currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })
  return doc!
}

/** Full manual-journal payload for the drawer: header + signed lines. */
export async function loadJournalDoc(id: string) {
  if (!UUID_RE.test(id)) return null
  const doc = (await db.execute(sql`
    select d.*, p.display_name as party_name, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
     where d.id = ${id} and d.kind = 'journal'
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!doc.rows[0]) return null
  const lines = (await db.execute(sql`
    select l.id, l.line_number, l.account_id, l.description, l.amount,
           l.department_id, l.project_id, l.subsidiary_id, l.extra_dims, l.custom
      from document_lines l
     where l.document_id = ${id}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }
  return { doc: doc.rows[0], lines: lines.rows }
}
