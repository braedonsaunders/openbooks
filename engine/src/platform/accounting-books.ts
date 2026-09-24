import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "./db.ts";

/**
 * The org's active posting primary book — the single shared definition of
 * which book is authoritative. Parallel books are alternate representations
 * of the same economics, so every ledger read and posting gate must resolve
 * the same book: the one flagged primary that is still active and still
 * posts to the GL. After a primary is deactivated (or stops posting), reads
 * that join on `is_primary` alone keep summing the dead book while the
 * posting run — which gates on active AND posting — writes elsewhere, so
 * the two disagree.
 *
 * Returns the book id, or null when no book qualifies. Readers sum nothing
 * in that state (a join on the id matches no rows); writers refuse with
 * their own named error. No row lock here: writers that need serialization
 * against a book change take their own (e.g. `for share` on the resolved
 * row inside their unit).
 */
export async function activePostingPrimaryBookId(
  orgId: string,
  runner: SqlExecutor = db,
): Promise<string | null> {
  const r = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1`));
  return r.rows[0]?.id ?? null;
}
