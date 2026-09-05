// The Insights executor. Runs a compiled query through the shared pool inside a
// READ ONLY transaction under the application's tenant-scoped runtime role.
// These are catalog-authored, parameterized queries over application tables.
// The SQL console's openbooks_read role can only read its narrower governed
// views, so it cannot execute this catalog. PostgreSQL still enforces RLS,
// refuses writes, and caps runtime independently of the compiler.
//
// SERVER ONLY — imports node-postgres. Never import from a client bundle; the
// client renderer takes a QueryResult, not the pool.

import { compileInsightQuery, INSIGHT_MAX_ROWS, type InsightLabelResolver } from './compile'
import { validateInsightQuery } from './validate'
import type { InsightQuery, QueryResult } from './types'

/** Minimal shape of a node-postgres Pool — avoids a hard dep on `pg` types in
 *  this workspace while keeping the call site type-safe. */
export interface QueryPool {
  connect(): Promise<PoolClient>
}
export interface PoolClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }>
  release(): void
}

const STATEMENT_TIMEOUT_MS = 8_000

/**
 * Compile + execute an insight query for an org. Returns the typed result set,
 * capped at 10k rows and 8s. Throws InsightCompileError on a malformed query and
 * surfaces the Postgres error (e.g. statement timeout) otherwise.
 */
export async function runInsightQuery(
  pool: QueryPool,
  query: InsightQuery,
  orgId: string,
  allowedSubsidiaryIds: readonly string[] | null,
  labels?: InsightLabelResolver,
  asOf?: string,
): Promise<QueryResult> {
  if (allowedSubsidiaryIds === undefined) throw new Error('Insights requires an explicit subsidiary authorization scope')
  const validatedQuery = validateInsightQuery(query)
  const compiled = compileInsightQuery(validatedQuery, orgId, labels, asOf, allowedSubsidiaryIds)
  // Fetch one extra row to detect truncation at the cap.
  const capped = Math.min(compiled.limit, INSIGHT_MAX_ROWS)
  const sentinelLimit = capped + 1
  // The compiler's SELECT already carries the requested cap. Raise that inner
  // limit as well, otherwise it hides the sentinel row before the wrapper can
  // observe it.
  const innerLimit = `\nlimit ${compiled.limit}`
  if (!compiled.sql.endsWith(innerLimit))
    throw new Error('compiled insight query is missing its row limit')
  const sqlWithSentinel = `${compiled.sql.slice(0, -innerLimit.length)}\nlimit ${sentinelLimit}`
  const wrapped = `select * from (${sqlWithSentinel}) __insight limit ${sentinelLimit}`

  const client = await pool.connect()
  const started = Date.now()
  try {
    await client.query('begin transaction read only')
    await client.query("select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)", [orgId])
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    const res = await client.query(wrapped, compiled.params)
    await client.query('rollback')

    const truncated = res.rows.length > capped
    const rows = truncated ? res.rows.slice(0, capped) : res.rows
    return {
      columns: compiled.columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
    }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
