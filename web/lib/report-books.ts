import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { isReportUuidParam } from "./report-filters";

export class ReportBookSelectionError extends Error {
  readonly status = 422;
  constructor() {
    super("Accounting book is unavailable. Choose an active accounting book.");
    this.name = "ReportBookSelectionError";
  }
}

/** One selection contract for statement pages, exports and supporting rows.
 * Only an omitted selection defaults to the primary book. A stale or foreign
 * explicit selection must never silently change the accounting basis. */
export async function reportBookSelection(orgId: string, requested?: string | null) {
  if (requested != null && !isReportUuidParam(requested)) throw new ReportBookSelectionError();
  const books = await db.execute<{
    id: string;
    code: string;
    name: string;
    is_primary: boolean;
    replication_mode: string;
    posts_gl: boolean;
  }>(
    sql`
    select id, code, name, is_primary, replication_mode, posts_gl from accounting_books
     where org_id = ${orgId} and is_active
     order by is_primary desc, code, id
  `,
    "objects",
  );
  const selectedBook =
    requested == null
      ? books.find((book) => book.is_primary)
      : books.find((book) => book.id === requested.toLowerCase());
  if (!selectedBook) throw new ReportBookSelectionError();
  const basisBookIds = (
    await db.execute<{ id: string }>(
      sql`select public.reporting_book_ids(${orgId}::uuid, ${selectedBook.id}::uuid) as id`,
      "objects",
    )
  ).map((row) => row.id);
  return { books, selectedBook, basisBookIds };
}
