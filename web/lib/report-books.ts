import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { isReportUuidParam } from './report-filters'

export class ReportBookSelectionError extends Error {
  constructor() {
    super('Accounting book is unavailable. Choose an active accounting book.')
    this.name = 'ReportBookSelectionError'
  }
}

/** One selection contract for statement pages, exports and supporting rows.
 * Only an omitted selection defaults to the primary book. A stale or foreign
 * explicit selection must never silently change the accounting basis. */
export async function reportBookSelection(orgId: string, requested?: string | null) {
  if (requested != null && !isReportUuidParam(requested)) throw new ReportBookSelectionError()
  const { rows: books } = await db.execute<{ id: string; code: string; name: string; is_primary: boolean }>(sql`
    select id, code, name, is_primary from accounting_books
     where org_id = ${orgId} and is_active
     order by is_primary desc, code, id
  `)
  const selectedBook = requested == null
    ? books.find(book => book.is_primary)
    : books.find(book => book.id === requested.toLowerCase())
  if (!selectedBook) throw new ReportBookSelectionError()
  return { books, selectedBook }
}
