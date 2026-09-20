import { sql, type SQL } from "drizzle-orm";

/**
 * Opaque revision token shape. Revisioned rows (documents, prebill lines, AP
 * capture items, custom records, opportunities) compare on the strictly
 * increasing `revision_seq` counter (migration 0167), so the canonical token
 * is its decimal text; the legacy six-digit timestamp form is still accepted
 * so tables whose `updated_at` doubles as the token keep validating.
 * Cross-format confusion fails closed: a timestamp never equals a counter, so
 * a mismatched token always loses the string comparison at the lock.
 */
export const DOCUMENT_REVISION_PATTERN =
  "^(?:\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z|\\d{1,20})$";
const DOCUMENT_REVISION_REGEX = new RegExp(DOCUMENT_REVISION_PATTERN);

export function isDocumentRevisionToken(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_REVISION_REGEX.test(value);
}

/** Lossless wire representation for PostgreSQL's six-digit timestamptz. */
export function documentRevisionSql(column: SQL): SQL<string> {
  return sql<string>`to_char(
    ${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`;
}

/**
 * Lossless wire representation for the `revision_seq` optimistic-concurrency
 * counter. Every UPDATE bumps it at the database boundary, including writes
 * that backdate the `updated_at` display timestamp — so unlike the timestamp
 * projection above, two committed revisions can never share this token.
 */
export function documentRevisionCounterSql(column: SQL): SQL<string> {
  return sql<string>`(${column})::text`;
}
