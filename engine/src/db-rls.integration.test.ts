import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { withBypass } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const RUNTIME_DB = process.env.OPENBOOKS_RUNTIME_DB_URL;

test("database access without an explicit organization context fails closed", { skip: !DB || !RUNTIME_DB }, async () => {
  const first = await withBypass(() => createScratchOrg());
  const second = await withBypass(() => createScratchOrg());
  const client = new pg.Client({ connectionString: RUNTIME_DB });
  try {
    await client.connect();
    await client.query(
      "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'off', false)",
    );
    const unscoped = await client.query<{ id: string }>(
      "select id from orgs where id = any($1::uuid[])",
      [[first.orgId, second.orgId]],
    );
    assert.deepEqual(unscoped.rows, []);

    await client.query(
      "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)",
      [first.orgId],
    );
    const firstScoped = await client.query<{ id: string }>(
      "select id from orgs where id = any($1::uuid[])",
      [[first.orgId, second.orgId]],
    );
    assert.deepEqual(firstScoped.rows, [{ id: first.orgId }]);

    await client.query(
      "select set_config('app.current_org', '', false), set_config('app.bypass_rls', 'on', false)",
    );
    const explicitlyPrivileged = await client.query<{ id: string }>(
      "select id from orgs where id = any($1::uuid[]) order by id",
      [[first.orgId, second.orgId]],
    );
    assert.deepEqual(
      explicitlyPrivileged.rows.map((row) => row.id),
      [first.orgId, second.orgId].sort(),
    );
  } finally {
    await client.end().catch(() => {});
    await withBypass(() => dropScratchOrg(second.orgId));
    await withBypass(() => dropScratchOrg(first.orgId));
  }
});
