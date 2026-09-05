import { sql, type SQL } from "drizzle-orm";

/** Opaque PostgreSQL revision token: never round it through JavaScript Date. */
export const DOCUMENT_REVISION_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$";
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
