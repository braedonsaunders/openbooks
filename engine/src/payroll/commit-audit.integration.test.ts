import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { commitPayRun } from "./run.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";
import { dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Committing a pay run authorizes pay: it must leave the same evidence as
 * every other material writer — an audit_log row naming the actor and the
 * before/after of the run it committed (status + pinned calculation digest),
 * not just the rewritten stubs and lines.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

test("committing a pay run evidences the authorization in audit_log", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const { input } = await calculatedRun(fx);
    const result = await commitPayRun(input);
    assert.ok(result.lines > 0, "the fixture run commits real legs");

    const rows = (
      await db.execute<{
        action: string;
        actor_id: string | null;
        changes: Record<string, unknown>;
      }>(sql`
        select action, actor_id, changes from audit_log
         where org_id = ${fx.orgId} and table_name = 'pay_runs' and row_id = ${input.documentId}
         order by at, id
      `)
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.action, "update");
    assert.equal(rows[0]!.actor_id, fx.actorId);
    const changes = rows[0]!.changes as {
      operation: string;
      before: { run_status: string };
      after: { run_status: string };
    };
    assert.equal(changes.operation, "commit");
    assert.equal(changes.before.run_status, "calculated");
    assert.equal(changes.after.run_status, "committed");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
