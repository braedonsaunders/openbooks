import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import { isUuid } from "./list-params";

/**
 * The book target of a manual journal. Null is the standard journal: it posts
 * to the primary book and replicates into every full book. A book id makes the
 * journal book-specific: it posts to that book only, needs Multi-book
 * accounting and the "Post book-specific journals" permission, and measures amounts
 * in the currency that book carries the journal's subsidiary in. The journal may use a registered transaction currency with an explicit exchange rate.
 */
export class JournalBookError extends Error {
  readonly name = "JournalBookError";
  constructor(
    message: string,
    readonly status: 403 | 404 | 422,
  ) {
    super(message);
  }
}

export interface JournalBookTarget {
  accountingBookId: string | null;
  /** The book's measurement currency for the journal's subsidiary. */
  currency: string;
}

export async function resolveJournalBookTarget(args: {
  orgId: string;
  requested: string | null;
  subsidiaryId: string;
  canPostBookSpecific: boolean;
  executor?: SqlExecutor;
}): Promise<JournalBookTarget> {
  const runner = args.executor ?? db;
  const base = (
    await runner.execute<{ base_currency: string }>(
      sql`
    select base_currency from subsidiaries where org_id = ${args.orgId} and id = ${args.subsidiaryId}`,
      "objects",
    )
  )[0];
  if (!base) throw new JournalBookError("invalid subsidiary", 422);
  if (args.requested === null) return { accountingBookId: null, currency: base.base_currency };
  if (!isUuid(args.requested)) throw new JournalBookError("accounting book not found", 404);
  // Loaded only when a book is named: a standard journal never needs it.
  const { isFeatureEnabled } = await import("./features");
  if (!(await isFeatureEnabled(args.orgId, "multiBookAccounting", args.executor))) {
    throw new JournalBookError(
      "Multi-book accounting is turned off; turn it on in Company Settings → Features to post a book-specific journal",
      422,
    );
  }
  if (!args.canPostBookSpecific) {
    throw new JournalBookError(
      'posting a book-specific journal requires the "Post book-specific journals" permission',
      403,
    );
  }
  const book = (
    await runner.execute<{ id: string; currency: string | null }>(
      sql`
    select id, public.accounting_book_currency(${args.orgId}, id, ${args.subsidiaryId}) as currency
      from accounting_books
     where org_id = ${args.orgId} and id = ${args.requested} and is_active and posts_gl`,
      "objects",
    )
  )[0];
  if (!book)
    throw new JournalBookError("accounting book not found or not an active posting book", 404);
  return { accountingBookId: book.id, currency: book.currency ?? base.base_currency };
}

/** Active posting books for the journal book selector, primary first. */
export async function journalBookOptions(
  orgId: string,
): Promise<{ id: string; code: string; name: string; isPrimary: boolean }[]> {
  return await db.execute<{ id: string; code: string; name: string; isPrimary: boolean }>(
    sql`
    select id, code, name, is_primary as "isPrimary" from accounting_books
     where org_id = ${orgId} and is_active and posts_gl
     order by is_primary desc, code, id`,
    "objects",
  );
}
