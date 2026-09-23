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
  // Sticky (`y`): the match must start exactly at `i`. The previous global
  // pattern searched the whole remaining suffix on every code character and
  // only kept matches at `i`, which is quadratic on large baselines.
  const pattern = /set(?:\s+(?:session|local))?\s+lock_timeout\s*(?:=|to\b)\s*[^\n;]*;?|reset\s+lock_timeout\s*;?/giy;
  // Sticky dollar-quote opener: matches the tag exactly at `i` without
  // copying the remaining suffix via content.slice(i) on every `$`.
  const tagPattern = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;
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
        tagPattern.lastIndex = i;
        const tag = tagPattern.exec(content)?.[0];
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

/**
 * Split a migration body into individual statements at top-level
 * semicolons. Quote- and comment-aware: semicolons inside dollar-quoted
 * function bodies, string literals, identifiers, or comments do not split.
 *
 * Required by the no-transaction runner mode: node-postgres sends a
 * parameterless multi-statement string in ONE simple-protocol Query, and
 * PostgreSQL runs that whole string inside an implicit transaction block —
 * so CREATE INDEX CONCURRENTLY still refuses even with no explicit BEGIN.
 * Executing each statement with its own query gives every statement its own
 * implicit transaction, which is what CONCURRENTLY needs. Empty fragments
 * (whitespace or comments between semicolons) are dropped.
 */
export function splitSqlStatements(content: string): string[] {
  const statements: string[] = [];
  let current = "";
  // A fragment that is only whitespace and comments is not a statement: the
  // runner must not send it as a query of its own. Anything else — including
  // a lone string literal, which is a real (if useless) statement — is kept.
  let hasCode = false;
  let i = 0;
  let state: "code" | "line" | "block" | "squote" | "dquote" = "code";
  let blockDepth = 0;
  let dollarTag: string | null = null;
  const n = content.length;
  // Sticky dollar-quote opener: matches the tag exactly at `i` without
  // copying the remaining suffix via content.slice(i) on every `$`.
  const tagPattern = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;
  const flush = (): void => {
    if (hasCode) statements.push(current);
    current = "";
    hasCode = false;
  };
  while (i < n) {
    if (dollarTag !== null) {
      hasCode = true;
      if (content.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        current += content[i];
        i += 1;
      }
      continue;
    }
    const ch = content[i];
    const next = content[i + 1];
    if (state === "code") {
      if (ch === "-" && next === "-") {
        state = "line";
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        blockDepth = 1;
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === "'") {
        hasCode = true;
        state = "squote";
        current += ch;
        i += 1;
        continue;
      }
      if (ch === '"') {
        hasCode = true;
        state = "dquote";
        current += ch;
        i += 1;
        continue;
      }
      if (ch === "$") {
        tagPattern.lastIndex = i;
        const tag = tagPattern.exec(content)?.[0];
        if (tag) {
          hasCode = true;
          dollarTag = tag;
          current += tag;
          i += tag.length;
          continue;
        }
        if (ch.trim().length > 0) hasCode = true;
        current += ch;
        i += 1;
        continue;
      }
      if (ch === ";") {
        current += ch;
        i += 1;
        flush();
        continue;
      }
      if (ch.trim().length > 0) hasCode = true;
      current += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      current += ch;
      i += 1;
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      current += ch;
      if (ch === "/" && next === "*") {
        blockDepth += 1;
        current += next;
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        current += next;
        i += 2;
        blockDepth -= 1;
        if (blockDepth === 0) state = "code";
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "squote") {
      current += ch;
      i += 1;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        state = "code";
      }
      continue;
    }
    current += ch;
    i += 1;
    if (ch === '"' && next === '"') {
      current += next;
      i += 1;
    } else if (ch === '"') {
      state = "code";
    }
  }
  flush();
  return statements;
}

/**
 * Execute one migration attempt on an already-connected migration client:
 * impose the bounded lock_timeout, run the body (one query per statement
 * outside a transaction, a single transactional query inside one), restore
 * the session defaults, and record the ledger row. Throws the raw driver
 * error so the caller can decide between a 55P03 retry and a loud deploy
 * failure. bootstrap.ts owns the retry loop (and the one special-case body
 * executor); this function owns the execution path so tests can drive the
 * real runner logic — including a genuine CREATE INDEX CONCURRENTLY file —
 * without importing bootstrap.ts, which runs main() on import.
 */
export type MigrationAttempt = {
  filename: string;
  /** Sanitized body (file-level lock_timeout already stripped). */
  body: string;
  transactional: boolean;
  lock: MigrationLockConfig;
  digest: string;
  recordedDigest?: string;
  executeBody: (client: pg.PoolClient, body: string) => Promise<void>;
};

/** The standard body executor: one transactional query, or one query per
 * statement outside a transaction (see splitSqlStatements for why the file
 * cannot go out as a single multi-statement string). */
export async function executeMigrationBody(
  client: pg.PoolClient,
  body: string,
  transactional: boolean,
): Promise<void> {
  if (transactional) {
    await client.query(body);
    return;
  }
  for (const statement of splitSqlStatements(body)) {
    await client.query(statement);
  }
}

export async function executeMigrationAttempt(
  client: pg.PoolClient,
  attempt: MigrationAttempt,
): Promise<void> {
  const { filename, body, transactional, lock, digest, recordedDigest, executeBody } = attempt;
  if (transactional) {
    await client.query("begin");
    await client.query(`SET LOCAL lock_timeout = ${lock.lockTimeoutMs}`);
  } else {
    await client.query(`SET lock_timeout = ${lock.lockTimeoutMs}`);
  }
  try {
    await executeBody(client, body);
    // pg_dump-style baselines intentionally clear search_path while creating
    // fully qualified objects. Restore the application default before this
    // pooled session is returned to callers that execute reviewed SQL files.
    await client.query("set search_path = public, pg_catalog");
    await client.query("set row_security = on");
    if (recordedDigest) {
      const updated = await client.query(
        `update public._applied_migrations
            set sha256 = $1, applied_at = now()
          where filename = $2 and sha256 = $3`,
        [digest, filename, recordedDigest],
      );
      if (updated.rowCount !== 1) {
        throw new Error("migration digest changed during approved revision");
      }
    } else {
      await client.query(
        "insert into public._applied_migrations (filename, sha256) values ($1, $2)",
        [filename, digest],
      );
    }
    if (transactional) {
      await client.query("commit");
    }
  } finally {
    if (!transactional) {
      // Our session-scope bound must not outlive this checkout. (The file
      // header's own session SETs leak into this timeout-free pool exactly
      // as every transactional migration's already do — no new hazard, and
      // the file can no longer touch lock_timeout itself.)
      await client.query("RESET lock_timeout").catch(() => {});
    }
  }
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
