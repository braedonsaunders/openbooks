import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Re-read after a pre-existing row or a lost insert race: replay or refuse.
 *
 * Idempotent creates use the caller's key as the row id and record the
 * immutable create image as the insert audit event's `after`. A retry is a
 * replay only when its request-controlled subset (`match`) equals that image
 * byte-for-byte under canonical JSON; anything else is a conflict, so a reused
 * key never returns an older row as though it matched.
 *
 * `matchField` names the audit-image key the retry is compared against.
 * Callers that audit the full stored row as `after` (whose derived values
 * may legitimately differ from the request, or drift across storage
 * round-trips) persist the request-controlled image separately — conventionally
 * `match` — and compare snapshot against snapshot, so both sides are produced
 * by identical code and later edits to the row cannot break an exact retry.
 */
export async function resolveIdempotentReplay(
  tx: SqlExecutor,
  args: {
    orgId: string;
    table: string;
    key: string;
    match: Record<string, unknown>;
    matchField?: string;
  },
): Promise<"replay" | "conflict"> {
  // The key travels as a quoted literal (never a bound parameter: Postgres
  // has no placeholder for an object key), sanitized to a bare identifier so
  // a caller cannot shape the statement text through it.
  const keyLiteral = args.matchField === undefined || args.matchField === "after"
    ? `'after'`
    : `'${args.matchField.replace(/[^a-z_]/g, "")}'`;
  const original = (
    await tx.execute<{ after: unknown }>(sql`
      select changes->${sql.raw(keyLiteral)} as after
        from audit_log
       where org_id = ${args.orgId}
         and table_name = ${args.table}
         and row_id = ${args.key}
         and action = 'insert'
         and request_id = ${args.key}
       order by at asc
       limit 1
    `)
  ).rows[0]?.after;
  if (!original || typeof original !== "object" || original === null) return "conflict";
  const keys = Object.keys(args.match);
  const projected: Record<string, unknown> = {};
  for (const k of keys) projected[k] = (original as Record<string, unknown>)[k];
  if (canonicalJson(projected) !== canonicalJson(args.match)) return "conflict";
  return "replay";
}
