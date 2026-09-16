import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { approveChangeSet, reviewChangeSet } from "./promote.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../test-fixtures.ts";

/**
 * Change-set review and approval are the four-eyes authorization for
 * promoting sandbox work into production: each transition must leave an
 * audit_log row naming its actor with the before/after status, not just the
 * reviewed_by/approved_by columns. (Per-row apply evidence already exists;
 * these header transitions have none.)
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

test("change-set review and approval evidence their transitions in audit_log", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const changeSetId = randomUUID();
    await db.execute(sql`
      insert into change_sets
        (id, org_id, sandbox_org_id, name, status, capture_complete, item_count, created_by)
      values
        (${changeSetId}, ${org.orgId}, ${org.orgId}, 'Audit probe', 'draft', true, 0, ${actors.submitterId})
    `);

    await reviewChangeSet(changeSetId, actors.approver1Id);
    await approveChangeSet(changeSetId, actors.approver2Id);

    const status = (
      await db.execute<{ status: string }>(sql`
        select status from change_sets where id = ${changeSetId} and org_id = ${org.orgId}`)
    ).rows[0]!.status;
    assert.equal(status, "approved");

    const rows = (
      await db.execute<{
        action: string;
        actor_id: string | null;
        changes: Record<string, unknown>;
      }>(sql`
        select action, actor_id, changes from audit_log
         where org_id = ${org.orgId} and table_name = 'change_sets' and row_id = ${changeSetId}
         order by at, id
      `)
    ).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.action),
      ["update", "update"],
    );
    assert.deepEqual(
      rows.map((row) => row.actor_id),
      [actors.approver1Id, actors.approver2Id],
    );
    const [reviewed, approved] = rows.map((row) => row.changes as {
      operation: string;
      before: { status: string };
      after: { status: string };
    });
    assert.equal(reviewed!.operation, "review");
    assert.equal(reviewed!.before.status, "draft");
    assert.equal(reviewed!.after.status, "reviewed");
    assert.equal(approved!.operation, "approve");
    assert.equal(approved!.before.status, "reviewed");
    assert.equal(approved!.after.status, "approved");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
