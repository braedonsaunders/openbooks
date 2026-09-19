/**
 * Long-DDL executor for deployment bootstrap's schema migrations.
 *
 * The request pool carries a 120s client query_timeout, and the
 * whole-schema baseline builds hundreds of tables, indexes, and constraints
 * in ONE statement — a slow host exceeds the client timer long before the
 * server finishes ("Query read timeout"). longPool disables both the client
 * and server timeouts for exactly this class of work. Unlike pool.connect,
 * longPool has no org-context wrapper, so the bypass GUCs are applied
 * explicitly: migration backfills must see every row, exactly as they did
 * through the wrapped request pool under withBypassContext. Callers must
 * return the client via releaseMigrationClient so the deny-by-default
 * posture is restored before the session is reused.
 *
 * Lives in its own module (rather than inline in bootstrap.ts) because
 * bootstrap.ts runs main() on import; tests import this module directly.
 */
import pg from "pg";
import { longPool } from "../engine/src/db.ts";

export async function connectMigrationClient(): Promise<pg.PoolClient> {
  const client = await longPool.connect();
  try {
    await client.query(
      "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'on', false)",
    );
    return client;
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

/**
 * Return a migration client to longPool with the deny-by-default posture
 * restored. A broken session is discarded instead of being reused.
 */
export async function releaseMigrationClient(client: pg.PoolClient): Promise<void> {
  try {
    await client.query(
      "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'off', false)",
    );
  } catch {
    client.release(true);
    return;
  }
  client.release();
}

/**
 * Translate a migration/RLS failure into an operator-actionable message.
 * "Query read timeout" names neither the expired timer nor any remedy; say
 * what exceeded what and what to do.
 */
export function describeBootstrapMigrationFailure(
  filename: string,
  error: unknown,
  elapsedMs: number,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
  if (raw.includes("Query read timeout")) {
    return (
      `[bootstrap] ${filename} failed after ${elapsed}: the PostgreSQL client's `
      + `query_timeout fired before the server answered (${raw}). This is a `
      + `client-side timer, not a schema error — the database may still have been `
      + `working. Schema migrations run on the timeout-free maintenance pool, so a `
      + `recurrence means the server itself is stuck: look for a blocking lock in `
      + `pg_stat_activity, then check server logs and host CPU, memory, and disk.`
    );
  }
  if (code === "57014" || /statement timeout/i.test(raw)) {
    return (
      `[bootstrap] ${filename} failed after ${elapsed}: the server-side `
      + `statement_timeout cancelled the statement (${raw}). The client kept `
      + `waiting but the server refused to run longer — check for lock contention `
      + `in pg_stat_activity and for a statement_timeout set on the role or database.`
    );
  }
  return `[bootstrap] ${filename} failed after ${elapsed}: ${raw}`;
}
