/**
 * Teardown catalog assertions for migration replay tests.
 *
 * A migration test that downgrades a guard and replays the staged bytes
 * must leave the shared database exactly as it found it: a refusal path
 * that raises before rebuilding the guard otherwise poisons every later
 * file in the same process order (the 0299 refusal test dropped its CHECK
 * and engine's stock-count-nonnegative suite failed after it). Every such
 * test snapshots the touched table before the downgrade and asserts the
 * snapshot still matches in teardown — a mismatch fails loudly, never
 * passes silently.
 *
 * The snapshot covers constraint definitions plus their validated flag,
 * index definitions plus validity, and column types/nullability/defaults:
 * everything a downgrade/replay cycle can change on the table. Data rows
 * are out of scope (scratch orgs own their rows and drop them).
 */
import assert from "node:assert/strict";

/** Any query surface returning rows: a pg client or an adapter over drizzle. */
export type CatalogQuery = (text: string) => Promise<Array<Record<string, unknown>>>;

export type TableCatalogSnapshot = {
  table: string;
  constraints: Array<{ name: string; definition: string; validated: boolean }>;
  indexes: Array<{ name: string; definition: string; valid: boolean; ready: boolean }>;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    hasDefault: boolean;
    default: string | null;
  }>;
};

function canonical(value: unknown): string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  return String(value);
}

function snapshotRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, string | boolean | null>> {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, canonical(value)])),
  );
}

export async function snapshotTableCatalog(
  query: CatalogQuery,
  table: string,
): Promise<TableCatalogSnapshot> {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`snapshotTableCatalog refuses a non-qualified table name: ${table}`);
  }
  const constraints = snapshotRows(
    await query(
      `select conname as name, pg_get_constraintdef(oid) as definition,
              convalidated as validated
         from pg_constraint
        where conrelid = '${table}'::regclass
        order by conname`,
    ),
  );
  const indexes = snapshotRows(
    await query(
      `select c.relname as name, pg_get_indexdef(i.indexrelid) as definition,
              i.indisvalid as valid, i.indisready as ready
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where i.indrelid = '${table}'::regclass
        order by c.relname`,
    ),
  );
  const columns = snapshotRows(
    await query(
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
              not a.attnotnull as nullable, a.atthasdef as "hasDefault",
              pg_get_expr(d.adbin, d.adrelid) as default
         from pg_attribute a
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname || '.' || c.relname = '${table}'
          and a.attnum > 0 and not a.attisdropped
        order by a.attnum`,
    ),
  );
  return {
    table,
    constraints: constraints as unknown as TableCatalogSnapshot["constraints"],
    indexes: indexes as unknown as TableCatalogSnapshot["indexes"],
    columns: columns as unknown as TableCatalogSnapshot["columns"],
  };
}

function describeDiff(
  kind: string,
  name: string,
  detail: string,
): string {
  return `${kind} ${name}: ${detail}`;
}

/** Human-readable differences between the pre-test snapshot and now. */
export function diffTableCatalog(
  expected: TableCatalogSnapshot,
  actual: TableCatalogSnapshot,
): string[] {
  const diffs: string[] = [];
  const byName = <T extends { name: string }>(rows: T[]): Map<string, T> =>
    new Map(rows.map((row) => [row.name, row]));
  const expectedConstraints = byName(expected.constraints);
  const actualConstraints = byName(actual.constraints);
  for (const [name, want] of expectedConstraints) {
    const got = actualConstraints.get(name);
    if (!got) {
      diffs.push(describeDiff("constraint", name, "present before the test, missing now"));
      continue;
    }
    if (got.definition !== want.definition || got.validated !== want.validated) {
      diffs.push(
        describeDiff(
          "constraint",
          name,
          `was ${JSON.stringify(want)} now ${JSON.stringify(got)}`,
        ),
      );
    }
  }
  for (const name of actualConstraints.keys()) {
    if (!expectedConstraints.has(name)) {
      diffs.push(describeDiff("constraint", name, "absent before the test, present now"));
    }
  }
  const expectedIndexes = byName(expected.indexes);
  const actualIndexes = byName(actual.indexes);
  for (const [name, want] of expectedIndexes) {
    const got = actualIndexes.get(name);
    if (!got) {
      diffs.push(describeDiff("index", name, "present before the test, missing now"));
      continue;
    }
    if (got.definition !== want.definition || got.valid !== want.valid || got.ready !== want.ready) {
      diffs.push(
        describeDiff("index", name, `was ${JSON.stringify(want)} now ${JSON.stringify(got)}`),
      );
    }
  }
  for (const name of actualIndexes.keys()) {
    if (!expectedIndexes.has(name)) {
      diffs.push(describeDiff("index", name, "absent before the test, present now"));
    }
  }
  const expectedColumns = byName(expected.columns);
  const actualColumns = byName(actual.columns);
  for (const [name, want] of expectedColumns) {
    const got = actualColumns.get(name);
    if (!got) {
      diffs.push(describeDiff("column", name, "present before the test, missing now"));
      continue;
    }
    if (
      got.type !== want.type
      || got.nullable !== want.nullable
      || got.hasDefault !== want.hasDefault
      || got.default !== want.default
    ) {
      diffs.push(
        describeDiff("column", name, `was ${JSON.stringify(want)} now ${JSON.stringify(got)}`),
      );
    }
  }
  for (const name of actualColumns.keys()) {
    if (!expectedColumns.has(name)) {
      diffs.push(describeDiff("column", name, "absent before the test, present now"));
    }
  }
  return diffs;
}

/**
 * Fail loudly when the table's catalog drifted from the pre-test snapshot.
 * The message names the table and every difference: a teardown mismatch is
 * a polluted shared database, and the next file in the process order pays
 * for it, so silence is not an option.
 */
export async function assertTableCatalogMatches(
  query: CatalogQuery,
  expected: TableCatalogSnapshot,
  context: string,
): Promise<void> {
  const actual = await snapshotTableCatalog(query, expected.table);
  const diffs = diffTableCatalog(expected, actual);
  assert.equal(
    diffs.length,
    0,
    `${context}: ${expected.table} catalog drifted from its pre-test snapshot:\n- ${diffs.join("\n- ")}`,
  );
}

/** Minimal transaction surface for the rollback wrapper below. */
export type RollbackClient = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

/**
 * Run downgrade/plant/replay work on one client inside a transaction that
 * always rolls back, so a migration replay test cannot leave the shared
 * catalog behind whatever the test asserts. Only for transactional bodies:
 * a no-transaction (CONCURRENTLY) file commits statement by statement, so
 * those tests restore by replaying the idempotent staged body in teardown
 * and asserting the snapshot instead.
 */
export async function withCatalogRollback<T>(
  client: RollbackClient,
  work: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    const result = await work();
    await client.query("rollback");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
