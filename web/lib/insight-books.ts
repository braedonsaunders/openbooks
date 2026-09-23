import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { insightQueryReferencesBook, type InsightQuery } from '@openbooks/analytics'

/** The card's accounting basis is ambiguous (zero or several active primary
 *  books) and no first-row fallback may silently pick one. The route surfaces
 *  this verbatim so the operator sees the remedy; every other resolution
 *  failure stays a generic error. */
export class InsightBookScopeError extends Error {
  constructor() {
    super(
      'This card needs exactly one active primary accounting book. Choose a book filter to run it against a specific book instead.',
    )
    this.name = 'InsightBookScopeError'
  }
}

/**
 * One selection contract for insight cards over book-scoped entities, mirroring
 * resolveCustomReportBookScope for custom reports (web/lib/custom-reports.ts):
 *
 * - entities without a book boundary (documents carry no book_id by design)
 *   return undefined — never clamped, balances stay book-agnostic;
 * - plans that filter or group by a book column return null — the author's
 *   explicit book scoping governs, unclamped, so intentional cross-book
 *   analysis keeps working with each book labeled;
 * - every other plan against a book-scoped entity returns the single active
 *   primary book id. Zero or several active primaries throw: the basis is
 *   ambiguous and no first-row fallback may silently pick one.
 *
 * The scope only READS the saved plan — filters are never rewritten — and it
 * never touches the org or subsidiary fences, which the compiler ANDs in
 * regardless of the book decision.
 */
export async function resolveInsightBookScope(
  orgId: string,
  query: InsightQuery,
): Promise<readonly string[] | null | undefined> {
  const entity = REPORT_ENTITY_MAP[query.source]
  if (!entity?.bookScope) return undefined
  if (insightQueryReferencesBook(query)) return null
  const { rows } = await db.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_primary and is_active
  `)
  if (rows.length !== 1) {
    throw new InsightBookScopeError()
  }
  return [rows[0]!.id]
}
