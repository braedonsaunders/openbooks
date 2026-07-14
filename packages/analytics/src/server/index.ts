// @openbooks/analytics/server — the execution surface (opens a DB connection).
// SERVER ONLY: imports node-postgres via the caller's pool. Never import from a
// client bundle.

export { runInsightQuery } from '../execute'
export type { QueryPool, PoolClient } from '../execute'
