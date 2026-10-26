import { pool } from "../platform/db.ts";

export function hasEphemeralDatabaseMarker(
  comment: string | null | undefined,
  expected: string | undefined,
): boolean {
  return Boolean(
    expected && expected.startsWith("openbooks-ci-ephemeral-") && comment === expected,
  );
}

// Cache marker verification by checked-out client; a pool may reuse sessions.
const verifiedFixtureClients = new WeakMap<object, string>();

export async function assertFixtureDatabase(): Promise<void> {
  if (!process.env.OPENBOOKS_DB_URL?.trim()) {
    throw new Error("scratch fixtures require OPENBOOKS_DB_URL");
  }
  if (process.env.OPENBOOKS_TEST_ALLOW_UNMARKED_DB === "1") return;

  const expected = process.env.OPENBOOKS_TEST_DB_MARKER;
  if (!expected) {
    throw new Error(
      "scratch fixtures require OPENBOOKS_TEST_DB_MARKER or explicit OPENBOOKS_TEST_ALLOW_UNMARKED_DB=1 opt-in",
    );
  }
  if (!expected.startsWith("openbooks-ci-ephemeral-")) {
    throw new Error("scratch fixtures require the canonical ephemeral database marker");
  }

  const client = await pool.connect();
  try {
    if (verifiedFixtureClients.get(client) === expected) return;
    const result = await client.query<{ marker: string | null }>(
      "select shobj_description(oid, 'pg_database') as marker from pg_database where datname = current_database()",
    );
    if (!hasEphemeralDatabaseMarker(result.rows[0]?.marker, expected)) {
      throw new Error(
        "scratch fixtures require the canonical ephemeral database marker; refusing shared/non-ephemeral database",
      );
    }
    verifiedFixtureClients.set(client, expected);
  } finally {
    client.release();
  }
}

export async function assertDedicatedFixtureDatabase(): Promise<void> {
  if (process.env.OPENBOOKS_TEST_DB_ISOLATED !== "1") {
    throw new Error(
      "scratch fixture pooling requires OPENBOOKS_TEST_DB_ISOLATED=1; refusing to mutate a shared database",
    );
  }
  await assertFixtureDatabase();
}
