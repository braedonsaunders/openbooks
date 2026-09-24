// The Insights executor. Runs a compiled query through the shared pool inside a
// READ ONLY transaction under the application's tenant-scoped runtime role.
// These are catalog-authored, parameterized queries over application tables.
// The SQL console's openbooks_read role can only read its narrower governed
// views, so it cannot execute this catalog. PostgreSQL still enforces RLS,
// refuses writes, and caps runtime independently of the compiler.
//
// SERVER ONLY — imports node-postgres. Never import from a client bundle; the
// client renderer takes a QueryResult, not the pool.

import { REPORT_ENTITY_MAP, parseDenominationCounts, resolveDenominations, type ReportEntity } from '@openbooks/reports'
import { compileInsightQuery, INSIGHT_MAX_ROWS, type InsightLabelResolver } from './compile'
import { validateInsightQuery } from './validate'
import type { InsightDenominationBasis, InsightQuery, QueryResult } from './types'

/** An insight card would blend money across denominations (mixed currencies
 *  or accounting books) without partitioning by the denomination. The message
 *  names the remedy (group by the denomination or filter to one) and must
 *  reach the operator verbatim — the API layer returns it as the refusal,
 *  never as a generic failure. */
export class InsightDenominationError extends Error {
  readonly name = 'InsightDenominationError'
}

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

/** Fail-closed denomination enforcement — the report executor's rule
 *  (run.ts), applied to an insight result. The inline `__denom` census rides
 *  on the result rows, so guard and result derive from the same statement and
 *  snapshot. Throws InsightDenominationError BEFORE any blended row or total
 *  materializes: a dimension with several denominations and no partitioning
 *  breakout would blend inside single group rows. Partitions keep labeled
 *  per-denomination rows flowing — only the combining outputs are gated. */
function enforceDenominationBasis(
  sourceKey: string,
  basis: InsightDenominationBasis,
  rows: Record<string, unknown>[],
): void {
  if (!basis.hasDenominationCensus) return
  for (const row of rows) {
    for (const dim of basis.denominationDimensions) {
      const count = row[`__${dim}_n`]
      if (count == null || !Number.isSafeInteger(Number(count)) || Number(count) < 0) {
        throw new InsightDenominationError('Report returned invalid denomination evidence')
      }
    }
    if (basis.denominationDimensions.includes('book')) {
      const count = row.__book_group_n
      if (count == null || !Number.isSafeInteger(Number(count)) || Number(count) < 0) {
        throw new InsightDenominationError('Report returned invalid accounting-book evidence')
      }
      // Book names are not unique. Grouping by a shared label must never
      // silently merge two books even though it appears to be partitioned.
      if (Number(count) > 1) {
        throw new InsightDenominationError('Cannot aggregate rows that mix accounting books — group by Book code or Book (id)')
      }
    }
  }
  const entity = REPORT_ENTITY_MAP[sourceKey]
  if (!entity) throw new InsightDenominationError(`unknown source "${sourceKey}"`)
  try {
    resolveDenominations(
      entity,
      {
        breakouts: basis.breakouts,
        measures: basis.measures,
        txnCurrencyPinned: basis.txnCurrencyPinned,
        baseCurrencyPinned: basis.baseCurrencyPinned,
        bookPinned: basis.bookPinned,
        bookSingleBasis: basis.bookSingleBasis,
        baseSingleSubsidiary: basis.baseSingleSubsidiary,
      },
      parseDenominationCounts(rows[0]),
    )
  } catch (e) {
    if (e instanceof InsightDenominationError) throw e
    throw new InsightDenominationError(e instanceof Error ? e.message : 'query failed')
  }
}

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
  labels: InsightLabelResolver | undefined,
  asOf: string,
  /** Server-owned accounting-book allowlist, resolved by the caller (the
   *  single active primary unless the card scopes or partitions by book).
   *  Undefined leaves book-scoped entities unclamped. */
  allowedBookIds?: readonly string[] | null,
  /** The reader's own report-entity catalog rows (a restricted reader's
   *  pre-collapsed grain). Defaults to the authored catalog (full detail). */
  entityMap: Record<string, ReportEntity> = REPORT_ENTITY_MAP,
  /** Organization-configured fiscal-year start month. */
  fiscalStartMonth = 1,
): Promise<QueryResult> {
  if (allowedSubsidiaryIds === undefined) throw new Error('Insights requires an explicit subsidiary authorization scope')
  const validatedQuery = validateInsightQuery(query)
  const compiled = compileInsightQuery(validatedQuery, orgId, labels ?? {}, asOf, allowedSubsidiaryIds, allowedBookIds, entityMap, fiscalStartMonth)
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

    enforceDenominationBasis(validatedQuery.source, compiled.denomination, res.rows)

    const truncated = res.rows.length > capped
    const rows = truncated ? res.rows.slice(0, capped) : res.rows
    if (compiled.denomination.hasDenominationCensus) {
      // The inline census travels in `__`-prefixed columns no catalog field
      // may use; strip it before the result leaves the executor so API
      // consumers never see guard machinery as data.
      for (const row of rows) {
        for (const key of Object.keys(row)) {
          if (key.startsWith('__')) delete row[key]
        }
      }
    }
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
