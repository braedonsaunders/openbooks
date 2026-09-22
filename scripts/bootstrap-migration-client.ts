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
import { longPool } from "../engine/src/platform/db.ts";

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
/**
 * Bounded lock-wait policy for deployment bootstrap's schema migrations.
 *
 * Every migration used to run with `SET lock_timeout = 0` in its own body
 * (170 of 219 files), each inside one transaction while the old stack keeps
 * serving traffic. An ALTER TABLE queued behind a long report query then
 * waits forever — and every later query on that table queues behind the
 * migration, hanging the app. Published files are immutable, so the runner
 * cannot rewrite them: it strips their file-level lock_timeout statements
 * (see sanitizeMigrationContent) and imposes its own bound instead, retrying
 * the whole migration transaction with backoff when the bound fires.
 */
export type MigrationLockConfig = {
  /** Per-attempt ceiling on waiting for a table lock, milliseconds. */
  lockTimeoutMs: number;
  /** Total attempts (first try + retries) before the deploy fails loudly. */
  maxAttempts: number;
  /** Base backoff between attempts; doubles per attempt, capped at 30s. */
  retryBaseMs: number;
};

export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_MIGRATION_LOCK_MAX_ATTEMPTS = 6;
export const DEFAULT_MIGRATION_LOCK_RETRY_BASE_MS = 1_000;

/** SQLSTATE for lock_not_available — the bounded lock_timeout firing. */
export const LOCK_NOT_AVAILABLE_SQLSTATE = "55P03";

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function migrationLockConfig(
  source: Record<string, string | undefined>,
): MigrationLockConfig {
  return {
    lockTimeoutMs: boundedInt(
      source.OPENBOOKS_MIGRATION_LOCK_TIMEOUT_MS,
      DEFAULT_MIGRATION_LOCK_TIMEOUT_MS,
      500,
      300_000,
    ),
    maxAttempts: boundedInt(
      source.OPENBOOKS_MIGRATION_LOCK_MAX_ATTEMPTS,
      DEFAULT_MIGRATION_LOCK_MAX_ATTEMPTS,
      1,
      25,
    ),
    retryBaseMs: boundedInt(
      source.OPENBOOKS_MIGRATION_LOCK_RETRY_BASE_MS,
      DEFAULT_MIGRATION_LOCK_RETRY_BASE_MS,
      100,
      60_000,
    ),
  };
}

export function migrationRetryDelayMs(
  config: MigrationLockConfig,
  failedAttempt: number,
): number {
  return Math.min(config.retryBaseMs * 2 ** (failedAttempt - 1), 30_000);
}

/** True when the error is the bounded migration lock_timeout firing. Only
 * this condition is retried: any other failure aborts the deploy at once,
 * because retrying a half-applied non-idempotent migration would run its
 * body twice. */
export function isLockNotAvailable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE_SQLSTATE;
}

/**
 * Opt-out of the runner's migration transaction, declared by the migration
 * itself. A line that is exactly `-- openbooks: no-transaction` (after the
 * `--` marker, case-insensitive) tells the runner to execute the file
 * without BEGIN/COMMIT — required for statements PostgreSQL refuses inside
 * a transaction block, notably CREATE INDEX CONCURRENTLY on a hot table.
 *
 * The contract is strict, because a failure mid-file leaves earlier
 * statements committed: every statement must be idempotent (IF NOT EXISTS
 * and friends), and a failed CONCURRENTLY build leaves an INVALID index
 * that IF NOT EXISTS would then skip forever — so the file must drop its
 * own INVALID indexes up front (see 0261 for the pattern).
 */
export function migrationRunsWithoutTransaction(content: string): boolean {
  return content
    .split("\n")
    .some((line) => /^\s*--\s*openbooks:\s*no-transaction\s*$/i.test(line));
}

/**
 * Strip file-level `SET [SESSION|LOCAL] lock_timeout ...` and
 * `RESET lock_timeout` statements from a migration body. The runner imposes
 * its own bounded lock_timeout (SET LOCAL inside the migration transaction,
 * session SET around a no-transaction file), and a file-level statement
 * would silently disarm it for every statement after it — including the
 * 170 published `SET lock_timeout = 0` files, which are immutable and
 * therefore cannot be fixed at the source.
 *
 * The scan is quote- and comment-aware: a lock_timeout mention inside a
 * dollar-quoted function body, a string literal, or a comment is code or
 * prose, not a GUC assignment, and is left alone. Returns the body with
 * those statements removed (any value — the runner is authoritative).
 */
export function sanitizeMigrationContent(content: string): string {
  const pattern = /set(?:\s+(?:session|local))?\s+lock_timeout\s*(?:=|to\b)\s*[^\n;]*;?|reset\s+lock_timeout\s*;?/gi;
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "squote" | "dquote" = "code";
  let blockDepth = 0;
  let dollarTag: string | null = null;
  const n = content.length;
  while (i < n) {
    if (dollarTag !== null) {
      if (content.startsWith(dollarTag, i)) {
        out += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        out += content[i];
        i += 1;
      }
      continue;
    }
    const ch = content[i];
    const next = content[i + 1];
    if (state === "code") {
      if (ch === "-" && next === "-") {
        state = "line";
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        blockDepth = 1;
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = "squote";
        out += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = "dquote";
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "$") {
        const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(content.slice(i))?.[0];
        if (tag) {
          dollarTag = tag;
          out += tag;
          i += tag.length;
          continue;
        }
        out += ch;
        i += 1;
        continue;
      }
      pattern.lastIndex = i;
      const match = pattern.exec(content);
      if (match && match.index === i) {
        i += match[0].length;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      out += ch;
      i += 1;
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      out += ch;
      if (ch === "/" && next === "*") {
        blockDepth += 1;
        out += next;
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        out += next;
        i += 2;
        blockDepth -= 1;
        if (blockDepth === 0) state = "code";
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "squote") {
      out += ch;
      i += 1;
      if (ch === "'" && next === "'") {
        out += next;
        i += 1;
      } else if (ch === "'") {
        state = "code";
      }
      continue;
    }
    out += ch;
    i += 1;
    if (ch === '"' && next === '"') {
      out += next;
      i += 1;
    } else if (ch === '"') {
      state = "code";
    }
  }
  return out;
}

export function describeBootstrapMigrationFailure(
  filename: string,
  error: unknown,
  elapsedMs: number,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  const elapsed = `${(elapsedMs / 1000).toFixed(1)}s`;
  if (code === LOCK_NOT_AVAILABLE_SQLSTATE || /could not obtain lock/i.test(raw)) {
    return (
      `[bootstrap] ${filename} failed after ${elapsed}: the migration could not `
      + `acquire a table lock within its bounded lock_timeout (${raw}). Another `
      + `session is holding a conflicting lock — find the blocker in `
      + `pg_stat_activity (a pid whose query started long ago on the same table, `
      + `with this migration waiting behind it), cancel the blocker or redeploy `
      + `in a quieter window. The wait is bounded by `
      + `OPENBOOKS_MIGRATION_LOCK_TIMEOUT_MS and retried up to `
      + `OPENBOOKS_MIGRATION_LOCK_MAX_ATTEMPTS times; raising either only papers `
      + `over sustained contention, so treat a repeat as a scheduling problem, `
      + `not a timeout to tune away.`
    );
  }
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
