import { connectGovernedReadClient } from "./db.ts";

/**
 * The query surface is real PostgreSQL, with no proprietary query dialect.
 * Safety comes from the database,
 * not a parser:
 *   - runs as `openbooks_read` (SELECT-only role, no login)
 *   - inside a READ ONLY transaction (DML/DDL refused by Postgres itself)
 *   - SET LOCAL statement_timeout + row cap via wrapper
 * The single-statement/SELECT prefix check is defense-in-depth UX, not the
 * security boundary.
 */

export interface UserSqlOptions {
  /** Organization whose forced-RLS policies must govern this query. */
  orgId: string;
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
const FORBIDDEN_BODY = /\b(?:pg_catalog\.)?set_config\s*\(/i;
const STRING_OR_DOLLAR_QUOTE = /'(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|\$(?:[A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$(?:[A-Za-z_][A-Za-z0-9_]*|)\$/g;

function stripSqlNoise(input: string): string {
  return input
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(STRING_OR_DOLLAR_QUOTE, " ");
}

export function validateUserSql(sqlText: string): string {
  const stripped = stripSqlNoise(sqlText).trim();
  if (!stripped) throw new Error("empty query");
  if (stripped.replace(/;\s*$/, "").includes(";")) throw new Error("one statement per query");
  if (FORBIDDEN_PREFIX.test(stripped)) throw new Error("read-only: queries must be SELECT (or WITH … SELECT)");
  if (FORBIDDEN_BODY.test(stripped)) {
    throw new Error("read-only: set_config() is not allowed in user SQL");
  }
  if (!/^\s*(select|with)\b/i.test(stripped)) throw new Error("queries must start with SELECT or WITH");
  return sqlText.trim().replace(/;\s*$/, "");
}

async function prepareQueryContext(client: import('pg').PoolClient, orgId: string): Promise<void> {
  // The tenant identity is connection-local and owned by the application role.
  // openbooks_read runs inside READ ONLY and has no privilege on this temp table;
  // governed views can read it only through openbooks_query_org_id().
  await client.query(`
    create temporary table if not exists openbooks_query_context (
      org_id uuid not null
    ) on commit preserve rows
  `);
  await client.query("truncate table pg_temp.openbooks_query_context");
  await client.query("insert into pg_temp.openbooks_query_context (org_id) values ($1)", [orgId]);
}

async function clearQueryContext(client: import('pg').PoolClient): Promise<void> {
  await client.query("truncate table pg_temp.openbooks_query_context");
}

async function beginGovernedReadTransaction(
  client: import('pg').PoolClient,
  orgId: string,
  timeoutMs: number,
): Promise<void> {
  await client.query("begin transaction read only");
  // The governed views deliberately narrow the reporting surface, but tenant
  // isolation still belongs to PostgreSQL RLS. Establish the same tenant GUCs
  // used by normal application requests before assuming the SELECT-only role;
  // this makes every underlying base-table policy independently enforce the
  // organization boundary. The temp-table context remains a second, immutable
  // predicate owned by the application connection.
  await client.query(
    "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
    [orgId],
  );
  await client.query("set local role openbooks_read");
  await client.query("set local search_path = openbooks_query, pg_catalog");
  await client.query(`set local statement_timeout = ${timeoutMs}`);
  // Governed views scope every table with `org_id = openbooks_query_org_id()`.
  // That function is STABLE, so its value is unknown at plan time and the
  // planner falls back to a default 0.5% selectivity: a 66-row accounts table
  // is estimated at one row, which makes a nested loop look free. The result
  // is a cross join — every row of the outer table rescanned per row of the
  // inner one (measured: 61s and 228M discarded rows for a trial balance that
  // hash-joins in 2s). Console sessions therefore plan without nested loops.
  // This is scoped to this READ ONLY ad-hoc transaction and never affects
  // application queries, which carry a literal org_id the planner can measure.
  await client.query("set local enable_nestloop = off");
}

export async function runUserSql(sqlText: string, opts: UserSqlOptions): Promise<UserSqlResult> {
  const maxRows = Math.min(opts.maxRows ?? 1_000, 50_000);
  const timeoutMs = Math.min(opts.timeoutMs ?? 5_000, 60_000);

  const body = validateUserSql(sqlText);
  const wrapped = `select * from (${body}) __q limit ${maxRows + 1}`;

  const client = await connectGovernedReadClient();
  const started = Date.now();
  try {
    await prepareQueryContext(client, opts.orgId);
    await beginGovernedReadTransaction(client, opts.orgId, timeoutMs);
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
    try {
      await clearQueryContext(client);
      client.release();
    } catch (error) {
      client.release(error as Error);
      throw error;
    }
  }
}

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
}

export interface SchemaTable {
  name: string;
  kind: "table" | "view";
  columns: SchemaColumn[];
}

/**
 * Introspect the tables/views the read-only role can SELECT, with their
 * columns. Runs under the SAME `openbooks_read` role as user queries and
 * inside a READ ONLY transaction, so it lists exactly what a user could
 * actually query — nothing they lack privileges on leaks through.
 */
export async function listSchema(orgId: string): Promise<SchemaTable[]> {
  const client = await connectGovernedReadClient();
  try {
    await prepareQueryContext(client, orgId);
    await beginGovernedReadTransaction(client, orgId, 10_000);
    const res = await client.query<{
      table_name: string;
      table_type: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      ordinal_position: number;
    }>(
      `select c.table_name,
              t.table_type,
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.ordinal_position
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema
          and t.table_name = c.table_name
        where c.table_schema = 'openbooks_query'
          and t.table_type = 'VIEW'
        order by c.table_name, c.ordinal_position`,
    );
    await client.query("rollback");

    const byTable = new Map<string, SchemaTable>();
    for (const row of res.rows) {
      let table = byTable.get(row.table_name);
      if (!table) {
        table = {
          name: row.table_name,
          kind: row.table_type === "VIEW" ? "view" : "table",
          columns: [],
        };
        byTable.set(row.table_name, table);
      }
      table.columns.push({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === "YES",
      });
    }
    return [...byTable.values()];
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    try {
      await clearQueryContext(client);
      client.release();
    } catch (error) {
      client.release(error as Error);
      throw error;
    }
  }
}

/**
 * Verify the NOLOGIN query role exists and is granted to the application
 * role. Bootstrap creates/grants the role; the governed catalog migration is
 * the only place that grants it SELECT privileges.
 */
export async function ensureReadRole(): Promise<void> {
  const client = await connectGovernedReadClient();
  try {
    const r = await client.query(
      `select 1 from pg_roles r
        join pg_auth_members m on m.roleid = r.oid
        join pg_roles u on u.oid = m.member
       where r.rolname = 'openbooks_read' and u.rolname = current_user`,
    );
    if (r.rowCount === 0) {
      throw new Error("openbooks_read role missing or not granted — run the bootstrap grant as superuser");
    }
  } finally {
    client.release();
  }
}
