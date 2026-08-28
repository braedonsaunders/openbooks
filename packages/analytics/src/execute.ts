// The Insights executor. Runs a compiled query through the shared pool inside a
// READ ONLY transaction as the SELECT-only role (`openbooks_read`) — the same
// defense-in-depth boundary as engine/src/sqlapi.ts. Even though the compiler
// only emits parameterized SELECTs against whitelisted identifiers, Postgres
// itself refuses any write and caps runtime.
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
  labels?: InsightLabelResolver,
  asOf?: string,
): Promise<QueryResult> {
  const validatedQuery = validateInsightQuery(query)
  const compiled = compileInsightQuery(validatedQuery, orgId, labels, asOf)
  // Fetch one extra row to detect truncation at the cap.
  const capped = Math.min(compiled.limit, INSIGHT_MAX_ROWS)
  const wrapped = `select * from (${compiled.sql}) __insight limit ${capped + 1}`

  const client = await pool.connect()
  const started = Date.now()
  try {
    await client.query('begin transaction read only')
    await client.query('set local role openbooks_read')
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
