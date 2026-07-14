import { pool } from "./db.ts";

/**
 * The query surface is REAL PostgreSQL — no invented dialect. What NetSuite
 * calls SuiteQL, openbooks calls... SQL. Safety comes from the database,
 * not a parser:
 *   - runs as `openbooks_read` (SELECT-only role, no login)
 *   - inside a READ ONLY transaction (DML/DDL refused by Postgres itself)
 *   - SET LOCAL statement_timeout + row cap via wrapper
 * The single-statement/SELECT prefix check is defense-in-depth UX, not the
 * security boundary.
 */

export interface UserSqlOptions {
  maxRows?: number;
  timeoutMs?: number;
}

export interface UserSqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

const FORBIDDEN_PREFIX = /^\s*(insert|update|delete|create|alter|drop|grant|revoke|truncate|copy|vacuum|set|call|do)\b/i;

export async function runUserSql(sqlText: string, opts: UserSqlOptions = {}): Promise<UserSqlResult> {
  const maxRows = Math.min(opts.maxRows ?? 1_000, 50_000);
  const timeoutMs = Math.min(opts.timeoutMs ?? 5_000, 60_000);

  const stripped = sqlText.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!stripped) throw new Error("empty query");
  if (stripped.replace(/;\s*$/, "").includes(";")) throw new Error("one statement per query");
  if (FORBIDDEN_PREFIX.test(stripped)) throw new Error("read-only: queries must be SELECT (or WITH … SELECT)");
  if (!/^\s*(select|with)\b/i.test(stripped)) throw new Error("queries must start with SELECT or WITH");

  const body = stripped.replace(/;\s*$/, "");
  const wrapped = `select * from (${body}) __q limit ${maxRows + 1}`;

  const client = await pool.connect();
  const started = Date.now();
  try {
    await client.query("begin transaction read only");
    await client.query("set local role openbooks_read");
    await client.query(`set local statement_timeout = ${timeoutMs}`);
    const res = await client.query(wrapped);
    await client.query("rollback");
    const truncated = res.rows.length > maxRows;
    const rows = truncated ? res.rows.slice(0, maxRows) : res.rows;
    return {
      columns: res.fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** One-time: create the SELECT-only role. Idempotent. */
export async function ensureReadRole(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
          create role openbooks_read nologin;
        end if;
      end $$;
      grant usage on schema public to openbooks_read;
      grant select on all tables in schema public to openbooks_read;
      alter default privileges in schema public grant select on tables to openbooks_read;
      grant openbooks_read to current_user;
    `);
  } finally {
    client.release();
  }
}
