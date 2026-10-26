import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { bookReplicationGaps, type BookReplicationGaps } from "../journal/book-replication.ts";

export interface BookReplicationStatus {
  bookId: string;
  code: string;
  name: string;
  replicationMode: "adjustment_only" | "full";
  replicationFrom: string | null;
  currencyDifferenceAccountId: string | null;
  /** Subsidiaries the book carries in a currency other than their functional currency. */
  translatedSubsidiaries: { subsidiaryId: string; currency: string }[];
  /** Replicable primary entries through `through` the book does not hold. */
  gaps: BookReplicationGaps;
}

/** Every active secondary book's replication state and completeness through a date. */
export async function bookReplicationStatus(
  orgId: string,
  through: string,
  runner: SqlExecutor = db,
): Promise<BookReplicationStatus[]> {
  const books = await runner.execute<{
    id: string;
    code: string;
    name: string;
    replication_mode: "adjustment_only" | "full";
    replication_from: string | null;
    currency_difference_account_id: string | null;
  }>(
    sql`
    select id, code, name, replication_mode, replication_from::text as replication_from, currency_difference_account_id
      from accounting_books
     where org_id = ${orgId} and not is_primary and is_active
     order by code, id`,
    "objects",
  );
  const translated = await runner.execute<{
    book_id: string;
    subsidiary_id: string;
    currency: string;
  }>(
    sql`
    select distinct c.book_id, c.subsidiary_id, c.currency
      from accounting_book_currencies c
      join subsidiaries s on s.org_id = c.org_id and s.id = c.subsidiary_id
     where c.org_id = ${orgId} and c.currency <> s.base_currency
     order by c.book_id, c.subsidiary_id`,
    "objects",
  );
  const out: BookReplicationStatus[] = [];
  for (const book of books) {
    out.push({
      bookId: book.id,
      code: book.code,
      name: book.name,
      replicationMode: book.replication_mode,
      replicationFrom: book.replication_from,
      currencyDifferenceAccountId: book.currency_difference_account_id,
      translatedSubsidiaries: translated
        .filter((row) => row.book_id === book.id)
        .map((row) => ({ subsidiaryId: row.subsidiary_id, currency: row.currency })),
      gaps: await bookReplicationGaps(runner, { orgId, bookId: book.id, through }),
    });
  }
  return out;
}
