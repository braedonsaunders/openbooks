import { sql } from 'drizzle-orm'
import { canonicalJson } from '@openbooks/engine/src/platform/canonical-json.ts'
import type { SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

// The narrowest runner every caller already satisfies: full transaction
// executors (routes, setupWriteTransaction) and SqlExecutor-typed helpers
// (saveSetupBook) alike.
type Executor = SqlExecutor

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

/**
 * Re-read after a pre-existing row or a lost insert race: replay or refuse.
 *
 * `matchField` names the audit-image key the retry is compared against.
 * Callers that audit the full stored row as `after` (whose derived values
 * may legitimately differ from the request, or drift across storage
 * round-trips) persist the request-controlled image separately — conventionally
 * `match` — and compare snapshot against snapshot, so both sides are produced
 * by identical code and later edits to the row cannot break an exact retry.
 */
export async function resolveIdempotentReplay(
  tx: Executor,
  args: {
    orgId: string
    table: string
    key: string
    match: Record<string, unknown>
    matchField?: string
  },
): Promise<'replay' | 'conflict'> {
  // The key travels as a quoted literal (never a bound parameter: Postgres
  // has no placeholder for an object key), sanitized to a bare identifier so
  // a caller cannot shape the statement text through it.
  const keyLiteral = args.matchField === undefined || args.matchField === 'after'
    ? `'after'`
    : `'${args.matchField.replace(/[^a-z_]/g, '')}'`
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
  ).rows[0]?.after
  if (!original || typeof original !== 'object' || original === null) return 'conflict'
  const keys = Object.keys(args.match)
  const projected: Record<string, unknown> = {}
  for (const k of keys) projected[k] = (original as Record<string, unknown>)[k]
  if (canonicalJson(projected) !== canonicalJson(args.match)) return 'conflict'
  return 'replay'
}

/**
 * The refusal when a reused idempotency key cannot replay: a changed payload,
 * a key colliding with another org's row, or a key colliding with a row this
 * endpoint did not create. Surfaces as 409 with a typed code — fail closed,
 * never the older row as though it matched. The message names the remedy
 * (reopen the drawer for a fresh key), and the remedy exists: every create
 * drawer mints a new key per mount.
 */
export class SetupCreateConflict extends Error {
  readonly status = 409 as const
  readonly code = 'idempotency-conflict' as const
  constructor(reason: 'changed-payload' | 'foreign-key') {
    super(reason === 'foreign-key'
      ? 'This request key is already in use by another organization. Close and reopen the drawer to try again with a fresh request.'
      : 'This request was already saved with different details. Close and reopen the drawer to try again with a fresh request.')
  }
}

/**
 * Claim-or-replay for table-backed creates whose key becomes the row id.
 * Returns 'fresh' when the caller may proceed to its (side-effecting) insert,
 * or the existing row id when the retry must return WITHOUT writing again.
 * Throws SetupCreateConflict when the key cannot replay. Call on a
 * transaction that already holds the key's pg_advisory_xact_lock, before any
 * create effect — including demotions, version closures, and join-table
 * writes — so a replay never reaches them.
 */
export async function claimSetupCreate(
  tx: Executor,
  args: {
    orgId: string
    table: string
    key: string
    match: Record<string, unknown>
    /** Selects without an org filter to detect a cross-org collision instead
     *  of silently matching zero rows (which would read as a fresh claim). */
    orgScoped?: boolean
  },
): Promise<{ kind: 'fresh' } | { kind: 'replay'; id: string }> {
  const table = sql.identifier(args.table)
  if (args.orgScoped === false) {
    const prior = await tx.execute<{ id: string }>(sql`
      select id from ${table} where id = ${args.key}`)
    if (!prior.rows[0]) return { kind: 'fresh' }
  } else {
    const prior = await tx.execute<{ org_id: string }>(sql`
      select org_id from ${table} where id = ${args.key}`)
    const owner = prior.rows[0]?.org_id
    if (owner === undefined) return { kind: 'fresh' }
    if (owner !== args.orgId) throw new SetupCreateConflict('foreign-key')
  }
  const verdict = await resolveIdempotentReplay(tx, {
    orgId: args.orgId,
    table: args.table,
    key: args.key,
    match: args.match,
    matchField: 'match',
  })
  if (verdict !== 'replay') throw new SetupCreateConflict('changed-payload')
  return { kind: 'replay', id: args.key }
}
