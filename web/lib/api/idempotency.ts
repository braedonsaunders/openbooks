import { sql } from 'drizzle-orm'
import { canonicalJson } from '@openbooks/engine/src/platform/canonical-json.ts'
import type { db } from '@openbooks/engine/src/platform/db.ts'

type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Idempotent create guard, following POST /api/accounts: the caller's
 * `Idempotency-Key` header becomes the row id, so a retried request resolves
 * to the same row instead of a duplicate.
 *
 * Two shapes travel together:
 * - `snapshot`: the full immutable create image, persisted as the insert
 *   audit event's `after` (request-controlled columns plus derived values
 *   such as slugs).
 * - `match`: the request-controlled subset a retry must equal byte-for-byte
 *   under canonical JSON. Derived values (slugs, suffix-walked keys) are
 *   EXCLUDED: they depend on concurrent DB state, so comparing them would
 *   turn a genuine retry into a conflict. Lifecycle state (status) is
 *   excluded too — it legitimately advances after creation.
 *
 * A reused key with a changed payload, or a key colliding with another org's
 * row, resolves to conflict (409) — fail closed, never return the older row
 * as though it matched.
 */
export async function claimIdempotentCreate(
  tx: Executor,
  args: { orgId: string; table: string; key: string },
): Promise<'fresh' | 'exists'> {
  const prior = await tx.execute<{ id: string }>(sql`
    select id from ${sql.identifier(args.table)}
     where id = ${args.key} and org_id = ${args.orgId}
  `)
  return prior.rows[0] ? 'exists' : 'fresh'
}

/** Re-read after a pre-existing row or a lost insert race: replay or refuse. */
export async function resolveIdempotentReplay(
  tx: Executor,
  args: {
    orgId: string
    table: string
    key: string
    match: Record<string, unknown>
  },
): Promise<'replay' | 'conflict'> {
  const original = (
    await tx.execute<{ after: unknown }>(sql`
      select changes->'after' as after
        from audit_log
       where org_id = ${args.orgId}
         and table_name = ${args.table}
         and row_id = ${args.key}
         and action = 'insert'
         and request_id = ${args.key}
       order by at asc
       limit 1
    `)
  ).rows[0]?.after
  if (!original || typeof original !== 'object' || original === null) return 'conflict'
  const keys = Object.keys(args.match)
  const projected: Record<string, unknown> = {}
  for (const k of keys) projected[k] = (original as Record<string, unknown>)[k]
  if (canonicalJson(projected) !== canonicalJson(args.match)) return 'conflict'
  return 'replay'
}
